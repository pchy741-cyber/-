import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { config } from '../../config/index.js';
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

    // FORCE_CLOSE = 시간 기반 강제청산(SCALPING 09:45 등) 또는 모드 전환 청산 — 무조건 허용
    if (d.action === 'FORCE_CLOSE') return true;

    // 체인별 동적 TP 우선: 진입 시 설정된 target_profit_pct 사용 (글로벌 TP보다 정확)
    // 글로벌 _tpPct=7%인데 체인 TP=6%일 때, 6.8% 수익이면 → 체인 기준 TP 도달 → 매도 허용
    const chainTp = chain.target_profit_pct != null ? Number(chain.target_profit_pct) : _tpPct;
    const chainSl = chain.stop_loss_pct != null ? Number(chain.stop_loss_pct) : _stopPct;

    // 고확신 매도 (confidence ≥ 0.85) — sell-signals가 확실한 근거로 내린 결정은 존중
    if (d.confidence != null && d.confidence >= 0.85) return true;

    if ((d.action === 'SELL' || d.action === 'PARTIAL_SELL') && pnlPct > chainSl && pnlPct < chainTp) {
      logger.warn(
        `🛡️ AI 중간 매도 차단: ${d.stock_code} 현재 ${pnlPct.toFixed(1)}% (SL ${chainSl}% ~ TP ${chainTp}%) — 트레일링/하드룰 처리 대기`,
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

  let trailingStopThreshold = -2.5;
  try {
    const { getPool } = await import('../../db/client.js');
    const { rows } = await getPool().query(
      'SELECT trailing_stop_pct FROM portfolio_allocation_config WHERE is_paper = $1 LIMIT 1',
      [getCtxIsPaper()],
    );
    if (rows[0]?.trailing_stop_pct) trailingStopThreshold = -Math.abs(Number(rows[0].trailing_stop_pct));
  } catch {
    /* 기본값 사용 */
  }

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

    const baseStop =
      chain.stop_loss_pct != null ? Number(chain.stop_loss_pct) : (stopLossPct ?? baseParams.stopLossPct);

    // ── 진입 초기 여유 버퍼: 비활성화 (2026-06 성과 검토) ──
    // v2 문제: WR 30.8%에서 earlyBuffer 1.5%는 70% 잘못된 진입의 손실을 -3%→-4.5%로 확대
    // v3: earlyBuffer 제거, baseStop 그대로 적용. 빠른 손절이 평균 손실 감소 효과.
    // 10분 미만 보유는 약간의 여유(0.5%)만 제공 — 체결 직후 노이즈 방지
    const holdMs = chain.opened_at ? Date.now() - new Date(chain.opened_at).getTime() : Infinity;
    const EARLY_HOLD_MS = 10 * 60_000; // 10분 (기존 1시간→10분 축소)
    const EARLY_BUFFER = 0.5; // 0.5% 최소 여유 (기존 1.5%→0.5%)
    const HARD_FLOOR = -6.0; // 절대 손절선: -6% (기존 -8%→-6% 축소)
    const earlyBuffer = holdMs < EARLY_HOLD_MS ? EARLY_BUFFER : 0;
    const stopPct = Math.max(baseStop - earlyBuffer, HARD_FLOOR);

    // PROFIT_TAKING 상태: 트레일링 스탑은 technical-fallback 전담, 하드 손절은 여기서도 강제
    if (chain.status === 'PROFIT_TAKING') {
      if (pnlPct <= baseStop) {
        // PROFIT_TAKING은 이미 수익 실현한 상태 → 버퍼 없이 원래 SL
        logger.info(
          `🔒 PROFIT_TAKING 하드 손절: ${chain.stock_code} ${pnlPct.toFixed(1)}% ≤ ${baseStop}% — 잔여 포지션 강제 청산`,
          { component: 'RISK_GUARD' },
        );
        result.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `PROFIT_TAKING 하드 손절: ${pnlPct.toFixed(1)}% (한도 ${baseStop}%) — 잔여 포지션 강제 실행`,
          confidence: 1.0,
        });
      }
      continue; // 트레일링 스탑은 technical-fallback 처리
    }

    const peakForTrail = chain.peak_price_since_open ? Number(chain.peak_price_since_open) : 0;

    if (peakForTrail > 0 && pnlPct >= 0.5) {
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
      const bufferNote = earlyBuffer > 0 ? ` (초기버퍼 ${EARLY_BUFFER}%, ${Math.round(holdMs / 60_000)}분 보유)` : '';
      logger.info(
        `🔒 하드 손절: ${chain.stock_code} ${pnlPct.toFixed(1)}% (한도 ${stopPct.toFixed(1)}%)${bufferNote} — AI HOLD 무시`,
        { component: 'RISK_GUARD' },
      );
      result.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `하드 손절: ${pnlPct.toFixed(1)}% (한도 ${stopPct.toFixed(1)}%)${bufferNote}`,
        confidence: 1.0,
      });
    }
  }

  return result;
}

// 섹터 집중도 차단에 사용하는 정적 섹터 맵
const SECTOR_MAP: Record<string, string> = {
  '000660': '반도체',
  '005930': '반도체',
  '042700': '반도체',
  '005290': '반도체',
  '357780': '반도체',
  '403870': '반도체',
  '051910': '배터리',
  '006400': '배터리',
  '247540': '배터리',
  '373220': '배터리',
  '336260': '배터리',
  '003670': '배터리',
  '012450': '방산',
  '079550': '방산',
  '034020': '방산',
  '035420': '인터넷',
  '035720': '인터넷',
  '377300': '인터넷',
  '207940': '바이오',
  '068270': '바이오',
  '328130': '바이오',
  '196170': '바이오',
  '028300': '바이오',
  '055550': '금융',
  '105560': '금융',
  '316140': '금융',
  '267260': '전력',
  '009540': '조선',
  '066570': '가전',
};

/**
 * 섹터 집중 매수 차단
 * 같은 섹터에 이미 2종목 이상 보유 중이면 해당 섹터 신규 BUY 차단
 */
export function filterSectorConcentration(
  decisions: TradeDecision[],
  openChains: TransactionChain[],
  isPaper?: boolean,
): TradeDecision[] {
  const maxPerSector = isPaper ? config.paperRisk.sectorMaxPerSector : 2;
  const heldSectorCounts: Record<string, number> = {};
  for (const c of openChains) {
    if (Number(c.total_quantity) <= 0) continue;
    const sector = SECTOR_MAP[c.stock_code];
    if (sector) heldSectorCounts[sector] = (heldSectorCounts[sector] ?? 0) + 1;
  }
  const blockedSectors = new Set(
    Object.entries(heldSectorCounts)
      .filter(([, n]) => n >= maxPerSector)
      .map(([s]) => s),
  );
  if (blockedSectors.size === 0) return decisions;

  return decisions.filter((d) => {
    if (d.action !== 'BUY' && d.action !== 'AVERAGE_DOWN') return true;
    const sector = SECTOR_MAP[d.stock_code];
    if (sector && blockedSectors.has(sector)) {
      logger.warn(
        `🚫 섹터 집중 차단: ${d.stock_code} (${sector}) — 이미 ${heldSectorCounts[sector]}종목 보유 (한도 ${maxPerSector})`,
        { component: 'RISK_GUARD' },
      );
      return false;
    }
    return true;
  });
}

/** CEO 수동 매도 쿨다운 필터 (24시간 재진입 금지) */
export function filterManualCooldown(decisions: TradeDecision[], manuallySoldCodes: Set<string>): TradeDecision[] {
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
    logger.info(`🚫 수동 매도 쿨다운: ${before - result.length}건 BUY 차단 (${[...manuallySoldCodes].join(', ')})`, {
      component: 'RISK_GUARD',
    });
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
        logger.warn(`🔇 중복 매도 신호 제거: ${d.stock_code} ${d.action} (이미 ${existing.action} 존재)`, {
          component: 'RISK_GUARD',
        });
      }
    } else {
      nonSellDecisions.push(d);
    }
  }

  return [...nonSellDecisions, ...sellMap.values()];
}
