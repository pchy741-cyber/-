/**
 * 멀티 타임프레임 합류 분석
 * 주봉/일봉/4시간봉 방향 일치 여부로 진입 신뢰도 판단
 */

import { sma } from '../../analysis/indicators.js';
import { getOverseasDailyChart } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';

// ── 타입 ──

export type TimeframeDirection = 'UP' | 'DOWN' | 'NEUTRAL';

export interface MultiTFResult {
  code: string;
  weekly: TimeframeDirection;
  daily: TimeframeDirection;
  h4: TimeframeDirection; // 4시간봉 (일봉 데이터로 추정)
  confluence: number; // 0~3 (UP 방향 일치 수)
  confidenceBonus: number; // 0, +0.05, +0.10
  blocked: boolean; // confluence < 2이면 차단
}

// ── 캐시 (30분 TTL) ──

const cache = new Map<string, { result: MultiTFResult; expires: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30분

function getCached(code: string): MultiTFResult | null {
  const entry = cache.get(code);
  if (!entry || Date.now() > entry.expires) {
    cache.delete(code);
    return null;
  }
  return entry.result;
}

function setCache(code: string, result: MultiTFResult): void {
  cache.set(code, { result, expires: Date.now() + CACHE_TTL });
}

// ── 방향 판단 헬퍼 ──

function direction(current: number, reference: number, threshold: number): TimeframeDirection {
  const pct = ((current - reference) / reference) * 100;
  if (pct > threshold) return 'UP';
  if (pct < -threshold) return 'DOWN';
  return 'NEUTRAL';
}

// ── 메인 ──

/**
 * 단일 종목 멀티 타임프레임 분석
 * - weekly: 최근 종가 vs 20일 전 종가 (±2%)
 * - daily:  최근 종가 vs 5일 SMA (±1%)
 * - h4:     최근 2일 추세 close[0] vs close[1] (±0.5%)
 */
export async function analyzeMultiTimeframe(code: string, exchange: string): Promise<MultiTFResult> {
  // 캐시 확인
  const cached = getCached(code);
  if (cached) return cached;

  const candles = await getOverseasDailyChart(code, exchange, 60);

  if (candles.length < 21) {
    logger.warn(`[MultiTF] ${code}: 데이터 부족 (${candles.length}일)`);
    const fallback: MultiTFResult = {
      code,
      weekly: 'NEUTRAL',
      daily: 'NEUTRAL',
      h4: 'NEUTRAL',
      confluence: 2,
      confidenceBonus: 0.05,
      blocked: false,
    };
    setCache(code, fallback);
    return fallback;
  }

  // 캔들은 최신순 (index 0 = 최근)
  const closes = candles.map((c) => c.close);

  // weekly: 최근 종가 vs 20일(4주) 전 종가
  const weekly = direction(closes[0], closes[Math.min(19, closes.length - 1)], 2);

  // daily: 최근 종가 vs 5일 SMA
  const sma5 = sma(closes.slice(0, 5), 5);
  const daily = sma5.length > 0 ? direction(closes[0], sma5[0], 1) : ('NEUTRAL' as TimeframeDirection);

  // h4: 최근 2일 추세 (close[0] vs close[1])
  const h4 = closes.length >= 2 ? direction(closes[0], closes[1], 0.5) : ('NEUTRAL' as TimeframeDirection);

  // 합류도: UP 방향 일치 수
  const confluence = [weekly, daily, h4].filter((d) => d === 'UP').length;
  const confidenceBonus = confluence >= 3 ? 0.1 : confluence >= 2 ? 0.05 : 0;
  const blocked = confluence < 2;

  const result: MultiTFResult = {
    code,
    weekly,
    daily,
    h4,
    confluence,
    confidenceBonus,
    blocked,
  };

  setCache(code, result);

  if (blocked) {
    logger.debug(`[MultiTF] ${code} 차단 — W:${weekly} D:${daily} H4:${h4} (confluence=${confluence})`);
  }

  return result;
}

// ── 배치 처리 ──

/**
 * 여러 종목 배치 분석 (4개씩 병렬)
 * 에러 시 해당 종목 스킵 (기본값: confluence=2, blocked=false)
 */
export async function batchMultiTF(stocks: { code: string; exchange: string }[]): Promise<Map<string, MultiTFResult>> {
  const results = new Map<string, MultiTFResult>();
  const BATCH_SIZE = 4;

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((s) => analyzeMultiTimeframe(s.code, s.exchange)));

    for (let j = 0; j < settled.length; j++) {
      const stock = batch[j];
      const outcome = settled[j];

      if (outcome.status === 'fulfilled') {
        results.set(stock.code, outcome.value);
      } else {
        logger.warn(`[MultiTF] ${stock.code} 분석 실패: ${outcome.reason}`);
        results.set(stock.code, {
          code: stock.code,
          weekly: 'NEUTRAL',
          daily: 'NEUTRAL',
          h4: 'NEUTRAL',
          confluence: 2,
          confidenceBonus: 0.05,
          blocked: false,
        });
      }
    }
  }

  logger.info(
    `[MultiTF] ${results.size}개 종목 분석 완료 — 차단 ${Array.from(results.values()).filter((r) => r.blocked).length}개`,
  );
  return results;
}
