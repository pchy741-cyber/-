import { analyzeTechnicals } from '../../analysis/indicators.js';
import { INVERSE_ETF_CODES } from '../../automation/crash-profit.js';
import { getPool } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { resolveStrategyParams, type TechnicalFallbackParams } from './technical-fallback-types.js';

/**
 * 보유 종목 물타기 판단 (지지선+반등신호 게이트)
 */
export async function generateAveragingDecisions(
  params: TechnicalFallbackParams,
  remainingCash: number,
  effectiveMaxPos: number,
  splitCount: number,
): Promise<TradeDecision[]> {
  const { livePrices, chartData, openChains, totalAssets } = params;
  const strategyParams = resolveStrategyParams(params.mode, params);
  const decisions: TradeDecision[] = [];
  let cash = remainingCash;

  for (const chain of openChains) {
    // 인버스 ETF는 crash-profit.ts가 단독 관리 — 물타기 로직 건너뜀
    if (INVERSE_ETF_CODES.has(chain.stock_code)) continue;
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;
    const avgDownTrigger = strategyParams.averageDownPct; // 보통 -3%

    // 물타기 차단: 익절 진행 중 체인 or SMA20 아래 깊은 하락 (추가 물타기는 손실만 키움)
    const chainCandles = chartData.get(chain.stock_code);
    const chainTech = chainCandles ? analyzeTechnicals(chainCandles) : null;
    const isBelowSma20Deep = chainTech ? price.currentPrice < chainTech.sma20 * 0.97 : false; // SMA20 -3% 이상 이탈 시 물타기 금지
    // 하드 손실 한도: -8% 초과 수중에서는 물타기 절대 금지 (나락 방지)
    const isTooDeepUnderwater = pnlPct <= -8.0;
    // 포지션 집중도 한도: 총자산의 25% 이상이면 추가 물타기 차단 (Hard Cap과 동기화)
    const positionValue = price.currentPrice * Number(chain.total_quantity ?? 0);
    const concentrationPct = (totalAssets ?? 0) > 0 ? positionValue / totalAssets! : 0;
    const isTooConcentrated = concentrationPct >= 0.25;
    // ── 지지선 + 반등신호 없는 물타기 차단 ──────────────────────────────────
    // 지지선 근처(BB하단/RSI과매도)에 있더라도, 실제 반전 신호가 있어야 물타기 허용
    // "제이마니아 판정": 차트에서 반등 시그널 확인 후 추가매수 (기계적 % 물타기 금지)
    const hasBullishReversalCandle = chainTech
      ? chainTech.candlePatterns.some((p) => p.bullish && (p.strength === 'STRONG' || p.strength === 'MODERATE'))
      : false;
    const avgDownSupportOk = chainTech
      ? chainTech.bollingerPosition === 'BELOW_LOWER' ||
        chainTech.bollingerPosition === 'NEAR_LOWER' ||
        chainTech.rsi14 < 38
      : true;
    // 반등신호: 불리쉬 캔들(망치형 등) OR MACD 전환 OR RSI 과매도+MACD 비하락
    const avgDownReversalOk = chainTech
      ? hasBullishReversalCandle ||
        chainTech.macdCrossover === 'BULLISH' ||
        (chainTech.rsi14 < 35 && chainTech.macdCrossover !== 'BEARISH')
      : true;
    if (
      chain.status === 'PROFIT_TAKING' ||
      isBelowSma20Deep ||
      isTooDeepUnderwater ||
      !avgDownSupportOk ||
      !avgDownReversalOk ||
      isTooConcentrated
    ) {
      if (isBelowSma20Deep)
        logger.info(`  🚫 ${chain.stock_code}: SMA20 -3% 이탈 → 물타기 차단 (손실확대 방지)`, { component: 'TRACK_B' });
      if (isTooDeepUnderwater)
        logger.info(`  🚫 ${chain.stock_code}: ${pnlPct.toFixed(1)}% ≤ -8% → 물타기 하드 차단 (나락 방지)`, {
          component: 'TRACK_B',
        });
      if (isTooConcentrated)
        logger.info(
          `  🚫 ${chain.stock_code}: 비중 ${(concentrationPct * 100).toFixed(1)}% ≥ 10% → 물타기 차단 (집중 방지)`,
          { component: 'TRACK_B' },
        );
      if (!avgDownSupportOk && !isBelowSma20Deep && !isTooDeepUnderwater && !isTooConcentrated)
        logger.info(
          `  🚫 ${chain.stock_code}: 지지선 미확인(BB=${chainTech?.bollingerPosition} RSI=${chainTech?.rsi14.toFixed(0)}) → 물타기 차단`,
          { component: 'TRACK_B' },
        );
      if (avgDownSupportOk && !avgDownReversalOk && !isBelowSma20Deep && !isTooDeepUnderwater && !isTooConcentrated)
        logger.info(
          `  🔄 ${chain.stock_code}: 지지선 OK지만 반등신호 없음(MACD=${chainTech?.macdCrossover} 캔들없음) → 물타기 대기`,
          { component: 'TRACK_B' },
        );
      continue;
    }

    // 물타기 조건: 평단가 대비 하락률이 트리거 이하 + 횟수 미달
    // + 이미 대기 중인 BUY 주문 없어야 함 (count는 체결 후 업데이트 → 중복 방지)
    if (avgDownTrigger !== 0 && pnlPct <= avgDownTrigger && chain.current_averaging_count < chain.max_averaging_count) {
      let hasPendingBuy = false;
      try {
        const { rows: pendingRows } = await getPool().query(
          `SELECT 1 FROM orders WHERE chain_id = $1 AND side = 'BUY' AND status IN ('PENDING','OPEN','SUBMITTED') LIMIT 1`,
          [chain.id],
        );
        hasPendingBuy = pendingRows.length > 0;
      } catch {
        /* DB 오류 시 안전하게 허용 */
      }
      if (hasPendingBuy) {
        logger.info(`  ⏳ ${chain.stock_code}: 미체결 BUY 주문 존재 → 물타기 중복 차단`, { component: 'TRACK_B' });
        continue;
      }
      // 물타기 후 총 비중이 Hard Cap 25%를 넘지 않도록 잔여 한도 계산
      const maxAllowedValue = (totalAssets ?? 0) * 0.25;
      const remainingRoom = Math.max(0, maxAllowedValue - positionValue);
      const avgDownSize = Math.min(effectiveMaxPos / splitCount, cash / 4, remainingRoom);
      // 물타기 최소 금액: effectiveMaxPos의 5% 또는 1만원 중 큰 값 (고정금액 제거)
      const minAvgDownSize = Math.max(10_000, effectiveMaxPos * 0.05);
      if (avgDownSize >= minAvgDownSize) {
        const qty = Math.floor(avgDownSize / price.currentPrice);
        if (qty > 0) {
          decisions.push({
            action: 'AVERAGE_DOWN',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `기술적 물타기: 평단가 대비 ${pnlPct.toFixed(1)}% (트리거 ${avgDownTrigger}%) | ${chain.current_averaging_count + 1}/${chain.max_averaging_count}차`,
            confidence: 0.7,
          });
          cash -= qty * price.currentPrice;
        }
      }
    }
  }

  return decisions;
}
