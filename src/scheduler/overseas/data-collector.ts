/**
 * 해외주식 시세 + 차트 병렬 수집
 * (overseas-job.ts에서 추출)
 */
import { analyzeTechnicals, type OHLCV } from '../../analysis/indicators.js';
import { getOverseasDailyChart, getOverseasPrice } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import type { TechResult } from './sell-logic.js';
import { getSessionCache, type SessionCache, setSessionCache } from './session.js';
import { GLOBAL_WATCHLIST } from './watchlist.js';

export interface CollectTechDataParams {
  activeStocks: typeof GLOBAL_WATCHLIST;
  region: 'US' | 'ASIA';
  isNewSession: boolean;
}

export async function collectTechData(params: CollectTechDataParams): Promise<TechResult[]> {
  const { activeStocks, region, isNewSession } = params;
  const techResults: TechResult[] = [];

  const BATCH = 8;
  for (let i = 0; i < activeStocks.length; i += BATCH) {
    const batch = activeStocks.slice(i, i + BATCH);
    const latestCache = getSessionCache(region);
    const settled = await Promise.allSettled(
      batch.map(async (stock) => {
        const price = await getOverseasPrice(stock.code, stock.exchange);
        const cached = latestCache?.techCache.get(stock.code);
        const chart = cached ? null : await getOverseasDailyChart(stock.code, stock.exchange, 40);
        return { stock, price, chart, cached };
      }),
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      const { stock, price, chart, cached } = result.value;
      if (price.currentPrice <= 0) continue;

      const dayRange = price.dayHigh - price.dayLow;
      const dayRangePct = dayRange > 0 ? ((price.currentPrice - price.dayLow) / dayRange) * 100 : 50;
      const isMomentum = price.changePct >= 3 && dayRangePct >= 60;
      const isBigMover = price.changePct >= 5;

      let signal: string,
        score: number,
        rsi: number,
        adx: number,
        trendStrength: string,
        aboveMA20: boolean,
        aboveMA60: boolean;
      let bollingerSqueeze: boolean, bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
      let atrPct: number;
      let vwapPosition: 'ABOVE' | 'BELOW' | 'AT' = 'AT';

      if (cached) {
        ({ signal, score, rsi, adx, trendStrength, aboveMA20, aboveMA60, bollingerSqueeze, bollingerBreakout } =
          cached);
        atrPct = cached.atrPct ?? 2.0;
        vwapPosition = cached.vwapPosition ?? 'AT';
      } else {
        if (!chart || chart.length < 30) continue;
        const candles: OHLCV[] = chart.map((c) => ({
          date: c.date,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));
        const tech = analyzeTechnicals(candles);
        if (!tech) continue;
        signal = tech.overallSignal;
        score = tech.score;
        rsi = tech.rsi14;
        adx = tech.adx14;
        trendStrength = tech.trendStrength;
        aboveMA20 = price.currentPrice > tech.sma20;
        aboveMA60 = price.currentPrice > tech.sma60;
        bollingerSqueeze = tech.bollingerSqueeze;
        bollingerBreakout = tech.bollingerBreakout;
        atrPct = tech.atrPct;
        vwapPosition = tech.vwapPosition;
      }

      // 최근 5일 저점 — 캐시 미사용 시 chart 데이터에서 직접 계산
      const prevLow5d = !cached && chart && chart.length >= 5
        ? Math.min(...chart.slice(-5).map((c) => c.low))
        : undefined;

      if (isNewSession) {
        const cacheTarget = getSessionCache(region);
        if (cacheTarget) {
          cacheTarget.techCache.set(stock.code, {
            score,
            rsi,
            adx,
            signal,
            trendStrength,
            isMomentum,
            dayRangePct,
            aboveMA20,
            aboveMA60,
            bollingerSqueeze,
            bollingerBreakout,
            atrPct,
            vwapPosition,
          });
        }
      }

      techResults.push({
        code: stock.code,
        name: stock.name,
        exchange: stock.exchange,
        sector: stock.sector,
        price,
        signal,
        score,
        rsi,
        adx,
        trendStrength,
        dayRangePct,
        isMomentum,
        isBigMover,
        aboveMA20,
        aboveMA60,
        bollingerSqueeze,
        bollingerBreakout,
        atrPct,
        vwapPosition,
        prevLow5d,
      });
      logger.info(
        `  ${stock.code}: $${price.currentPrice} ${price.changePct >= 0 ? '+' : ''}${price.changePct}% | ${signal}(${score}) RSI=${rsi.toFixed(0)} ADX=${adx.toFixed(0)} 일중${dayRangePct.toFixed(0)}%${isBigMover ? ' 🔥빅무버' : isMomentum ? ' 🚀모멘텀' : ''}${bollingerSqueeze ? (bollingerBreakout === 'UP' ? ' 💥BB↑' : bollingerBreakout === 'DOWN' ? ' 💥BB↓' : ' 🔧BBsq') : ''}${cached ? ' [캐시]' : ''}`,
        { component: 'OVERSEAS' },
      );
    }

    if (i + BATCH < activeStocks.length) {
      await sleep(100);
    }
  }

  return techResults;
}

/** 세션 캐시 초기화 — 새 세션일 때 topCodes + techCache 생성 */
export function buildSessionCache(
  techResults: TechResult[],
  isUSSession: boolean,
  sessionId: string,
  region: 'US' | 'ASIA',
  topCount: number,
  regionFlags: string,
): void {
  const sorted = [...techResults].sort((a, b) => {
    const sa = a.score + (a.isMomentum ? 30 : 0);
    const sb = b.score + (b.isMomentum ? 30 : 0);
    return sb - sa;
  });
  const topCodes = sorted.slice(0, topCount).map((t) => t.code);
  const techCacheMap = new Map<
    string,
    {
      score: number;
      rsi: number;
      adx: number;
      signal: string;
      trendStrength: string;
      isMomentum: boolean;
      dayRangePct: number;
      aboveMA20: boolean;
      aboveMA60: boolean;
      bollingerSqueeze: boolean;
      bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
      atrPct: number;
      vwapPosition?: 'ABOVE' | 'BELOW' | 'AT';
    }
  >();
  for (const t of techResults) {
    techCacheMap.set(t.code, {
      score: t.score,
      rsi: t.rsi,
      adx: t.adx,
      signal: t.signal,
      trendStrength: t.trendStrength,
      isMomentum: t.isMomentum,
      dayRangePct: t.dayRangePct,
      aboveMA20: t.aboveMA20,
      aboveMA60: t.aboveMA60,
      bollingerSqueeze: t.bollingerSqueeze,
      bollingerBreakout: t.bollingerBreakout,
      atrPct: t.atrPct,
      vwapPosition: t.vwapPosition,
    });
  }
  const newCache: SessionCache = { topCodes, sessionDate: sessionId, techCache: techCacheMap };
  setSessionCache(region, newCache);
  logger.info(`${regionFlags} 이번 세션 매수 후보: [${topCodes.join(', ')}] (score 기준 상위 ${topCount})`, {
    component: 'OVERSEAS',
  });
}
