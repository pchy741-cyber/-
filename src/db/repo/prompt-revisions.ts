import { hasPromptInjection, MAX_PROMPT_TEXT } from '../../utils/prompt-guard.js';
import { getActiveStrategy, getPool, isMemoryMode, withTransaction } from '../client.js';

export type PromptTab = 'strategy' | 'risk' | 'analysis' | 'trading';
export type PromptRevisionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/**
 * 지시탭 → strategy_config 컬럼 매핑.
 *
 * 라이브 AI 주입: 4개 탭 모두 Track A 분석 프롬프트로 주입된다 (src/ai/track-a/pipeline.ts).
 *   analysis→gemini_prompt · strategy→strategy_document · risk→risk_prompt · trading→claude_prompt
 * → Track A 점수(라이브 매수 판단의 단일 AI 근거)에 반영되므로 승인 시 실전 매매 행동에 영향.
 */
const TAB_COLUMN: Record<PromptTab, string> = {
  strategy: 'strategy_document',
  risk: 'risk_prompt',
  analysis: 'gemini_prompt',
  trading: 'claude_prompt',
};

const TAB_LABEL: Record<PromptTab, string> = {
  strategy: '전략서',
  risk: '리스크',
  analysis: '분석 지시',
  trading: '매매 지시',
};

export interface PromptRevision {
  id: number;
  tab: PromptTab;
  old_text: string | null;
  new_text: string;
  reason: string | null;
  status: PromptRevisionStatus;
  proposed_by: string;
  created_at: string;
  resolved_at: string | null;
}

export function isValidTab(tab: string): tab is PromptTab {
  return tab === 'strategy' || tab === 'risk' || tab === 'analysis' || tab === 'trading';
}

export function tabLabel(tab: PromptTab): string {
  return TAB_LABEL[tab];
}

/** 현재 지시탭 전문 조회 (활성 전략 기준) */
export async function getTabText(tab: PromptTab): Promise<string> {
  const strategy = await getActiveStrategy();
  const val = (strategy as Record<string, unknown> | null)?.[TAB_COLUMN[tab]];
  return typeof val === 'string' ? val : '';
}

/** 탭별 미결(PENDING) 제안 조회 */
export async function getPendingByTab(tab: PromptTab): Promise<PromptRevision | null> {
  if (isMemoryMode()) return null;
  const { rows } = await getPool().query(
    `SELECT * FROM prompt_revisions WHERE tab = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
    [tab],
  );
  return (rows[0] as PromptRevision) ?? null;
}

/** 제안 저장 (PENDING) → id 반환 */
export async function insertProposal(p: {
  tab: PromptTab;
  old_text: string;
  new_text: string;
  reason: string;
}): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO prompt_revisions (tab, old_text, new_text, reason, status, proposed_by)
     VALUES ($1, $2, $3, $4, 'PENDING', 't8') RETURNING id`,
    [p.tab, p.old_text, p.new_text, p.reason],
  );
  return Number(rows[0].id);
}

/**
 * 승인 → status=APPROVED + 해당 탭 실전 반영 (활성 전략 paper/live 모두).
 * old_text는 revisions에 이미 보존되어 있으므로 롤백 근거로 남는다.
 */
export async function approveRevision(id: number): Promise<{ ok: boolean; message: string }> {
  if (isMemoryMode()) return { ok: false, message: '⚠️ 인메모리 모드 — 승인 불가 (DB 필요)' };
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM prompt_revisions WHERE id = $1 FOR UPDATE`, [id]);
    const rev = rows[0] as PromptRevision | undefined;
    if (!rev) return { ok: false, message: `❌ 제안 #${id} 없음` };
    if (rev.status !== 'PENDING') return { ok: false, message: `⚠️ 제안 #${id} 이미 처리됨 (${rev.status})` };
    if (!isValidTab(rev.tab)) return { ok: false, message: `❌ 제안 #${id} 잘못된 탭: ${rev.tab}` };

    // S6: 승인 시점 재검증 — propose 이후 DB 변조/인젝션 방지 (content TOCTOU)
    if (!rev.new_text || rev.new_text.length > MAX_PROMPT_TEXT || hasPromptInjection(rev.new_text)) {
      await client.query(`UPDATE prompt_revisions SET status = 'REJECTED', resolved_at = NOW() WHERE id = $1`, [id]);
      return { ok: false, message: `⛔ 제안 #${id} 재검증 실패(길이/인젝션 의심) → 자동 반려` };
    }

    // 컬럼명은 화이트리스트(TAB_COLUMN)에서만 온다 → SQL 인젝션 불가.
    const col = TAB_COLUMN[rev.tab];

    // I4: 낙관적 동시성 — propose 이후 CEO가 UI(PUT /strategy)로 해당 탭을 수정했으면
    // 현재값 ≠ old_text 이므로 덮어쓰기 금지(무언의 데이터 손실 방지). live 행 기준 비교.
    const { rows: curRows } = await client.query(
      `SELECT ${col} AS cur FROM strategy_config WHERE is_active = true ORDER BY is_paper ASC LIMIT 1`,
    );
    const current = typeof curRows[0]?.cur === 'string' ? curRows[0].cur : '';
    if (rev.old_text != null && current !== rev.old_text) {
      await client.query(`UPDATE prompt_revisions SET status = 'REJECTED', resolved_at = NOW() WHERE id = $1`, [id]);
      return {
        ok: false,
        message: `⚠️ 제안 #${id}: 대기 중 [${TAB_LABEL[rev.tab]}] 탭이 변경됨(CEO 편집 추정) → 자동 반려. 최신 기준으로 다시 제안하세요.`,
      };
    }

    // 활성 전략 전체(paper+live)에 반영 — 기존 PUT /api/strategy 프롬프트 동기화와 동일 방침.
    const { rowCount } = await client.query(
      `UPDATE strategy_config SET ${col} = $1, updated_at = NOW() WHERE is_active = true`,
      [rev.new_text],
    );
    // C1: 활성 전략 행이 0개면 거짓 성공 방지 — APPROVED로 넘기지 않고 PENDING 유지(재시도 가능)
    if (!rowCount || rowCount === 0) {
      return {
        ok: false,
        message: `⚠️ 제안 #${id} 반영 실패 — 활성 전략(strategy_config) 없음. PENDING 유지, 재시도 가능.`,
      };
    }
    await client.query(`UPDATE prompt_revisions SET status = 'APPROVED', resolved_at = NOW() WHERE id = $1`, [id]);
    return { ok: true, message: `✅ 제안 #${id} 승인 — [${TAB_LABEL[rev.tab]}] ${rowCount}개 전략 반영 완료` };
  });
}

/** 반려 → status=REJECTED */
export async function rejectRevision(id: number): Promise<{ ok: boolean; message: string }> {
  if (isMemoryMode()) return { ok: false, message: '⚠️ 인메모리 모드 — 반려 불가' };
  const { rows } = await getPool().query(
    `UPDATE prompt_revisions SET status = 'REJECTED', resolved_at = NOW()
     WHERE id = $1 AND status = 'PENDING' RETURNING tab`,
    [id],
  );
  if (rows.length === 0) return { ok: false, message: `⚠️ 제안 #${id} 없음 또는 이미 처리됨` };
  return { ok: true, message: `🚫 제안 #${id} 반려 완료` };
}

/** 7일 경과 PENDING → EXPIRED (일일 잡) → 만료 건수 반환 */
export async function expirePendingRevisions(): Promise<number> {
  if (isMemoryMode()) return 0;
  const { rowCount } = await getPool().query(
    `UPDATE prompt_revisions SET status = 'EXPIRED', resolved_at = NOW()
     WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL '7 days'`,
  );
  return rowCount ?? 0;
}
