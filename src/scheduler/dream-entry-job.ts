/**
 * AI 극단 진입점 예약 시스템 (Dream Entry)
 *
 * 개념: AI가 매일 1회 (08:35) 각 감시종목의 "꿈의 매수가"와 "로또 매도가"를 계산
 * → 지정가 주문으로 예약 → 장중 AI 토큰 소모 0으로 극단적 기회 포착
 *
 * 바닥 매수가 (dream_buy): 기술적 지지선 + 거래량 프로파일 기반 극단 저점
 *   - 52주 최저가 부근 / Bollinger 하단 2σ / 최근 지지선
 *   - 도달 확률 5-10% → "개떡락" 시에만 체결 → 반등 수익 극대화
 *
 * 천장 매도가 (dream_sell): 보유종목의 극단적 목표가
 *   - 52주 최고가 돌파 + α / Bollinger 상단 2σ / 목표PER 기반
 *   - 도달 확률 5-10% → "로또" 수준 매도 → 수익 극대화
 *
 * 토큰 절약: 장중 3분 간격 Track B에서 매번 AI 호출하는 대신
 *            하루 1회 계산 후 지정가로 대기 → AI 비용 대폭 절감
 */

import { getCtxIsPaper } from '../config/context.js';
import { getActiveWatchlist, getOpenChains, getPool } from '../db/client.js';
import { type DailyCandle } from '../kis/market.js';
import { adjustToTickSize } from '../utils/money.js';
import { logSystemEvent } from '../utils/system-events.js';
import { logger } from '../utils/logger.js';

const COMP = 'DREAM_ENTRY';

export interface DreamEntry {
  stock_code: string;
  stock_name: string;
  dream_buy_price: number;   // 꿈의 매수가 (극단 저점)
  dream_sell_price: number;  // 로또 매도가 (극단 고점)
  current_price: number;
  buy_distance_pct: number;  // 현재가 대비 매수가까지 거리 (%)
  sell_distance_pct: number; // 현재가 대비 매도가까지 거리 (%)
  reasoning: string;
  calculatedAt: string;
}

// 최근 계산 결과 (프론트엔드 표시용)
let _dreamEntries: DreamEntry[] = [];
let _lastCalcAt: string | null = null;

export function getDreamEntries(): { entries: DreamEntry[]; calculatedAt: string | null } {
  return { entries: _dreamEntries, calculatedAt: _lastCalcAt };
}

/**
 * 차트 데이터 기반 극단 진입점 계산 (AI 호출 0)
 * 기술적 지표만으로 계산 → 토큰 비용 0
 */
function calcDreamPrices(
  candles: DailyCandle[],
  currentPrice: number,
): { dreamBuy: number; dreamSell: number; reasoning: string } | null {
  if (candles.length < 20) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  // 52주 고/저 (최대 250일)
  const w52High = Math.max(...highs.slice(0, 250));
  const w52Low = Math.min(...lows.slice(0, 250));

  // 20일 볼린저 밴드
  const ma20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  const stdDev = Math.sqrt(closes.slice(0, 20).reduce((s, c) => s + (c - ma20) ** 2, 0) / 20);
  const bband_lower = ma20 - 2 * stdDev;
  const bband_upper = ma20 + 2 * stdDev;

  // 최근 지지/저항선 (20일 내 최저/최고)
  const recent20Low = Math.min(...lows.slice(0, 20));
  const recent20High = Math.max(...highs.slice(0, 20));

  // 꿈의 매수가: 볼린저 하단, 최근 저점, 52주 저점 중 가장 보수적인 값
  // "진짜 개떡락" = 현재가 대비 -8% ~ -20% 구간
  const candidates = [bband_lower, recent20Low * 0.97, w52Low * 1.02].filter((p) => p > 0);
  const dreamBuy = Math.max(...candidates.filter((p) => p < currentPrice * 0.95));

  // 로또 매도가: 볼린저 상단, 최근 고점, 52주 고점 돌파
  const sellCandidates = [bband_upper, recent20High * 1.03, w52High * 1.02].filter((p) => p > 0);
  const dreamSell = Math.min(...sellCandidates.filter((p) => p > currentPrice * 1.05));

  if (!Number.isFinite(dreamBuy) || !Number.isFinite(dreamSell) || dreamBuy <= 0 || dreamSell <= 0) {
    return null;
  }

  const reasoning =
    `BB하단=${bband_lower.toLocaleString()} 20일저점=${recent20Low.toLocaleString()} ` +
    `52w저=${w52Low.toLocaleString()} | BB상단=${bband_upper.toLocaleString()} 52w고=${w52High.toLocaleString()}`;

  return { dreamBuy, dreamSell, reasoning };
}

/**
 * Dream Entry 계산 (하루 1회, 08:35에 실행)
 * AI 토큰 소모 0 — 순수 기술적 지표 계산
 */
export async function runDreamEntryCalc(): Promise<DreamEntry[]> {
  const isPaper = getCtxIsPaper();
  const entries: DreamEntry[] = [];

  try {
    const watchlist = await getActiveWatchlist();
    const krStocks = watchlist
      .filter((w: { stock_code: string }) => /^\d{6}$/.test(w.stock_code))
      .slice(0, 20);

    const { getDailyChart } = await import('../kis/market.js');

    for (const stock of krStocks) {
      try {
        const candles = await getDailyChart(stock.stock_code, 60);
        if (candles.length < 20) continue;

        const currentPrice = candles[0]?.close ?? 0;
        if (currentPrice <= 0) continue;

        const dream = calcDreamPrices(candles, currentPrice);
        if (!dream) continue;

        const dreamBuyAdj = adjustToTickSize(dream.dreamBuy);
        const dreamSellAdj = adjustToTickSize(dream.dreamSell);
        const buyDist = ((currentPrice - dreamBuyAdj) / currentPrice) * 100;
        const sellDist = ((dreamSellAdj - currentPrice) / currentPrice) * 100;

        // 거리가 너무 가깝거나 너무 먼 것은 제외
        if (buyDist < 3 || buyDist > 30 || sellDist < 3 || sellDist > 50) continue;

        entries.push({
          stock_code: stock.stock_code,
          stock_name: (stock as any).stock_name || stock.stock_code,
          dream_buy_price: dreamBuyAdj,
          dream_sell_price: dreamSellAdj,
          current_price: currentPrice,
          buy_distance_pct: +buyDist.toFixed(1),
          sell_distance_pct: +sellDist.toFixed(1),
          reasoning: dream.reasoning,
          calculatedAt: new Date().toISOString(),
        });
      } catch {
        // 개별 종목 실패는 스킵
      }
    }

    // DB 저장 (overseas_state 재활용)
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [`dream_entries_${isPaper ? 'paper' : 'live'}`, JSON.stringify(entries)],
      );
    } catch { /* DB 저장 실패 무시 */ }

    _dreamEntries = entries;
    _lastCalcAt = new Date().toISOString();

    logSystemEvent(
      'DreamEntry',
      'success',
      `${entries.length}종목 극단 진입점 계산 완료 (AI 토큰 0)`,
      { detail: entries.slice(0, 3).map((e) => `${e.stock_name}: 매수${e.dream_buy_price.toLocaleString()} 매도${e.dream_sell_price.toLocaleString()}`).join(' | ') },
    );

    logger.info(`✅ Dream Entry: ${entries.length}종목 극단 진입점 계산 (AI 토큰 $0)`, { component: COMP });
  } catch (err) {
    logger.error(`Dream Entry 계산 실패: ${err}`, { component: COMP });
  }

  return entries;
}
