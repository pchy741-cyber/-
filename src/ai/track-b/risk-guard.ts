import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { PARK_STOCK_CODE } from './defense-park.js';

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
    if (d.stock_code === PARK_STOCK_CODE) return true;

    const chain = openChains.find((c) => c.stock_code === d.stock_code);
    if (!chain?.avg_buy_price) return true;

    const liveP = livePrices.get(d.stock_code);
    if (!liveP || liveP.currentPrice <= 0) return true;

    const avgBuy = Number(chain.avg_buy_price);
    if (avgBuy <= 0) return true;

    const pnlPct = ((liveP.currentPrice - avgBuy) / avgBuy) * 100;

    // 보유 기간 초과 시 기술적 매도 신호 차단 면제 (장기 물림 방지)
    const maxHoldingDays = baseP.maxHoldingDays ?? 0;
    if (maxHoldingDays > 0 && chain.opened_at) {
      const holdingDays = (Date.now() - new Date(chain.opened_at).getTime()) / 86400000;
      if (holdingDays >= maxHoldingDays) return true;
    }

    if (d.action === 'FORCE_CLOSE' && pnlPct > _stopPct) {
      // PROFIT_TAKING 상태의 트레일링/브레이크이븐 스탑은 technical-fallback이 발행 — 차단하면 청산 불가
      if (chain?.status === 'PROFIT_TAKING') return true;
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

    const stopPct = chain.stop_loss_pct != null
      ? Number(chain.stop_loss_pct)
      : (stopLossPct ?? baseParams.stopLossPct);

    // PROFIT_TAKING 상태: 트레일링 스탑은 technical-fallback 전담, 하드 손절은 여기서도 강제
    if (chain.status === 'PROFIT_TAKING') {
      if (pnlPct <= stopPct) {
        logger.info(
          `🔒 PROFIT_TAKING 하드 손절: ${chain.stock_code} ${pnlPct.toFixed(1)}% ≤ ${stopPct}% — 잔여 포지션 강제 청산`,
          { component: 'RISK_GUARD' },
        );
        result.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `PROFIT_TAKING 하드 손절: ${pnlPct.toFixed(1)}% (한도 ${stopPct}%) — 잔여 포지션 강제 실행`,
          confidence: 1.0,
        });
      }
      continue; // 트레일링 스탑은 technical-fallback 처리
    }

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

// 섹터 집중도 차단에 사용하는 정적 섹터 맵
const SECTOR_MAP: Record<string, string> = {
  '000660': '반도체', '005930': '반도체', '042700': '반도체', '005290': '반도체', '357780': '반도체', '403870': '반도체',
  '051910': '배터리', '006400': '배터리', '247540': '배터리', '373220': '배터리', '336260': '배터리', '003670': '배터리',
  '012450': '방산', '079550': '방산', '034020': '방산',
  '035420': '인터넷', '035720': '인터넷', '377300': '인터넷',
  '207940': '바이오', '068270': '바이오', '328130': '바이오', '196170': '바이오', '028300': '바이오',
  '055550': '금융', '105560': '금융', '316140': '금융',
  '267260': '전력', '009540': '조선', '066570': '가전',
};

/**
 * 섹터 집중 매수 차단
 * 같은 섹터에 이미 2종목 이상 보유 중이면 해당 섹터 신규 BUY 차단
 */
export function filterSectorConcentration(
  decisions: TradeDecision[],
  openChains: TransactionChain[],
): TradeDecision[] {
  const heldSectorCounts: Record<string, number> = {};
  for (const c of openChains) {
    if (Number(c.total_quantity) <= 0) continue;
    const sector = SECTOR_MAP[c.stock_code];
    if (sector) heldSectorCounts[sector] = (heldSectorCounts[sector] ?? 0) + 1;
  }
  const blockedSectors = new Set(
    Object.entries(heldSectorCounts).filter(([, n]) => n >= 2).map(([s]) => s),
  );
  if (blockedSectors.size === 0) return decisions;

  return decisions.filter((d) => {
    if (d.action !== 'BUY' && d.action !== 'AVERAGE_DOWN') return true;
    const sector = SECTOR_MAP[d.stock_code];
    if (sector && blockedSectors.has(sector)) {
      logger.warn(`🚫 섹터 집중 차단: ${d.stock_code} (${sector}) — 이미 ${heldSectorCounts[sector]}종목 보유`, { component: 'RISK_GUARD' });
      return false;
    }
    return true;
  });
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
