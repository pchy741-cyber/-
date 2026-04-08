import { Redis } from '@upstash/redis';
import type { AIScore } from '../db/models.js';
import { logger } from '../utils/logger.js';

/**
 * Upstash Redis — 서버리스 초고속 캐시
 *
 * 용도:
 * - AI 스코어 캐싱 (Track A 산출 → Track B에서 ms 단위 조회)
 * - DB 쿼리 절감 (매 10분마다 Track B가 스코어 조회)
 * - 실시간 시세 캐싱 (KIS API 호출 절감)
 *
 * 비용: Upstash Free Tier = 10,000 요청/일 (충분)
 */

let redis: Redis | null = null;

export async function initRedisCache(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;

  if (!url || !token) {
    logger.info('Redis URL/Token 미설정 → DB fallback 모드', { component: 'CACHE' });
    return;
  }

  redis = new Redis({ url, token });

  // 연결 테스트
  await redis.ping();
  logger.info('✅ Upstash Redis 연결 성공', { component: 'CACHE' });
}

function getRedis(): Redis | null {
  return redis;
}

// ── AI 스코어 캐시 ──
// TTL: 4시간 (Track A가 07:30, 18:00에 실행하므로 4시간이면 충분)
// Track A 실패 시 stale 데이터 서빙 방지

const SCORE_TTL = 60 * 30; // 30분 (매매 후 빠른 갱신)

export async function cacheScores(scores: AIScore[]): Promise<void> {
  const r = getRedis();
  if (!r || scores.length === 0) return;

  const pipeline = r.pipeline();
  for (const score of scores) {
    const key = `score:${score.stock_code}:${score.score_date}`;
    pipeline.set(key, JSON.stringify(score), { ex: SCORE_TTL });
    // 최신 스코어 키도 갱신
    pipeline.set(`score:latest:${score.stock_code}`, JSON.stringify(score), { ex: SCORE_TTL });
  }
  await pipeline.exec();

  logger.info(`📦 Redis에 ${scores.length}개 스코어 캐싱 완료`, { component: 'CACHE' });
}

export async function getCachedScores(stockCodes: string[]): Promise<AIScore[]> {
  const r = getRedis();
  if (!r || stockCodes.length === 0) return [];

  const pipeline = r.pipeline();
  for (const code of stockCodes) {
    pipeline.get(`score:latest:${code}`);
  }

  const results = await pipeline.exec();
  const scores: AIScore[] = [];

  for (const result of results) {
    if (result) {
      try {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        scores.push(parsed as AIScore);
      } catch {
        /* skip invalid */
      }
    }
  }

  return scores;
}

// ── 실시간 시세 캐시 (KIS 호출 절감) ──

const PRICE_TTL = 10; // 10초 (거의 실시간이지만 중복 호출 방지)
const PRICE_FALLBACK_TTL = 60 * 60 * 2; // 2시간 — API 실패 시 최후 보루

export async function cachePrice(stockCode: string, price: number): Promise<void> {
  const r = getRedis();
  if (!r || price <= 0) return;
  const pipeline = r.pipeline();
  pipeline.set(`price:${stockCode}`, price, { ex: PRICE_TTL });
  pipeline.set(`price:last:${stockCode}`, price, { ex: PRICE_FALLBACK_TTL });
  await pipeline.exec();
}

export async function getCachedPrice(stockCode: string): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  const val = await r.get<number>(`price:${stockCode}`);
  return val;
}

/** API 실패 시 fallback — 마지막으로 성공한 가격 (최대 2시간 유효) */
export async function getLastKnownPrice(stockCode: string): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  return r.get<number>(`price:last:${stockCode}`);
}

/** 여러 종목의 마지막 가격을 한번에 조회 */
export async function getLastKnownPrices(stockCodes: string[]): Promise<Map<string, number>> {
  const r = getRedis();
  const map = new Map<string, number>();
  if (!r || stockCodes.length === 0) return map;
  const pipeline = r.pipeline();
  for (const code of stockCodes) pipeline.get(`price:last:${code}`);
  const results = await pipeline.exec();
  results.forEach((val, idx) => {
    if (val && Number(val) > 0) map.set(stockCodes[idx], Number(val));
  });
  return map;
}

// ── 매매 후 캐시 무효화 ──

/** 특정 종목의 가격+스코어 캐시를 즉시 무효화 (매매 체결 후 호출) */
export async function invalidateStockCache(stockCode: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const pipeline = r.pipeline();
  pipeline.del(`price:${stockCode}`);
  pipeline.del(`price:last:${stockCode}`);
  pipeline.del(`score:latest:${stockCode}`);
  await pipeline.exec();
  // 메모리 캐시도 무효화
  const { memCache } = await import('./memory.js');
  memCache.delete(`price:${stockCode}`);
  memCache.delete(`price:last:${stockCode}`);
  logger.info(`🗑️ 캐시 무효화: ${stockCode}`, { component: 'CACHE' });
}
