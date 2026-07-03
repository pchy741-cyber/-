/**
 * 캡쳐 트리거 타입/인터페이스 + 핵심 함수 — api/routes/review/capture-trigger.ts에서 추출
 * scheduler/automation 등 비-API 레이어에서 교차오염 없이 import 가능
 */

import { sendModeMessage } from '../notifications/mode-message.js';
import { logger } from '../utils/logger.js';
import { type CopilotAction, getCopilotLiteScore } from '../api/routes/review/copilot-lite.js';

const COMP = 'CAPTURE_TRIG';

export type CaptureTrigger =
  | 'manual'
  | 'kill_switch'
  | 'kill_switch_overseas'
  | 'loop_paused'
  | 'mdd_danger'
  | 'error_burst'
  | 'consecutive_errors_2'
  | 'strategy_regen'
  | 'session_end'
  | 'scheduled';

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

const _lastPushAt = new Map<string, number>();
const PUSH_COOLDOWN_MS = 15 * 60_000;

export function shouldPush(trigger: CaptureTrigger, mode: string): boolean {
  if (trigger === 'manual') return false;
  const key = `${trigger}:${mode}`;
  const last = _lastPushAt.get(key) ?? 0;
  if (Date.now() - last < PUSH_COOLDOWN_MS) return false;
  _lastPushAt.set(key, Date.now());
  return true;
}

export function formatTelegram(snap: CaptureSnapshot): string {
  const triggerLabel: Record<CaptureTrigger, string> = {
    manual: '수동',
    kill_switch: '🛑 킬스위치',
    kill_switch_overseas: '🛑 해외 킬스위치',
    loop_paused: '⏸️ 루프 PAUSED',
    mdd_danger: '📉 MDD 위험',
    error_burst: '⚠️ 에러 폭주',
    consecutive_errors_2: '⚠️ 연속 에러',
    strategy_regen: '🔄 전략 재생성',
    session_end: '🏁 세션 종료',
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

  try {
    const { getPool } = await import('../db/client.js');
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

  if (shouldPush(trigger, mode)) {
    try {
      await sendModeMessage(snap.mode, formatTelegram(snap));
      if (snap.id) {
        const { getPool } = await import('../db/client.js');
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
