import { getActiveWatchlist } from '../../db/client.js';
import { getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
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
  const watchlist = await getActiveWatchlist();
  const signals: SniperSignal[] = [];

  for (const stock of watchlist) {
    try {
      const chart = await getDailyChart(stock.stock_code, 60); // Need 60 for MA60
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
      // 1. 상승 추세 확인 (20일선 > 60일선)
      const isInUptrend = ma20 > ma60;

      if (isInUptrend) {
        // 2. 최근 30일 내 고점 찾기 (오늘 제외)
        const recent30dChart = chart.slice(1, 31);
        const peak = recent30dChart.reduce((p, c) => (c.high > p.high ? c : p), { high: 0, date: '' });
        const peakIndex = recent30dChart.findIndex((c) => c.date === peak.date);

        // 3. 눌림 조건 확인
        const dropFromHigh = ((current - peak.high) / peak.high) * 100;
        const isMeaningfulPullback =
          peak.high > 0 &&
          peakIndex >= 3 && // 고점이 최소 3일 전
          dropFromHigh >= -20 &&
          dropFromHigh <= -8; // -8% ~ -20% 하락

        if (isMeaningfulPullback) {
          // 4. 반등 조건 확인
          const isBullishCandle = today.close > today.open;
          const avgVolume20d = calcAvgVolume(volumes.slice(1), 20); // 오늘 제외
          const volumeRatio = avgVolume20d > 0 ? todayVolume / avgVolume20d : 0;
          const isVolumeSpike = volumeRatio >= 1.8; // 거래량 1.8배 이상

          // 5. 강한 반등 신호 확인 (하단 꼬리)
          const candleRange = today.high - today.low;
          const lowerWickRatio = candleRange > 0 ? (Math.min(today.open, today.close) - today.low) / candleRange : 0;
          const isStrongBounceCandle = lowerWickRatio > 0.4; // 캔들 길이의 40% 이상이 아래 꼬리

          if (isBullishCandle && isVolumeSpike) {
            // 6. 신뢰도 및 투자 배수 동적 계산
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

            // 지지선 근처에서 반등했는지 확인
            const isNearMa20 = Math.abs((current - ma20) / ma20) < 0.02; // 20일선 2% 이내
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

        // 1. 거래량 조건
        if (volumeRatio >= 1.5) {
          let confidence = 0.7;
          let multiplier = 1.1;
          const reasons = [`5일선(${ma5.toFixed(0)})이 20일선(${ma20.toFixed(0)}) 상향 돌파`];

          // 2. 거래량에 따른 가산점
          if (volumeRatio >= 3.0) {
            confidence += 0.1;
            multiplier = 1.3;
            reasons.push(`거래량 ${volumeRatio.toFixed(1)}배 폭발`);
          } else {
            reasons.push(`거래량 ${volumeRatio.toFixed(1)}배 동반`);
          }

          // 3. 정배열 초기/진행 확인
          if (ma20 > ma60) {
            confidence += 0.08;
            reasons.push('정배열 추세');
          }

          // 4. RSI 모멘텀 확인
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

      await new Promise((r) => setTimeout(r, 200));
    } catch (error) {
      logger.warn(`기술적 패턴 스캔 실패 (${stock.stock_name}): ${error}`, { component: 'SNIPER' });
    }
  }

  if (signals.length > 0) {
    logger.info(`📊 기술적 패턴 시그널: ${signals.length}개`, { component: 'SNIPER' });
  }

  return signals;
}
