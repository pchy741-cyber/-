import { config } from '../../config/index.js';
import type { StrategyMode } from '../../config/constants.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { IDLE_PARK_CODE, IDLE_PARK_CODES, IDLE_PARK_NAME } from './trading-rules.js';

const IDLE_PARK_CODE_SET = new Set<string>(IDLE_PARK_CODES);

export interface CashManagerParams {
  decisions: TradeDecision[];
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  /** 주문가능현금 (reservedWithdraw 차감 후) */
  rawOrderableCash: number;
  /** 유휴 파킹 ETF 평가금액 */
  idleParkValue: number;
  /** 파킹 ETF 가격 캐시 */
  idleParkPriceCache: { price: number };
  /** 총자산 (totalEvalAmount + orderableCash) */
  totalAssets: number;
  /** totalDeposit — D+2 미결제 포함 최정확 총자산 */
  totalDeposit: number;
  mode: StrategyMode;
  hasBuyCandidates: boolean;
}

/**
 * 유휴 현금 파킹 + 파킹 해제 관리
 *
 * 파킹 진입: 매수 후 잔여 현금 10% 초과 → 머니마켓 ETF 자동 주차 (90%)
 * 파킹 해제: BUY 신호 있고 현금 부족 → 파킹 ETF 청산 후 다음 사이클 재매수
 * SCALPING 모드: 파킹 없음 (단타 특성상 현금 유동성 최우선)
 */
export function manageCashParking(params: CashManagerParams): TradeDecision[] {
  const {
    decisions, openChains, livePrices,
    rawOrderableCash, idleParkValue, idleParkPriceCache,
    totalAssets, totalDeposit, mode, hasBuyCandidates,
  } = params;

  if (mode === 'SCALPING') return decisions;

  let result = [...decisions];
  const alreadyIdleParked = openChains.some((c) => IDLE_PARK_CODE_SET.has(c.stock_code) && Number(c.total_quantity) > 0);

  const plannedBuyCash = result
    .filter((d) => (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !IDLE_PARK_CODE_SET.has(d.stock_code))
    .reduce((sum, d) => sum + (d.limit_price ?? 0) * (d.quantity ?? 0), 0);
  const cashAfterBuys = Math.max(0, rawOrderableCash - plannedBuyCash);
  const totalPortfolio = Math.max(totalAssets, totalDeposit);
  const idlePctAfterBuys = totalPortfolio > 0 ? (cashAfterBuys / totalPortfolio) * 100 : 0;
  const idleParkPct = totalPortfolio > 0 ? (idleParkValue / totalPortfolio) * 100 : 0;
  // 파킹 잔액 40% 이하일 때만 추가 파킹 (무한 파킹 방지)
  const canParkMore = idleParkPct < 40;
  const isDividendMode = mode === 'DIVIDEND';
  const parkCurrentPrice = idleParkPriceCache.price;

  // ── 파킹 진입 ──────────────────────────────────────────────────────
  // DIVIDEND: 100% 파킹 (신규 매수 없음)
  // 일반: 현금 10% 초과 시 90% 파킹 (10%는 긴급 매수 여유)
  if ((isDividendMode || idlePctAfterBuys > 10) && canParkMore) {
    if (parkCurrentPrice > 0) {
      const parkAmount = cashAfterBuys * (isDividendMode ? 1.0 : 0.90);
      const qty = Math.floor(parkAmount / parkCurrentPrice);
      if (qty > 0) {
        logger.info(
          `💰 유휴 현금 머니마켓 파킹: 현금 ${idlePctAfterBuys.toFixed(1)}%(${Math.round(cashAfterBuys).toLocaleString()}원) → ${IDLE_PARK_NAME} ${qty}주 @${parkCurrentPrice.toLocaleString()}원 (${Math.round(parkAmount).toLocaleString()}원)`,
          { component: 'CASH_MGR' },
        );
        result.push({
          action: 'BUY',
          stock_code: IDLE_PARK_CODE,
          quantity: qty,
          price_type: 'MARKET',
          limit_price: parkCurrentPrice,
          reasoning: `유휴 현금 파킹: 현금 ${idlePctAfterBuys.toFixed(1)}%(매수후 잔여) → ${IDLE_PARK_NAME} (단기금융형, 익일물 콜금리 수준 수익)`,
          confidence: 0.95,
        });
      }
    } else {
      logger.warn(`💰 유휴 현금 파킹 실패: ${IDLE_PARK_CODE} 가격 조회 불가 (rate limit?)`, { component: 'CASH_MGR' });
    }
  }

  // ── 파킹 해제 ──────────────────────────────────────────────────────
  // BUY 신호 있고 현금 부족 → 파킹 ETF 매도 후 다음 사이클에서 재매수
  // (파킹 ETF 매도 현금은 T+2 정산 — 동일 사이클 매수 실행 시 주문 실패)
  const hasBuyDecision = result.some(
    (d) => (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !IDLE_PARK_CODE_SET.has(d.stock_code),
  );
  const cashInsufficient = rawOrderableCash < config.risk.maxPositionKrw * 0.5;

  if ((hasBuyDecision || (hasBuyCandidates && cashInsufficient)) && alreadyIdleParked) {
    const parkChains = openChains.filter((c) => IDLE_PARK_CODE_SET.has(c.stock_code) && Number(c.total_quantity) > 0);
    for (const parkChain of parkChains) {
      const fallbackPrice = Number(parkChain.avg_buy_price ?? 0);
      const livePrice = livePrices.get(parkChain.stock_code)?.currentPrice ?? 0;
      const priceForLog = livePrice > 0 ? livePrice : (parkCurrentPrice > 0 ? parkCurrentPrice : fallbackPrice);
      const parkPnlPct = priceForLog > 0 && fallbackPrice > 0 ? ((priceForLog - fallbackPrice) / fallbackPrice) * 100 : 0;
      const parkName = parkChain.stock_code === IDLE_PARK_CODE ? IDLE_PARK_NAME : parkChain.stock_code;
      logger.info(
        `🔄 파킹 해제: 현금 부족 → ${parkName} ${parkChain.total_quantity}주 매도 | 이번 사이클 BUY 보류 (다음 사이클 재매수)`,
        { component: 'CASH_MGR' },
      );
      result.unshift({
        action: 'FORCE_CLOSE',
        stock_code: parkChain.stock_code,
        quantity: parkChain.total_quantity,
        price_type: 'MARKET',
        reasoning: `파킹 해제: ${parkName} 청산 (수익 ${parkPnlPct.toFixed(2)}%) → 다음 사이클 재매수`,
        confidence: 0.95,
      });
    }
    // 파킹 해제 사이클: BUY 보류 (T+2 현금 정산 후 다음 사이클 실행)
    result = result.filter((d) => !(d.action === 'BUY' && !IDLE_PARK_CODE_SET.has(d.stock_code)));
  }

  return result;
}
