/**
 * 💀 MDD 자동 가드 — 월간 MDD 임계 초과 시 신규 매수 자동 차단/해제
 *
 * 동작:
 *  - 매시간 portfolio_snapshots에서 월간 MDD 계산
 *  - Live: 8% 초과 시 ai_overrides에 minBuyScore=99 (TTL 6h) 자동 삽입 → 신규매수 차단
 *  - Paper: 40% 초과 시 동일 차단 (Paper는 모험 허용이지만 극단은 차단)
 *  - MDD가 임계의 75% 미만으로 회복 시 → 차단 해제
 *  - 차단/해제 시 Telegram 알림 + capture-trigger 호출
 *
 * 캡쳐 강화 #1의 ACTIONS 추천을 시스템이 자동으로 실행하는 모듈
 */

import { getOverride, removeOverride, setOverride } from '../ai/ai-overrides.js';
import { runWithMode } from '../config/context.js';
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const COMP = 'MDD_GUARD';
const BLOCK_TTL_MINUTES = 6 * 60; // 6시간 (재진단 후 자동 갱신/해제)
const GUARD_REASON_PREFIX = 'mdd_guard:';

/** 월간 MDD 계산 (peak → latest 낙폭 %) */
async function computeMonthlyMdd(isPaper: boolean): Promise<number> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { rows } = await getPool().query(
    `SELECT total_value FROM portfolio_snapshots
     WHERE snapshot_at >= $1 AND is_paper = $2
     ORDER BY snapshot_at ASC`,
    [monthStart.toISOString(), isPaper],
  );
  if (rows.length < 2) return 0;
  const values = rows.map((r: any) => Number(r.total_value)).filter((v) => v > 0);
  if (values.length < 2) return 0;
  const peak = Math.max(...values);
  const latest = values[values.length - 1];
  return peak > 0 ? ((peak - latest) / peak) * 100 : 0;
}

async function runForMode(isPaper: boolean): Promise<void> {
  const mode = isPaper ? 'paper' : 'live';
  const limit = isPaper ? 40 : 8;
  const recoverAt = limit * 0.75; // 회복 임계 (Live 6%, Paper 30%)

  let mdd = 0;
  try {
    mdd = await computeMonthlyMdd(isPaper);
  } catch (e) {
    logger.warn(`MDD 계산 실패 [${mode}]: ${(e as Error).message}`, { component: COMP });
    return;
  }

  // 현재 가드 상태 (ai_overrides에 mdd_guard 표식 있는지)
  const currentOverride = getOverride<number>('minBuyScore', isPaper);
  const isGuardActive = currentOverride !== undefined && currentOverride !== null && currentOverride >= 95;
  // 가드 메타 확인 (reason으로 식별)
  const { rows: metaRows } = await getPool()
    .query(
      `SELECT reason FROM ai_overrides
       WHERE key = $1 AND is_paper = $2 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 1`,
      ['minBuyScore', isPaper],
    )
    .catch(() => ({ rows: [] as Array<{ reason: string }> }));
  const isOurGuard = (metaRows[0]?.reason ?? '').startsWith(GUARD_REASON_PREFIX);

  // ── 차단 발동 ──
  if (mdd >= limit && !isGuardActive) {
    await setOverride(
      'threshold',
      'minBuyScore',
      95, // 95 = 사실상 모든 매수 차단 (실제 점수는 99 캡)
      `${GUARD_REASON_PREFIX}MDD ${mdd.toFixed(1)}% >= 임계 ${limit}%`,
      BLOCK_TTL_MINUTES,
      isPaper,
    );
    logger.warn(
      `🚫 MDD 가드 발동 [${mode}]: MDD ${mdd.toFixed(1)}% >= ${limit}% — minBuyScore=99 (TTL ${BLOCK_TTL_MINUTES / 60}h)`,
      { component: COMP },
    );
    sendTelegramMessage(
      `🚫 *MDD 가드 자동 발동* [${mode === 'paper' ? '연습' : '실전'}]\n` +
        `MDD ${mdd.toFixed(1)}% (임계 ${limit}%)\n` +
        `신규 매수 ${BLOCK_TTL_MINUTES / 60}h 자동 차단\n` +
        `회복 임계 ${recoverAt.toFixed(1)}% 미만이면 자동 해제`,
    ).catch(() => {});
    // 캡쳐 트리거
    import('../api/routes/review/capture-trigger.js')
      .then((m) => m.triggerCapture('mdd_danger', mode as 'paper' | 'live').catch(() => {}))
      .catch(() => {});
    return;
  }

  // ── 차단 해제 ──
  if (isGuardActive && isOurGuard && mdd < recoverAt) {
    await removeOverride('minBuyScore', isPaper);
    logger.info(`🟢 MDD 가드 해제 [${mode}]: MDD ${mdd.toFixed(1)}% < 회복 임계 ${recoverAt.toFixed(1)}% — 매수 재개`, {
      component: COMP,
    });
    sendTelegramMessage(
      `🟢 *MDD 가드 자동 해제* [${mode === 'paper' ? '연습' : '실전'}]\n` +
        `MDD ${mdd.toFixed(1)}% < 회복 임계 ${recoverAt.toFixed(1)}%\n` +
        `신규 매수 재개`,
    ).catch(() => {});
    return;
  }

  // 정상 상태 로그 (debug)
  logger.debug(`MDD 가드 [${mode}]: MDD ${mdd.toFixed(1)}% / 임계 ${limit}% / 회복 ${recoverAt.toFixed(1)}%`, {
    component: COMP,
  });
}

/** paper + live 모두 체크 (시간별 cron에서 호출) */
export async function runMddGuard(): Promise<void> {
  await Promise.all([
    runWithMode(false, () => runForMode(false)).catch((e) =>
      logger.error(`MDD 가드 live 실패: ${e}`, { component: COMP }),
    ),
    runWithMode(true, () => runForMode(true)).catch((e) =>
      logger.error(`MDD 가드 paper 실패: ${e}`, { component: COMP }),
    ),
  ]);
}
