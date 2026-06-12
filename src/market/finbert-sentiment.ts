/**
 * 🤖 Hugging Face FinBERT — 금융 뉴스 sentiment 분석 (Gemini 별도)
 *
 * 무료: https://huggingface.co/settings/tokens (Read access)
 * 모델: ProsusAI/finbert (금융 sentiment 특화)
 *
 * Gemini 미관여 — Track A 점수 ensemble에 합치지 않음.
 * 별도 독립 신호로만 노출 (caller가 원하면 사용)
 *
 * 활용:
 *  - 뉴스 헤드라인 → positive/negative/neutral 분류
 *  - 결정의 보조 컨텍스트 (강제 점수 영향 X)
 */

import { logger } from '../utils/logger.js';

const COMP = 'FINBERT';
const HF_URL = 'https://api-inference.huggingface.co/models/ProsusAI/finbert';

export interface FinBertResult {
  label: 'positive' | 'negative' | 'neutral';
  score: number; // 0-1 신뢰도
  /** -1 (강한 부정) ~ +1 (강한 긍정) */
  signedScore: number;
}

const _cache = new Map<string, { data: FinBertResult; ts: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

export async function analyzeSentiment(text: string): Promise<FinBertResult | null> {
  if (!process.env.HF_API_KEY) {
    logger.debug('HF_API_KEY 미설정 — FinBERT 스킵', { component: COMP });
    return null;
  }
  if (!text || text.length < 10) return null;
  // 캐시: text 해시 대신 첫 100자 사용 (대략)
  const cacheKey = text.slice(0, 100);
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  try {
    const res = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text.slice(0, 512) }), // 512 토큰 제한
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.debug(`FinBERT HTTP ${res.status}`, { component: COMP });
      return null;
    }
    const data = (await res.json()) as Array<Array<{ label: string; score: number }>>;
    const arr = data[0] ?? [];
    if (arr.length === 0) return null;
    // 가장 높은 confidence
    const top = arr.reduce((max, cur) => (cur.score > max.score ? cur : max), arr[0]);
    const label = (top.label?.toLowerCase() as FinBertResult['label']) ?? 'neutral';
    const signedScore = label === 'positive' ? top.score : label === 'negative' ? -top.score : 0;
    const result: FinBertResult = { label, score: top.score, signedScore };
    _cache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (e) {
    logger.debug(`FinBERT 실패: ${(e as Error).message}`, { component: COMP });
    return null;
  }
}

/** 여러 헤드라인 평균 sentiment */
export async function analyzeBatchSentiment(headlines: string[]): Promise<FinBertResult | null> {
  if (headlines.length === 0) return null;
  const results: FinBertResult[] = [];
  for (const h of headlines.slice(0, 10)) {
    const r = await analyzeSentiment(h);
    if (r) results.push(r);
    // HF free tier rate limit 보호 (1초당 1개)
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (results.length === 0) return null;
  const avgSigned = results.reduce((s, r) => s + r.signedScore, 0) / results.length;
  const label: FinBertResult['label'] = avgSigned > 0.2 ? 'positive' : avgSigned < -0.2 ? 'negative' : 'neutral';
  return {
    label,
    score: Math.abs(avgSigned),
    signedScore: avgSigned,
  };
}
