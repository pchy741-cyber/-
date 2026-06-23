import { getActiveWatchlist } from '../../db/client.js';
import { getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
// sleep import 제거 — getDailyChart 내부 rate limiter가 스로틀링 처리
import { emitSniperSignal, type SniperSignal } from './index.js';

/**
 * 📊 기술적 패턴 스나이퍼
 *
 * 1. 눌림목 반등 (Pullback Bounce)
 *    - 최근 고점 대비 -10~15% 하락 + 악재 없음
 *    - 당일 거래량이 20일 평균의 2배 이상 + 양봉
 *    - "싸게 떨어진 걸 기관이 주워먹는 중"
 *    - 확률: 75~85%
 *
 * 2. 골든크로스 + 거래량 동반
 *    - 5일 이동평균이 20일 이동평균을 상향 돌파
 *    - 동시에 거래량 급증 (평균 대비 150%+)
 *    - "추세 전환 확정" 시그널
 *    - 확률: 70~80%
 */

function calcMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  return prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
}

function calcAvgVolume(volumes: number[], period: number): number {
  if (volumes.length < period) return 0;
  return volumes.slice(0, period).reduce((s, v) => s + v, 0) / period;
}

// Simplified RSI calculation for the most recent period
function calcRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50; // Not enough data, return neutral

  let gains = 0;
  let losses = 0;

  // prices are reversed (newest first), so we go from i=1 to period
  // price[i-1] is newer than price[i]
  for (let i = 1; i <= period; i++) {
    const change = prices[i - 1] - prices[i];
    if (change > 0) {
      gains += change;
    } else {
      losses -= change; // losses are positive values
    }
  }

  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

export async function scanTechnicalPatterns(): Promise<SniperSignal[]> {
  const allWatchlist = await getActiveWatchlist();
  // 전체 워치리스트 스캔 (최대 60종목, rate limit 보호)
  const watchlist = allWatchlist.slice(0, 60);
  const signals: SniperSignal[] = [];

  // 병렬 차트 조회 (getDailyChart 내부 rate limiter 의존)
  const chartResults = await Promise.allSettled(
    watchlist.map(async (stock) => ({
      stock,
      chart: await getDailyChart(stock.stock_code, 60),
    })),
  );

  for (const r of chartResults) {
    if (r.status !== 'fulfilled') continue;
    const { stock, chart } = r.value;
    try {
      if (chart.length < 60) continue;

      const prices = chart.map((c) => c.close);
      const volumes = chart.map((c) => c.volume);
      const today = chart[0];
      const current = today.close;
      const todayVolume = today.volume;

      // -- 이동평균선 계산 --
      const ma5 = calcMA(prices, 5);
      const ma20 = calcMA(prices, 20);
      const ma60 = calcMA(prices, 60);

      // ── 눌림목 반등 감지 (개선된 로직) ──
      const isInUptrend = ma20 > ma60;

      if (isInUptrend) {
        const recent30dChart = chart.slice(1, 31);
        const peak = recent30dChart.reduce((p, c) => (c.high > p.high ? c : p), { high: 0, date: '' });
        const peakIndex = recent30dChart.findIndex((c) => c.date === peak.date);

        const dropFromHigh = ((current - peak.high) / peak.high) * 100;
        const isMeaningfulPullback =
          peak.high > 0 && peakIndex >= 3 && dropFromHigh >= -20 && dropFromHigh <= -8;

        if (isMeaningfulPullback) {
          const isBullishCandle = today.close > today.open;
          const avgVolume20d = calcAvgVolume(volumes.slice(1), 20);
          const volumeRatio = avgVolume20d > 0 ? todayVolume / avgVolume20d : 0;
          const isVolumeSpike = volumeRatio >= 1.8;

          const candleRange = today.high - today.low;
          const lowerWickRatio = candleRange > 0 ? (Math.min(today.open, today.close) - today.low) / candleRange : 0;
          const isStrongBounceCandle = lowerWickRatio > 0.4;

          if (isBullishCandle && isVolumeSpike) {
            let confidence = 0.75;
            let multiplier = 1.2;
            const reasons = [`고점 대비 ${dropFromHigh.toFixed(1)}% 눌림`];

            if (isStrongBounceCandle) {
              confidence += 0.08;
              reasons.push('강한 아래꼬리 양봉');
            } else {
              reasons.push('양봉 반등');
            }

            if (volumeRatio >= 2.5) {
              confidence += 0.05;
              multiplier = 1.3;
              reasons.push(`거래량 ${volumeRatio.toFixed(1)}배 폭발`);
            } else {
              reasons.push(`거래량 ${volumeRatio.toFixed(1)}배 동반`);
            }

            const isNearMa20 = Math.abs((current - ma20) / ma20) < 0.02;
            if (isNearMa20) {
              confidence += 0.07;
              reasons.push('20일선 지지');
            }

            const signal: SniperSignal = {
              stockCode: stock.stock_code,
              stockName: stock.stock_name,
              type: 'PULLBACK_BOUNCE',
              confidence: Math.min(0.95, confidence),
              budgetMultiplier: multiplier,
              reasoning: reasons.join(' + '),
              detectedAt: new Date().toISOString(),
            };
            signals.push(signal);
            await emitSniperSignal(signal);
          }
        }
      }

      // ── 골든크로스 + 거래량 감지 ──
      const ma5Yesterday = calcMA(prices.slice(1), 5);
      const ma20Yesterday = calcMA(prices.slice(1), 20);

      const goldenCrossToday = ma5 > ma20;
      const notGoldenYesterday = ma5Yesterday <= ma20Yesterday;
      const isNewGoldenCross = goldenCrossToday && notGoldenYesterday;

      if (isNewGoldenCross) {
        const avgVolume20d = calcAvgVolume(volumes.slice(1), 20);
        const volumeRatio = avgVolume20d > 0 ? todayVolume / avgVolume20d : 0;

        if (volumeRatio >= 1.5) {
          let confidence = 0.7;
          let multiplier = 1.1;
          const reasons = [`5일선(${ma5.toFixed(0)})이 20일선(${ma20.toFixed(0)}) 상향 돌파`];

          if (volumeRatio >= 3.0) {
            confidence += 0.1;
            multiplier = 1.3;
            reasons.push(`거래량 ${volumeRatio.toFixed(1)}배 폭발`);
          } else {
            reasons.push(`거래량 ${volumeRatio.toFixed(1)}배 동반`);
          }

          if (ma20 > ma60) {
            confidence += 0.08;
            reasons.push('정배열 추세');
          }

          const rsi = calcRSI(prices, 14);
          if (rsi > 55 && rsi < 75) {
            confidence += 0.05;
            reasons.push(`RSI ${rsi.toFixed(1)} 상승 모멘텀`);
          }

          const signal: SniperSignal = {
            stockCode: stock.stock_code,
            stockName: stock.stock_name,
            type: 'GOLDEN_CROSS_VOLUME',
            confidence: Math.min(0.95, confidence),
            budgetMultiplier: multiplier,
            reasoning: reasons.join(' + '),
            detectedAt: new Date().toISOString(),
          };
          signals.push(signal);
          await emitSniperSignal(signal);
        }
      }
    } catch (error) {
      logger.warn(`기술적 패턴 스캔 실패 (${stock.stock_name}): ${error}`, { component: 'SNIPER' });
    }
  }

  if (signals.length > 0) {
    logger.info(`📊 기술적 패턴 시그널: ${signals.length}개`, { component: 'SNIPER' });
  }

  return signals;
}
