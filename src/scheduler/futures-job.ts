/**
 * 선물 자동매매 스케줄러 잡
 * 기능 플래그: overseas_futures (OFF by default)
 * 스케줄: 미국 장중 10분 간격 (+5분 오프셋)
 *
 * v4: Paper 무한루프 — 10만원 자동 리셋 (잔액 소진 시 초기화)
 */

import { fetchExchangeRate } from '../automation/macro-data.js';
import { runWithMode } from '../config/context.js';
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { executeFuturesEntry, loadFuturesConfig, monitorFuturesTPSL } from './futures/auto-executor.js';
import { runFuturesTuner } from './futures/futures-tuner.js';

const COMP = 'FUTURES';
const PAPER_RESET_KRW = 100_000; // 10만원 무한루프 예산

/**
 * Paper 선물 자동 리셋 — 잔액(예산 + PnL) 소진 시 10만원 재투입
 * 오픈 포지션 모두 닫고 PnL/마진 초기화 → 깨끗한 10만원으로 재시작
 */
async function checkAndResetFuturesPaper(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM futures_budget WHERE id = 1');
  const b = rows[0];
  if (!b) return;

  const allocated = Number(b.allocated_krw_paper ?? 0);
  const pnlUsd = Number(b.total_pnl_usd_paper ?? 0);

  // 미배정 상태 → 최초 10만원 자동 세팅
  if (allocated <= 0) {
    await pool.query(
      `UPDATE futures_budget SET allocated_krw_paper = $1, total_pnl_usd_paper = 0, used_margin_usd_paper = 0 WHERE id = 1`,
      [PAPER_RESET_KRW],
    );
    logger.info(`[선물 Paper] 최초 10만원 자동 배정`, { component: COMP });
    await sendTelegramMessage(`🔄 선물 Paper 10만원 최초 배정`);
    return;
  }

  // 잔액 체크: 예산(KRW) + PnL(USD→KRW)
  const fxRate = await fetchExchangeRate().catch(() => 1400);
  const effectiveKrw = allocated + pnlUsd * fxRate;

  // 잔액이 1만원 미만이면 소진으로 판단 → 리셋
  if (effectiveKrw >= 10_000) return;

  // 오픈 포지션 강제 청산 (paper이므로 DB만 처리)
  const { rows: openPos } = await pool.query(
    `SELECT id, symbol, side, quantity FROM futures_positions WHERE status = 'open' AND is_paper = true`,
  );
  if (openPos.length > 0) {
    await pool.query(
      `UPDATE futures_positions SET status = 'closed', closed_at = NOW() WHERE status = 'open' AND is_paper = true`,
    );
    logger.info(`[선물 Paper 리셋] 오픈 포지션 ${openPos.length}건 강제 청산`, { component: COMP });
  }

  // 리셋 횟수 추적
  const resetCountKey = 'futures_paper_reset_count';
  await pool.query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, '1')
     ON CONFLICT (key) DO UPDATE SET value = (COALESCE(overseas_state.value::int, 0) + 1)::text`,
    [resetCountKey],
  );

  // 예산 리셋: 10만원 재투입, PnL/마진 초기화
  await pool.query(
    `UPDATE futures_budget SET allocated_krw_paper = $1, total_pnl_usd_paper = 0, used_margin_usd_paper = 0 WHERE id = 1`,
    [PAPER_RESET_KRW],
  );

  const { rows: cntRows } = await pool.query(`SELECT value FROM overseas_state WHERE key = $1`, [resetCountKey]);
  const resetCount = Number(cntRows[0]?.value ?? 1);

  logger.info(`[선물 Paper 리셋] ${resetCount}회째 10만원 재투입 (이전잔액: ₩${Math.floor(effectiveKrw)})`, {
    component: COMP,
  });
  await sendTelegramMessage(
    `🔄 *선물 Paper 자동 리셋* (${resetCount}회)\n잔액 ₩${Math.floor(effectiveKrw)} → ₩${PAPER_RESET_KRW.toLocaleString()} 재시작\n청산 포지션: ${openPos.length}건`,
  );
}

export async function runFuturesJob(): Promise<void> {
  // 주말 가드: 전 세계 시장 휴장 → 스킵
  const { isWeekendClosed } = await import('../utils/holidays.js');
  if (isWeekendClosed()) return;

  // Feature flag 체크: OFF면 Paper만 실행, Live 스킵
  const { rows: flagRows } = await getPool().query("SELECT enabled FROM feature_flags WHERE key = 'overseas_futures'");
  const futuresLiveEnabled = flagRows[0]?.enabled === true;

  logger.info('📈 선물 자동매매 시작', { component: COMP });

  // 매 실행마다 튜너 갱신 (30일 승률 기반 TP/SL/confidence 조정)
  await runWithMode(true, async () => {
    await runFuturesTuner();
  });
  if (futuresLiveEnabled) {
    await runWithMode(false, async () => {
      await runFuturesTuner();
    });
  }

  // v4: Paper 10만원 무한루프 — 잔액 소진 시 자동 리셋
  await checkAndResetFuturesPaper();

  // Paper: 항상 실행 (트랙레코드 축적)
  await runWithMode(true, async () => {
    try {
      const config = await loadFuturesConfig();
      if (config.allocatedKrw <= 0) return;
      await monitorFuturesTPSL();
      await executeFuturesEntry(config);
    } catch (e) {
      logger.error(`선물 paper 실패: ${e}`, { component: COMP });
    }
  });

  // Live: feature flag ON일 때만 실행
  if (futuresLiveEnabled) {
    await runWithMode(false, async () => {
      try {
        const config = await loadFuturesConfig();
        if (config.allocatedKrw <= 0) return;
        await monitorFuturesTPSL();
        await executeFuturesEntry(config);
      } catch (e) {
        logger.error(`선물 live 실패: ${e}`, { component: COMP });
      }
    });
  }

  logger.info('📈 선물 자동매매 완료', { component: COMP });
}
