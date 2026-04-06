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

const SCORE_TTL = 60 * 60 * 4; // 4시간 (12시간→4시간 단축: stale 데이터 방지)

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

export async function cachePrice(stockCode: string, price: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(`price:${stockCode}`, price, { ex: PRICE_TTL });
}

export async function getCachedPrice(stockCode: string): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  const val = await r.get<number>(`price:${stockCode}`);
  return val;
}
