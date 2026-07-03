/**
 * 캡쳐 자동 트리거 — 실제 구현은 shared/capture-trigger.ts로 이동
 * 하위호환을 위한 re-export + getCaptureHistory (API 전용 함수)
 */

import { logger } from '../../../utils/logger.js';

// ── 하위호환 re-export ──
export {
  type CaptureTrigger,
  type CaptureSnapshot,
  triggerCapture,
  shouldPush,
  formatTelegram,
} from '../../../shared/capture-trigger.js';

/** 최근 N개 캡쳐 스냅샷 조회 (히스토리 — API 전용) */
export async function getCaptureHistory(opts: {
  mode?: 'paper' | 'live';
  trigger?: string;
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
