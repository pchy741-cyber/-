/**
 * 캡쳐 자동 트리거 — 임계 이벤트 발생 시 Copilot 진단 → DB 저장 → Telegram 푸시
 *
 * 트리거 소스:
 *  - manual: /review/capture 호출 후 분석 단계
 *  - kill_switch: 킬스위치 발동
 *  - loop_paused: 루프가 자동 PAUSED 진입
 *  - mdd_danger: MDD가 위험 수준 도달
 *  - error_burst: 연속 에러 N회
 *  - scheduled: 정기 진단 (시간별)
 */

import { sendTelegramMessage } from '../../../notifications/telegram.js';
import { sendModeMessage } from '../../../notifications/mode-message.js';
import { logger } from '../../../utils/logger.js';
import { type CopilotAction, getCopilotLiteScore } from './copilot-lite.js';

const COMP = 'CAPTURE_TRIG';

export type CaptureTrigger = 'manual' | 'kill_switch' | 'loop_paused' | 'mdd_danger' | 'error_burst' | 'scheduled';

export interface CaptureSnapshot {
  id: number | null;
  mode: 'paper' | 'live';
  trigger: CaptureTrigger;
  score: number;
  issues: { id: string; level: string; label: string }[];
  actions: CopilotAction[];
  loopSessionId: number | null;
  capturedAt: string;
}

// 트리거별 텔레그램 푸시 쿨다운 (중복 알림 방지)
const _lastPushAt = new Map<string, number>();
const PUSH_COOLDOWN_MS = 15 * 60_000; // 15분

function shouldPush(trigger: CaptureTrigger, mode: string): boolean {
  if (trigger === 'manual') return false; // 수동은 알림 안 보냄 (이미 사용자가 봄)
  const key = `${trigger}:${mode}`;
  const last = _lastPushAt.get(key) ?? 0;
  if (Date.now() - last < PUSH_COOLDOWN_MS) return false;
  _lastPushAt.set(key, Date.now());
  return true;
}

function formatTelegram(snap: CaptureSnapshot): string {
  const triggerLabel: Record<CaptureTrigger, string> = {
    manual: '수동',
    kill_switch: '🛑 킬스위치',
    loop_paused: '⏸️ 루프 PAUSED',
    mdd_danger: '📉 MDD 위험',
    error_burst: '⚠️ 에러 폭주',
    scheduled: '⏰ 정기',
  };
  const modeLabel = snap.mode === 'paper' ? '연습' : '실전';
  const lines = [`📸 *캡쳐 진단* [${modeLabel}] (${triggerLabel[snap.trigger]})`, `점수: *${snap.score}/100*`, ''];
  if (snap.issues.length > 0) {
    lines.push('*위험:*');
    for (const it of snap.issues) {
      const emoji = it.level === 'danger' ? '🔴' : it.level === 'warn' ? '🟡' : '🟢';
      lines.push(`  ${emoji} ${it.label}`);
    }
    lines.push('');
  }
  if (snap.actions.length > 0) {
    lines.push('*권장 행동:*');
    for (const a of snap.actions.slice(0, 5)) {
      lines.push(`  → ${a.action}`);
    }
  }
  return lines.join('\n');
}

/**
 * 임계 이벤트로 진단 트리거
 * @param trigger 트리거 소스
 * @param mode paper/live
 * @param loopSessionId 발생 시점 루프 세션 ID (선택)
 */
export async function triggerCapture(
  trigger: CaptureTrigger,
  mode: 'paper' | 'live',
  loopSessionId: number | null = null,
): Promise<CaptureSnapshot> {
  const isPaper = mode === 'paper';
  const result = await getCopilotLiteScore(isPaper);
  const snap: CaptureSnapshot = {
    id: null,
    mode,
    trigger,
    score: result.score,
    issues: result.issues,
    actions: result.actions,
    loopSessionId,
    capturedAt: new Date().toISOString(),
  };

  // DB 영속화 (강화 #3)
  try {
    const { getPool } = await import('../../../db/client.js');
    const { rows } = await getPool().query(
      `INSERT INTO capture_snapshots (mode, trigger, score, issues, actions, loop_session_id, telegram_sent)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING id`,
      [
        mode,
        trigger,
        result.score,
        JSON.stringify(result.issues),
        JSON.stringify(result.actions),
        loopSessionId,
        false,
      ],
    );
    snap.id = rows[0]?.id ?? null;
  } catch (e) {
    logger.warn(`capture_snapshots INSERT 실패: ${(e as Error).message}`, { component: COMP });
  }

  // Telegram 푸시 (쿨다운 적용)
  if (shouldPush(trigger, mode)) {
    try {
      await sendModeMessage(snap.mode, formatTelegram(snap));
      if (snap.id) {
        const { getPool } = await import('../../../db/client.js');
        await getPool()
          .query('UPDATE capture_snapshots SET telegram_sent = true WHERE id = $1', [snap.id])
          .catch(() => {});
      }
    } catch (e) {
      logger.warn(`Telegram 푸시 실패: ${(e as Error).message}`, { component: COMP });
    }
  }

  logger.info(
    `📸 캡쳐 진단 [${trigger}/${mode}]: score=${snap.score} issues=${snap.issues.length} actions=${snap.actions.length}`,
    { component: COMP },
  );
  return snap;
}

/** 최근 N개 캡쳐 스냅샷 조회 (히스토리 — 강화 #3) */
export async function getCaptureHistory(opts: {
  mode?: 'paper' | 'live';
  trigger?: CaptureTrigger;
  limit?: number;
}): Promise<unknown[]> {
  try {
    const { getPool } = await import('../../../db/client.js');
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (opts.mode) {
      params.push(opts.mode);
      wheres.push(`mode = $${params.length}`);
    }
    if (opts.trigger) {
      params.push(opts.trigger);
      wheres.push(`trigger = $${params.length}`);
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await getPool().query(
      `SELECT id, captured_at, mode, trigger, score, issues, actions, loop_session_id, telegram_sent
       FROM capture_snapshots ${whereSql}
       ORDER BY captured_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      capturedAt: r.captured_at,
      mode: r.mode,
      trigger: r.trigger,
      score: Number(r.score),
      issues: r.issues ?? [],
      actions: r.actions ?? [],
      loopSessionId: r.loop_session_id,
      telegramSent: r.telegram_sent,
    }));
  } catch {
    return [];
  }
}
