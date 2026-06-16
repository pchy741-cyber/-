/**
 * 경량 헬스 엔드포인트 — 스크린샷 없이 DB 쿼리만으로 건강도 점수 반환 (~200ms)
 * GET /review/copilot-lite?viewMode=paper|live
 */
import { Hono } from 'hono';
import { getKSTNow } from '../../../utils/time.js';

const app = new Hono();

// ── 캡쳐 강화 #1: issues → ACTIONS 자동 추천 ──
export interface CopilotAction {
  id: string;
  level: 'info' | 'warn' | 'danger';
  action: string; // 권장 행동 (사람이 읽을 수 있는 문장)
  target?: string; // 대상 (체인 ID, 종목코드 등)
  apiHint?: string; // 호출 가능한 API 힌트
}

export function deriveActions(
  issues: { id: string; level: string; label: string }[],
  viewIsPaper: boolean,
): CopilotAction[] {
  const actions: CopilotAction[] = [];
  const mode = viewIsPaper ? 'paper' : 'live';
  for (const it of issues) {
    if (it.id === 'mdd' && it.level === 'danger') {
      actions.push({
        id: `mdd_block_buys`,
        level: 'danger',
        action: `[${mode}] 월간 MDD 임계 초과 — 신규 매수 24h 자동 차단 권장`,
        apiHint: `POST /api/ai-loop/command {"category":"buy_threshold","value":99,"ttl":86400}`,
      });
      actions.push({
        id: `mdd_reduce_position`,
        level: 'warn',
        action: `손실 큰 체인 우선 정리 검토 (큰 평가손 → 손절)`,
      });
    }
    if (it.id === 'loss_streak') {
      const streak = Number((it.label.match(/(\d+)/) ?? [])[1] ?? 3);
      const cdMin = Math.min(120, 30 + streak * 15);
      actions.push({
        id: `loss_streak_cooldown`,
        level: it.level as 'warn' | 'danger',
        action: `${streak}연속 손실 — 쿨다운 ${cdMin}분 자동 연장 권장`,
        apiHint: `POST /api/ai-loop/command {"category":"cooldown_min","value":${cdMin}}`,
      });
    }
    if (it.id === 'kill_switch') {
      actions.push({
        id: `kill_switch_pause`,
        level: 'danger',
        action: `Kill Switch 활성 — 모든 신규 매수 정지 + 보유 손절선만 모니터`,
      });
    }
    if (it.id === 'old_holdings') {
      const cnt = Number((it.label.match(/(\d+)/) ?? [])[1] ?? 0);
      actions.push({
        id: `old_holdings_review`,
        level: 'warn',
        action: `${cnt}종목 21일+ 보유 — 회수 검토 (성과 미달 시 청산)`,
        apiHint: `GET /api/overseas/dashboard 로 보유종목 확인 후 수동 매도`,
      });
    }
  }
  return actions;
}

app.get('/review/copilot-lite', async (c) => {
  try {
    const { getPool } = await import('../../../db/client.js');
    const { resolveRequestMode } = await import('../../guards/live-pin.js');
    const pool = getPool();

    const viewIsPaper = resolveRequestMode(c);

    let score = 100;
    const issues: { id: string; level: 'warn' | 'danger'; label: string }[] = [];

    // 1. 월간 MDD
    try {
      const monthStart = getKSTNow();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const { rows } = await pool.query(
        `SELECT total_value FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2 ORDER BY snapshot_at ASC`,
        [monthStart.toISOString(), viewIsPaper],
      );
      if (rows.length >= 2) {
        const values = rows.map((r: any) => Number(r.total_value));
        const peak = Math.max(...values);
        const latest = values[values.length - 1];
        const mddPct = peak > 0 ? ((peak - latest) / peak) * 100 : 0;
        const limit = viewIsPaper ? 40 : 8;
        if (mddPct >= limit) {
          score -= 25;
          issues.push({ id: 'mdd', level: 'danger', label: `MDD ${mddPct.toFixed(1)}%` });
        } else if (mddPct >= limit * 0.75) {
          score -= 10;
          issues.push({ id: 'mdd', level: 'warn', label: `MDD ${mddPct.toFixed(1)}%` });
        }
      }
    } catch {}

    // 2. 연속 손실
    try {
      const { rows } = await pool.query(
        `SELECT realized_pnl FROM transaction_chains WHERE status = 'CLOSED' AND is_paper = $1 ORDER BY closed_at DESC LIMIT 10`,
        [viewIsPaper],
      );
      let streak = 0;
      for (const r of rows) {
        if (Number(r.realized_pnl) < 0) streak++;
        else break;
      }
      if (streak >= 5) {
        score -= 20;
        issues.push({ id: 'loss_streak', level: 'danger', label: `${streak}연속 손실` });
      } else if (streak >= 3) {
        score -= 10;
        issues.push({ id: 'loss_streak', level: 'warn', label: `${streak}연속 손실` });
      }
    } catch {}

    // 3. Kill Switch
    try {
      const { getKillSwitchStatusAll } = await import('../../../risk/kill-switch.js');
      const ks = getKillSwitchStatusAll();
      if ((ks as any).overseas?.active) {
        score -= 20;
        issues.push({ id: 'kill_switch', level: 'danger', label: 'Kill Switch 활성' });
      }
    } catch {}

    // 4. 21일 초과 보유
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1 AND bought_at < NOW() - INTERVAL '21 days'`,
        [viewIsPaper],
      );
      const cnt = Number(rows[0]?.cnt ?? 0);
      if (cnt > 0) {
        score -= 7 * cnt;
        issues.push({ id: 'old_holdings', level: 'warn', label: `${cnt}종목 21일+ 보유` });
      }
    } catch {}

    const finalScore = Math.max(0, Math.min(100, score));
    const actions = deriveActions(issues, viewIsPaper);
    return c.json({
      score: finalScore,
      issues,
      actions,
      timestamp: new Date().toISOString(),
      mode: viewIsPaper ? 'paper' : 'live',
    });
  } catch (err: any) {
    return c.json({ score: 0, issues: [], actions: [], error: err.message }, 500);
  }
});

export default app;

/** 서버 내부 직접 호출용 — SSE 등에서 사용 */
export async function getCopilotLiteScore(
  viewIsPaper: boolean,
): Promise<{ score: number; issues: { id: string; level: string; label: string }[]; actions: CopilotAction[] }> {
  try {
    const { getPool } = await import('../../../db/client.js');
    const pool = getPool();
    let score = 100;
    const issues: { id: string; level: string; label: string }[] = [];

    // MDD
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { rows: snapRows } = await pool.query(
      `SELECT total_value FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2 ORDER BY snapshot_at ASC`,
      [monthStart.toISOString(), viewIsPaper],
    );
    if (snapRows.length >= 2) {
      const values = snapRows.map((r: any) => Number(r.total_value));
      const peak = Math.max(...values);
      const latest = values[values.length - 1];
      const mddPct = peak > 0 ? ((peak - latest) / peak) * 100 : 0;
      const limit = viewIsPaper ? 40 : 8;
      if (mddPct >= limit) {
        score -= 25;
        issues.push({ id: 'mdd', level: 'danger', label: `MDD ${mddPct.toFixed(1)}%` });
      } else if (mddPct >= limit * 0.75) {
        score -= 10;
        issues.push({ id: 'mdd', level: 'warn', label: `MDD ${mddPct.toFixed(1)}%` });
      }
    }

    // Kill Switch
    const { getKillSwitchStatusAll } = await import('../../../risk/kill-switch.js');
    const ks = getKillSwitchStatusAll();
    if ((ks as any).overseas?.active) {
      score -= 20;
      issues.push({ id: 'kill_switch', level: 'danger', label: 'Kill Switch 활성' });
    }

    const finalScore = Math.max(0, Math.min(100, score));
    return { score: finalScore, issues, actions: deriveActions(issues, viewIsPaper) };
  } catch {
    return { score: 0, issues: [], actions: [] };
  }
}
