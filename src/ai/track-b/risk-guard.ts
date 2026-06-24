import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { config } from '../../config/index.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { PARK_STOCK_CODE } from './defense-park.js';
import { MEGA_CAP_PRIORITY_CODES } from './trading-rules.js';

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
      const holdingDays = (Date.now() - new Date(chain.opened_at).getTime()) / 86_400_000; // 1 day in ms
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
  chartData?: Map<string, import('../../kis/market.js').DailyCandle[]>;
}): Promise<TradeDecision[]> {
  const { decisions, openChains, livePrices, mode, stopLossPct, chartData } = params;
  const result = [...decisions];
  const baseParams = STRATEGY_PARAMS[mode];

  let trailingStopBase = -2.5;
  try {
    const { getPool } = await import('../../db/client.js');
    const { rows } = await getPool().query(
      'SELECT trailing_stop_pct FROM portfolio_allocation_config WHERE is_paper = $1 LIMIT 1',
      [getCtxIsPaper()],
    );
    if (rows[0]?.trailing_stop_pct) trailingStopBase = -Math.abs(Number(rows[0].trailing_stop_pct));
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

    // ── v13-fix: 대형우량주 파킹 개념 도입 ──
    // 삼성전자 등 메가캡은 일중 3-5% 변동이 정상 → 기존 -3.5% 손절은 너무 타이트
    // 대형주: 손절 -5.5%, 초기 버퍼 2.0% (30분간), 절대 바닥 -7%
    // 일반주: 기존 유지 (-3.5% ~ -6%)
    const isMegaCap = MEGA_CAP_PRIORITY_CODES.has(chain.stock_code);
    const holdMs = chain.opened_at ? Date.now() - new Date(chain.opened_at).getTime() : Infinity;
    const EARLY_HOLD_MS = isMegaCap ? 30 * 60_000 : 10 * 60_000; // 대형주 30분, 일반 10분
    const EARLY_BUFFER = isMegaCap ? 2.0 : 0.5; // 대형주 2%, 일반 0.5%
    const HARD_FLOOR = isMegaCap ? -7.0 : -6.0; // 대형주 -7%, 일반 -6%
    const earlyBuffer = holdMs < EARLY_HOLD_MS ? EARLY_BUFFER : 0;
    // 대형주 기본 손절폭 확대: baseStop이 -3.5%면 → -5.5%로 확대
    const effectiveBaseStop = isMegaCap ? Math.min(baseStop, -5.5) : baseStop;
    const stopPct = Math.max(effectiveBaseStop - earlyBuffer, HARD_FLOOR);

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
      // ── 동적 트레일링: ATR/ADX 기반 (해외 시스템 포팅) ──
      let dynamicTrail = trailingStopBase;
      const candles = chartData?.get(chain.stock_code);
      if (candles && candles.length >= 20) {
        const { analyzeTechnicals } = await import('../../analysis/indicators.js');
        const tech = analyzeTechnicals(candles);
        if (tech) {
        const atrPct = tech.atr14 > 0 && price.currentPrice > 0 ? (tech.atr14 / price.currentPrice) * 100 : 2.0;

        // ATR × 2.0 기반 트레일 (해외와 동일)
        const atrTrail = -(atrPct * 2.0);
        // 국내 범위: 대형주 -2%~-5%, 중소형 -3%~-7%
        dynamicTrail = Math.max(-7.0, Math.min(-2.0, atrTrail));

        // ADX 추세 강도 보정
        if (tech.adx14 >= 30 && tech.rsi14 >= 50 && tech.rsi14 <= 70) {
          dynamicTrail *= 1.2; // 강한 추세 → 넓은 트레일 (달리게)
        } else if (tech.adx14 < 20) {
          dynamicTrail *= 0.85; // 횡보장 → 타이트 트레일
        }
        // 과매수 영역 → 타이트 (대형주는 면제 — 강한 추세에서 RSI 75+ 정상)
        if (tech.rsi14 > 75 && !isMegaCap) dynamicTrail = Math.max(dynamicTrail, -3.5);

        // 수익 클수록 트레일 허용폭 확장 (모멘텀 종목 조기 청산 방지 — 상한가 진입 여지 보존)
        const maxPnl = peakForTrail > avgBuy ? ((peakForTrail - avgBuy) / avgBuy) * 100 : pnlPct;
        if (maxPnl >= 15) dynamicTrail = Math.min(dynamicTrail, -6.0); // 강한 모멘텀 → 최소 -6% 여유
        else if (maxPnl >= 10) dynamicTrail = Math.min(dynamicTrail, -5.0);
        else if (maxPnl >= 6) dynamicTrail = Math.min(dynamicTrail, -4.0);

        // 최종 클램프
        dynamicTrail = Math.max(-7.0, Math.min(-2.0, dynamicTrail));
        } // if (tech)
      }

      const trailDropPct = ((price.currentPrice - peakForTrail) / peakForTrail) * 100;
      if (trailDropPct <= dynamicTrail) {
        logger.info(
          `🔒 동적 트레일링: ${chain.stock_code} 고점 대비 ${trailDropPct.toFixed(1)}% (한도 ${dynamicTrail.toFixed(1)}%, 수익 +${pnlPct.toFixed(1)}%)`,
          { component: 'RISK_GUARD' },
        );
        result.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `동적 트레일링: 고점 대비 ${trailDropPct.toFixed(1)}% (ATR한도 ${dynamicTrail.toFixed(1)}%, 수익 +${pnlPct.toFixed(1)}%)`,
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

// 섹터 집중도 차단에 사용하는 정적 섹터 맵 (constants.ts SSoT)
import { SECTOR_MAP_KR as SECTOR_MAP } from '../../config/constants.js';

/**
 * 섹터 집중 매수 차단
 * 같은 섹터에 이미 2종목 이상 보유 중이면 해당 섹터 신규 BUY 차단
 */
export function filterSectorConcentration(
  decisions: TradeDecision[],
  openChains: TransactionChain[],
  isPaper: boolean,
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
  const SELL_PRIORITY: Readonly<Record<string, number>> = { FORCE_CLOSE: 3, SELL: 2, PARTIAL_SELL: 1 };
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
