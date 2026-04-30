import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { IDLE_PARK_CODES } from './trading-rules.js';
import { PARK_STOCK_CODE } from './defense-park.js';

const IDLE_PARK_CODE_SET = new Set<string>(IDLE_PARK_CODES);

/**
 * 조기 매도 방지 필터
 * - 기술 신호가 손절선 미도달 포지션을 닫으려는 것 차단
 * - 실제 익절/손절은 applyHardRules가 전담
 * - 파킹 ETF는 예외 (가격 무관 청산)
 */
export function filterEarlySells(params: {
  decisions: TradeDecision[];
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  mode: StrategyMode;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
}): TradeDecision[] {
  const { decisions, openChains, livePrices, mode, stopLossPct, takeProfitPct } = params;
  const baseP = STRATEGY_PARAMS[mode];
  const _stopPct = stopLossPct ?? baseP.stopLossPct;
  const _tpPct = takeProfitPct ?? baseP.takeProfitPct;

  return decisions.filter((d) => {
    if (!['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action)) return true;
    if (IDLE_PARK_CODE_SET.has(d.stock_code) || d.stock_code === PARK_STOCK_CODE) return true;

    const chain = openChains.find((c) => c.stock_code === d.stock_code);
    if (!chain?.avg_buy_price) return true;

    const liveP = livePrices.get(d.stock_code);
    if (!liveP || liveP.currentPrice <= 0) return true;

    const avgBuy = Number(chain.avg_buy_price);
    if (avgBuy <= 0) return true;

    const pnlPct = ((liveP.currentPrice - avgBuy) / avgBuy) * 100;

    if (d.action === 'FORCE_CLOSE' && pnlPct > _stopPct) {
      logger.warn(
        `🛡️ AI 조기 청산 차단: ${d.stock_code} 현재 ${pnlPct.toFixed(1)}% (손절선 ${_stopPct}% 미도달) → 하드룰 대기`,
        { component: 'RISK_GUARD' },
      );
      return false;
    }

    if ((d.action === 'SELL' || d.action === 'PARTIAL_SELL') && pnlPct > _stopPct && pnlPct < _tpPct) {
      logger.warn(
        `🛡️ AI 중간 매도 차단: ${d.stock_code} 현재 ${pnlPct.toFixed(1)}% — 트레일링/하드룰 처리 대기`,
        { component: 'RISK_GUARD' },
      );
      return false;
    }

    return true;
  });
}

/**
 * 하드룰: 트레일링 스탑 + 고정 손절 강제 실행
 * - AI 결정과 무관하게 목표 수익률/손절 초과 시 무조건 실행
 * - PROFIT_TAKING 상태: technical-fallback.ts가 단독 처리 — 여기선 스킵
 * - 트레일링 스탑 활성화: +1.5% 이상 수익 중일 때
 */
export async function applyHardRules(params: {
  decisions: TradeDecision[];
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  mode: StrategyMode;
  stopLossPct?: number | null;
}): Promise<TradeDecision[]> {
  const { decisions, openChains, livePrices, mode, stopLossPct } = params;
  const result = [...decisions];
  const baseParams = STRATEGY_PARAMS[mode];

  let trailingStopThreshold = -5;
  try {
    const { getPool } = await import('../../db/client.js');
    const { rows } = await getPool().query('SELECT trailing_stop_pct FROM portfolio_allocation_config LIMIT 1');
    if (rows[0]?.trailing_stop_pct) trailingStopThreshold = -Math.abs(Number(rows[0].trailing_stop_pct));
  } catch { /* 기본값 사용 */ }

  for (const chain of openChains) {
    if (IDLE_PARK_CODE_SET.has(chain.stock_code)) continue;

    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;
    const avgBuy = Number(chain.avg_buy_price);
    if (avgBuy <= 0 || price.currentPrice <= 0) continue;
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 이미 매도 결정 있으면 스킵 (technical-fallback 결정 우선)
    const alreadySelling = result.some(
      (d) => d.stock_code === chain.stock_code && ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action),
    );
    if (alreadySelling) continue;

    // PROFIT_TAKING: technical-fallback.ts 단독 처리
    if (chain.status === 'PROFIT_TAKING') continue;

    const stopPct = chain.stop_loss_pct != null
      ? Number(chain.stop_loss_pct)
      : (stopLossPct ?? baseParams.stopLossPct);

    const peakForTrail = (chain as any).peak_price_since_open
      ? Number((chain as any).peak_price_since_open)
      : 0;

    if (peakForTrail > 0 && pnlPct >= 1.5) {
      const trailDropPct = ((price.currentPrice - peakForTrail) / peakForTrail) * 100;
      if (trailDropPct <= trailingStopThreshold) {
        logger.info(
          `🔒 트레일링 스탑: ${chain.stock_code} 고점 ${peakForTrail.toFixed(0)}원 대비 ${trailDropPct.toFixed(1)}% 하락 (수익 ${pnlPct.toFixed(1)}%)`,
          { component: 'RISK_GUARD' },
        );
        result.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `트레일링 스탑: 고점 ${peakForTrail.toFixed(0)}원 대비 ${trailDropPct.toFixed(1)}% 하락 (수익 +${pnlPct.toFixed(1)}%)`,
          confidence: 1.0,
        });
      }
    } else if (pnlPct <= stopPct) {
      logger.info(
        `🔒 하드 손절: ${chain.stock_code} ${pnlPct.toFixed(1)}% (한도 ${stopPct}%) — AI HOLD 무시`,
        { component: 'RISK_GUARD' },
      );
      result.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `하드 손절: ${pnlPct.toFixed(1)}% (한도 ${stopPct}%) — AI 결정 무관 강제 실행`,
        confidence: 1.0,
      });
    }
  }

  return result;
}

/** CEO 수동 매도 쿨다운 필터 (24시간 재진입 금지) */
export function filterManualCooldown(
  decisions: TradeDecision[],
  manuallySoldCodes: Set<string>,
): TradeDecision[] {
  if (manuallySoldCodes.size === 0) return decisions;
  const before = decisions.length;
  const result = decisions.filter((d) => {
    if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && d.stock_code && manuallySoldCodes.has(d.stock_code)) {
      logger.warn(`🚫 CEO 수동 매도 쿨다운 차단: ${d.stock_code} — 24시간 재진입 금지`, { component: 'RISK_GUARD' });
      return false;
    }
    return true;
  });
  if (result.length < before) {
    logger.info(`🚫 수동 매도 쿨다운: ${before - result.length}건 BUY 차단 (${[...manuallySoldCodes].join(', ')})`, { component: 'RISK_GUARD' });
  }
  return result;
}

/**
 * 중복 매도 신호 제거
 * 우선순위: FORCE_CLOSE > SELL > PARTIAL_SELL
 */
export function deduplicateSells(decisions: TradeDecision[]): TradeDecision[] {
  const SELL_PRIORITY: Record<string, number> = { FORCE_CLOSE: 3, SELL: 2, PARTIAL_SELL: 1 };
  const sellMap = new Map<string, TradeDecision>();
  const nonSellDecisions: TradeDecision[] = [];

  for (const d of decisions) {
    if (['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action) && d.stock_code) {
      const existing = sellMap.get(d.stock_code);
      if (!existing || (SELL_PRIORITY[d.action] ?? 0) > (SELL_PRIORITY[existing.action] ?? 0)) {
        sellMap.set(d.stock_code, d);
      } else {
        logger.warn(
          `🔇 중복 매도 신호 제거: ${d.stock_code} ${d.action} (이미 ${existing.action} 존재)`,
          { component: 'RISK_GUARD' },
        );
      }
    } else {
      nonSellDecisions.push(d);
    }
  }

  return [...nonSellDecisions, ...sellMap.values()];
}
