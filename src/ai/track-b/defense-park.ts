/**
 * 하락장 방어 파킹 시스템
 *
 * 포트폴리오 하락세 감지 → 전종목 청산 → KODEX 200 파킹
 * 상승세 회복 감지 → KODEX 200 매도 → 정상 매매 복귀
 *
 * 파킹 자산: KODEX 200 (069500) — 대한민국이 망하지 않는 한 0이 되지 않는 가장 안전한 자산
 */

import { getPool, isMemoryMode } from '../../db/client.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';

export const PARK_STOCK_CODE = '069500'; // KODEX 200
export const PARK_STOCK_NAME = 'KODEX 200';

// 하락세 진입 기준 (보수적으로 설정)
const DOWNTREND_DRAWDOWN_PCT = 7;   // 7일 최고점 대비 7% 이상 낙폭
const DOWNTREND_CONFIRM_DAYS = 4;   // 최근 5일 중 음수 daily_pnl 일수
const DOWNTREND_MIN_DAYS = 3;       // 판단에 필요한 최소 스냅샷 수

// 상승세 복귀 기준
const RECOVERY_PARK_PROFIT_PCT = 1.5;  // 파킹 자산 수익률 1.5% 이상 (= 시장 회복 신호)
const RECOVERY_POSITIVE_DAYS = 2;      // 연속 n일 양수 daily_pnl

export interface DefenseParkState {
  isActive: boolean;
  parkStockCode: string;
  parkStockName: string;
  entryReason: string | null;
  enteredAt: Date | null;
}

/** DB에서 현재 방어 파킹 상태 조회 */
export async function getDefenseParkState(): Promise<DefenseParkState> {
  if (isMemoryMode()) {
    return { isActive: false, parkStockCode: PARK_STOCK_CODE, parkStockName: PARK_STOCK_NAME, entryReason: null, enteredAt: null };
  }
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM defense_park_state WHERE is_active = TRUE LIMIT 1`
    );
    if (rows.length === 0) {
      return { isActive: false, parkStockCode: PARK_STOCK_CODE, parkStockName: PARK_STOCK_NAME, entryReason: null, enteredAt: null };
    }
    return {
      isActive: true,
      parkStockCode: rows[0].park_stock_code,
      parkStockName: rows[0].park_stock_name,
      entryReason: rows[0].entry_reason,
      enteredAt: rows[0].entered_at,
    };
  } catch {
    return { isActive: false, parkStockCode: PARK_STOCK_CODE, parkStockName: PARK_STOCK_NAME, entryReason: null, enteredAt: null };
  }
}

/** 방어 파킹 활성화 기록 */
async function activateDefensePark(reason: string): Promise<void> {
  if (isMemoryMode()) return;
  await getPool().query(
    `INSERT INTO defense_park_state (is_active, park_stock_code, park_stock_name, entry_reason, entered_at)
     VALUES (TRUE, $1, $2, $3, NOW())
     ON CONFLICT DO NOTHING`,
    [PARK_STOCK_CODE, PARK_STOCK_NAME, reason]
  );
}

/** 방어 파킹 해제 기록 */
export async function deactivateDefensePark(reason: string): Promise<void> {
  if (isMemoryMode()) return;
  await getPool().query(
    `UPDATE defense_park_state SET is_active = FALSE, exit_reason = $1, exited_at = NOW()
     WHERE is_active = TRUE`,
    [reason]
  );
}

/**
 * 포트폴리오 스냅샷 기반 하락세 감지
 * 최근 7일 스냅샷의 최고점 대비 낙폭 + 연속 음수 일수로 판단
 */
export async function isPortfolioInDowntrend(): Promise<{ downtrend: boolean; reason: string }> {
  if (isMemoryMode()) return { downtrend: false, reason: '' };

  try {
    const { rows } = await getPool().query(`
      SELECT total_value, daily_pnl, snapshot_at
      FROM portfolio_snapshots
      WHERE snapshot_at >= NOW() - INTERVAL '8 days'
      ORDER BY snapshot_at DESC
      LIMIT 10
    `);

    if (rows.length < DOWNTREND_MIN_DAYS) {
      return { downtrend: false, reason: `스냅샷 부족 (${rows.length}개)` };
    }

    const values = rows.map((r: any) => Number(r.total_value));
    const pnls = rows.map((r: any) => Number(r.daily_pnl));

    const currentValue = values[0];
    const peakValue = Math.max(...values);
    const drawdownPct = peakValue > 0 ? ((peakValue - currentValue) / peakValue) * 100 : 0;

    // 최근 5일 중 음수 일수 계산
    const recentPnls = pnls.slice(0, 5);
    const negativeDays = recentPnls.filter(p => p < 0).length;

    const drawdownTriggered = drawdownPct >= DOWNTREND_DRAWDOWN_PCT;
    const consecutiveLossTriggered = negativeDays >= DOWNTREND_CONFIRM_DAYS;

    if (drawdownTriggered && consecutiveLossTriggered) {
      const reason = `7일 최고점 대비 -${drawdownPct.toFixed(1)}% 낙폭 + 최근 5일 중 ${negativeDays}일 손실`;
      return { downtrend: true, reason };
    }

    return { downtrend: false, reason: `낙폭 ${drawdownPct.toFixed(1)}%, 손실일 ${negativeDays}/5` };
  } catch (err) {
    logger.warn(`하락세 감지 오류: ${err}`, { component: 'DEFENSE_PARK' });
    return { downtrend: false, reason: '오류' };
  }
}

/**
 * 파킹 포지션의 시장 회복 여부 감지
 * KODEX 200 수익률 > 1.5% OR 연속 2일 양수 스냅샷
 */
export async function isMarketRecovering(
  openChains: TransactionChain[],
  livePrices: Map<string, CurrentPrice>,
): Promise<{ recovering: boolean; reason: string }> {
  // 1. KODEX 200 포지션 수익률 확인
  const parkChain = openChains.find(c => c.stock_code === PARK_STOCK_CODE);
  if (parkChain && parkChain.avg_buy_price) {
    const price = livePrices.get(PARK_STOCK_CODE);
    if (price && price.currentPrice > 0) {
      const avgBuy = Number(parkChain.avg_buy_price);
      const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;
      if (pnlPct >= RECOVERY_PARK_PROFIT_PCT) {
        return {
          recovering: true,
          reason: `KODEX 200 수익률 +${pnlPct.toFixed(1)}% (기준 +${RECOVERY_PARK_PROFIT_PCT}%)`,
        };
      }
    }
  }

  // 2. 스냅샷 연속 양수 확인
  if (!isMemoryMode()) {
    try {
      const { rows } = await getPool().query(`
        SELECT daily_pnl FROM portfolio_snapshots
        ORDER BY snapshot_at DESC LIMIT 3
      `);
      const recentPnls = rows.map((r: any) => Number(r.daily_pnl));
      const consecutivePositive = recentPnls.slice(0, RECOVERY_POSITIVE_DAYS).every(p => p > 0);
      if (consecutivePositive && recentPnls.length >= RECOVERY_POSITIVE_DAYS) {
        return {
          recovering: true,
          reason: `연속 ${RECOVERY_POSITIVE_DAYS}일 수익 흑자 전환`,
        };
      }
    } catch { /* 스냅샷 없으면 스킵 */ }
  }

  // 3. 파킹 1일 이상 경과 + KODEX 200이 손실 아닐 때 → 기간 만료 해제
  if (!isMemoryMode() && parkChain) {
    try {
      const { rows } = await getPool().query(
        `SELECT entered_at FROM defense_park_state WHERE is_active = TRUE ORDER BY entered_at DESC LIMIT 1`
      );
      if (rows.length > 0) {
        const enteredAt = new Date(rows[0].entered_at);
        const hoursParked = (Date.now() - enteredAt.getTime()) / (1000 * 60 * 60);
        if (hoursParked >= 24) {
          const price = livePrices.get(PARK_STOCK_CODE);
          const avgBuy = Number(parkChain.avg_buy_price ?? 0);
          const currentPx = price?.currentPrice ?? 0;
          const pnlPct = avgBuy > 0 && currentPx > 0 ? ((currentPx - avgBuy) / avgBuy) * 100 : 0;
          if (pnlPct >= -1.0) {
            return {
              recovering: true,
              reason: `파킹 ${hoursParked.toFixed(0)}시간 경과 — 기간 만료 자동 해제 (KODEX200 ${pnlPct.toFixed(1)}%)`,
            };
          }
        }
      }
    } catch { /* 스킵 */ }
  }

  return { recovering: false, reason: '' };
}

/**
 * 방어 파킹 진입 결정 생성
 * 1) 보유 전종목 FORCE_CLOSE
 * 2) 가용 현금으로 KODEX 200 BUY
 */
export async function buildDefenseParkEntryDecisions(
  openChains: TransactionChain[],
  livePrices: Map<string, CurrentPrice>,
  orderableCash: number,
  reason: string,
): Promise<TradeDecision[]> {
  logger.warn(`🛡️ 방어 파킹 진입: ${reason}`, { component: 'DEFENSE_PARK' });
  await activateDefensePark(reason);

  import('../../notifications/web-push.js').then(m =>
    m.notifyAlert('🛡️ DEFENSE 모드 진입', `사유: ${reason.slice(0, 80)}\nKODEX 200으로 자산 이동`)
  ).catch(() => {});

  const decisions: TradeDecision[] = [];

  // 1. 손실 포지션만 청산 (KODEX 200 및 수익 중 종목 제외)
  for (const chain of openChains) {
    if (chain.stock_code === PARK_STOCK_CODE) continue;
    const livePrice = livePrices.get(chain.stock_code);
    const avgBuy = Number(chain.avg_buy_price ?? 0);
    const currentPx = livePrice?.currentPrice ?? 0;
    // 수익 중(+1% 이상)이면 FORCE_CLOSE 제외 — 수익 실현 기회 보존
    if (avgBuy > 0 && currentPx > 0 && ((currentPx - avgBuy) / avgBuy) * 100 >= 1.0) {
      logger.info(`🛡️ 방어 파킹: ${chain.stock_code} 수익 중 — 청산 제외`, { component: 'DEFENSE_PARK' });
      continue;
    }
    decisions.push({
      action: 'FORCE_CLOSE',
      stock_code: chain.stock_code,
      quantity: chain.total_quantity,
      price_type: 'MARKET',
      reasoning: `🛡️ 방어 파킹 진입 — 손실 포지션 청산: ${reason}`,
      confidence: 0.99,
    });
  }

  // 2. KODEX 200 매수 (이미 보유 중이면 스킵)
  const alreadyHasPark = openChains.some(c => c.stock_code === PARK_STOCK_CODE);
  if (!alreadyHasPark && orderableCash > 50000) {
    const parkPrice = livePrices.get(PARK_STOCK_CODE);
    if (parkPrice && parkPrice.currentPrice > 0) {
      const investAmount = Math.floor(orderableCash * 0.95); // 95% 투입 (수수료 여유)
      const qty = Math.floor(investAmount / parkPrice.currentPrice);
      if (qty > 0) {
        decisions.push({
          action: 'BUY',
          stock_code: PARK_STOCK_CODE,
          quantity: qty,
          price_type: 'MARKET',
          limit_price: parkPrice.currentPrice,
          reasoning: `🛡️ 방어 파킹: ${PARK_STOCK_NAME} — 하락장 안전자산 (${reason})`,
          confidence: 0.99,
        });
      }
    }
  }

  return decisions;
}

/**
 * 방어 파킹 해제 결정 생성
 * KODEX 200 전량 매도 후 정상 매매 복귀
 */
export async function buildDefenseParkExitDecisions(
  openChains: TransactionChain[],
  reason: string,
): Promise<TradeDecision[]> {
  logger.info(`✅ 방어 파킹 해제: ${reason}`, { component: 'DEFENSE_PARK' });
  await deactivateDefensePark(reason);

  import('../../notifications/web-push.js').then(m =>
    m.notifyAlert('✅ DEFENSE 모드 해제', `사유: ${reason.slice(0, 80)}\n정상 SWING 매매 복귀`)
  ).catch(() => {});

  const parkChain = openChains.find(c => c.stock_code === PARK_STOCK_CODE);
  if (!parkChain) return [];

  return [{
    action: 'SELL',
    stock_code: PARK_STOCK_CODE,
    quantity: parkChain.total_quantity,
    price_type: 'MARKET',
    reasoning: `✅ 방어 파킹 해제 — ${PARK_STOCK_NAME} 전량 매도: ${reason}`,
    confidence: 0.99,
  }];
}
