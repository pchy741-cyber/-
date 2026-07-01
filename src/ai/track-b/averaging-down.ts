import { analyzeTechnicals } from '../../analysis/indicators.js';
import { INVERSE_ETF_CODES } from '../../automation/crash-profit.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { resolveStrategyParams, type TechnicalFallbackParams } from './technical-fallback-types.js';
import { MEGA_CAP_PRIORITY_CODES } from './trading-rules.js';

// v20: 물타기(진짜 averaging-down, ScaleIn 분할진입과는 다름) 강제 활성화 제거.
// 근거 — 최근 30일 253건 데이터 전수조사: 1회 물타기는 승률 30%, 손실발생률 70%,
// 평균손실 337,953원(물타기 없는 거래의 6배)으로 명백한 "손실 확대 함정"이었음.
// 2회 물타기가 좋아 보였던 건(+275,124원/건) 표본 15건 중 단일 대성공(000890, +346만원) 편중—
// 그 트레이드가 이후 나흘간 -770만원 boom-bust의 도화선이 된 바로 그 케이스임.
// 메가캡(삼성/SK하이닉스)도 "물타기=수익공식"이 아니라 실제로는 SK하이닉스 물타기 2회 사례가 손실(-38,865원).
// → strategyParams.averageDownPct(SWING=0)를 그대로 존중, paper/메가캡 강제 오버라이드 제거.
const PAPER_SL_WIDENED = -3.5;       // 물타기 공간 확보용 SL (재활성화 대비 보존)

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
  const isPaper = getCtxIsPaper();
  const decisions: TradeDecision[] = [];
  let cash = remainingCash;

  for (const chain of openChains) {
    // 인버스 ETF는 crash-profit.ts가 단독 관리 — 물타기 로직 건너뜀
    if (INVERSE_ETF_CODES.has(chain.stock_code)) continue;
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // v20: 메가캡/paper 강제 물타기 오버라이드 제거 — 데이터로 반증됨 (SK하이닉스 물타기 2회 사례도 손실).
    // strategyParams.averageDownPct 그대로 존중 (SWING=0 → 물타기 비활성).
    const isMegaCap = MEGA_CAP_PRIORITY_CODES.has(chain.stock_code);
    const avgDownTrigger = strategyParams.averageDownPct;

    // 물타기 차단: 익절 진행 중 체인 or SMA20 아래 깊은 하락
    const chainCandles = chartData.get(chain.stock_code);
    const chainTech = chainCandles ? analyzeTechnicals(chainCandles) : null;
    // 대형주: SMA20 -5% 이탈만 차단 (일반: -3%)
    const sma20DeepThreshold = isMegaCap ? 0.95 : 0.97;
    const isBelowSma20Deep = chainTech ? price.currentPrice < chainTech.sma20 * sma20DeepThreshold : false;
    // 하드 손실 한도: 대형주 -10%, 일반 -8%
    const deepUnderwaterLimit = isMegaCap ? -10.0 : -8.0;
    const isTooDeepUnderwater = pnlPct <= deepUnderwaterLimit;
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
    // v20: 메가캡 반등신호 면제 제거 — SK하이닉스 물타기 2회 실사례도 손실로 끝나 "대형주=항상 반등" 전제가 반증됨
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
    // v20: 강제 오버라이드 제거 — 체인에 설정된 max_averaging_count 그대로 존중
    const effectiveMaxAvgCount = chain.max_averaging_count;
    if (avgDownTrigger !== 0 && pnlPct <= avgDownTrigger && chain.current_averaging_count < effectiveMaxAvgCount) {
      let hasPendingBuy = false;
      try {
        const { rows: pendingRows } = await getPool().query(
          `SELECT 1 FROM orders WHERE chain_id = $1 AND side = 'BUY' AND status IN ('PENDING','OPEN','SUBMITTED') LIMIT 1`,
          [chain.id],
        );
        hasPendingBuy = pendingRows.length > 0;
      } catch {
        // v10.11.2: DB 오류 시 물타기 차단 (기존: 허용 → 더블 오더 위험)
        hasPendingBuy = true;
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
          // paper 물타기 시: SL이 -3.5%보다 타이트하면 넓혀서 SL 조기 발동 방지
          if (isPaper && !isMegaCap) {
            const currentSl = Number(chain.stop_loss_pct ?? -3.0);
            if (currentSl > PAPER_SL_WIDENED) {
              try {
                await getPool().query(
                  `UPDATE transaction_chains SET stop_loss_pct = $1 WHERE id = $2`,
                  [PAPER_SL_WIDENED, chain.id],
                );
                logger.info(
                  `  📐 ${chain.stock_code}: paper SL ${currentSl}% → ${PAPER_SL_WIDENED}% (물타기 공간 확보)`,
                  { component: 'TRACK_B' },
                );
              } catch (e: any) {
                logger.warn(`  ⚠️ ${chain.stock_code}: SL 업데이트 실패 — ${e.message}`, { component: 'TRACK_B' });
              }
            }
          }
          decisions.push({
            action: 'AVERAGE_DOWN',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `기술적 물타기: 평단가 대비 ${pnlPct.toFixed(1)}% (트리거 ${avgDownTrigger}%) | ${chain.current_averaging_count + 1}/${effectiveMaxAvgCount}차${isPaper ? ' [paper]' : ''}`,
            confidence: 0.7,
          });
          cash -= qty * price.currentPrice;
        }
      }
    }
  }

  return decisions;
}
