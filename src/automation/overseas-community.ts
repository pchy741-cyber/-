/**
 * Overseas Community Sentinel — 해외주식 커뮤니티 감성 분석
 *
 * 데이터 소스:
 *   - StockTwits 공개 API (인증 불필요, 200req/hour)
 *   - Bullish/Bearish 감성 비율 자동 집계
 *
 * 핵심 원칙 (국내 community-sentinel.ts와 동일):
 *   - 커뮤니티 데이터 단독 매수 금지
 *   - 상방 가점 최대 +5, 하방 감점 최대 -15 (비대칭)
 *   - 원문/닉네임/개인정보 저장 금지 — 집계 통계만 유지
 *
 * Privacy: 원문 미저장. 저장 항목:
 *   - Bullish/Bearish 비율 (수치)
 *   - 메시지 수 (integer)
 *   - Z-score (수치)
 */

import { logger } from '../utils/logger.js';

const COMP = 'OS_COMMUNITY';

// ── Types ──

export interface OverseasCommunityResult {
  symbol: string;
  messageCount: number;       // 최근 메시지 수 (원문 미저장)
  bullishRatio: number;       // 0.0~1.0
  bearishRatio: number;       // 0.0~1.0
  mentionZ: number;           // 롤링 Z-score
  pumpKeywordHits: number;    // 펌프 키워드 매치 수
  blockEntry: boolean;        // 펌프 감지 시 진입 차단
  scoreAdj: number;           // -15 ~ +5
  fetchedAt: number;
}

// ── Pump/FOMO 키워드 (영어) ──

const PUMP_KEYWORDS_EN = [
  'guaranteed', 'moon', 'rocket', '🚀', 'lambo', 'free money',
  'can\'t lose', 'insider', '100x', '10x', 'short squeeze',
  'to the moon', 'diamond hands', 'YOLO', 'all in',
];

const BEARISH_KEYWORDS_EN = [
  'crash', 'dump', 'scam', 'fraud', 'overvalued', 'bubble',
  'bankrupt', 'worthless', 'ponzi', 'exit',
];

// ── 캐시 ──

const _cache = new Map<string, OverseasCommunityResult>();
const CACHE_TTL_MS = 90 * 60 * 1000; // 90분
const _mentionHistory = new Map<string, number[]>(); // symbol → rolling counts

// 만료 정리 (30분)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) _cache.delete(key);
  }
  if (_cache.size > 200) _cache.clear();
  if (_mentionHistory.size > 200) _mentionHistory.clear();
}, 30 * 60 * 1000).unref();

// ── StockTwits API ──

interface StockTwitsMessage {
  sentiment?: { basic: 'Bullish' | 'Bearish' | null };
  body: string;
}

async function fetchStockTwitsSentiment(symbol: string): Promise<{
  messageCount: number;
  bullishCount: number;
  bearishCount: number;
  pumpHits: number;
} | null> {
  try {
    const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'QuantOps/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { messages?: StockTwitsMessage[] };
    const messages = data.messages ?? [];
    if (messages.length === 0) return null;

    let bullishCount = 0;
    let bearishCount = 0;
    let pumpHits = 0;

    for (const msg of messages) {
      // 감성 집계 (원문 미저장)
      if (msg.sentiment?.basic === 'Bullish') bullishCount++;
      else if (msg.sentiment?.basic === 'Bearish') bearishCount++;

      // 펌프 키워드 매치 (원문 미저장, 집계만)
      const lower = msg.body?.toLowerCase() ?? '';
      for (const kw of PUMP_KEYWORDS_EN) {
        if (lower.includes(kw.toLowerCase())) {
          pumpHits++;
          break; // 메시지당 1회만 카운트
        }
      }
    }

    return { messageCount: messages.length, bullishCount, bearishCount, pumpHits };
  } catch (err) {
    logger.debug(`StockTwits 조회 실패 (${symbol}): ${err}`, { component: COMP });
    return null;
  }
}

// ── Z-score 계산 ──

function calcMentionZ(symbol: string, currentCount: number): number {
  const history = _mentionHistory.get(symbol) ?? [];
  history.push(currentCount);
  if (history.length > 50) history.splice(0, history.length - 50); // 최근 50개
  _mentionHistory.set(symbol, history);

  if (history.length < 5) return 0; // 데이터 부족
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
  const std = Math.sqrt(variance);
  if (std < 1) return 0;
  return (currentCount - mean) / std;
}

// ── 점수 조정 계산 ──

function computeScoreAdj(
  bullishRatio: number,
  bearishRatio: number,
  mentionZ: number,
  pumpHits: number,
  messageCount: number,
): { scoreAdj: number; blockEntry: boolean } {
  // 1. 펌프 감지 → 차단
  if (pumpHits >= 5 && mentionZ >= 3.0) {
    return { scoreAdj: -15, blockEntry: true };
  }
  if (pumpHits >= 3 && bullishRatio > 0.85 && mentionZ >= 2.5) {
    return { scoreAdj: -12, blockEntry: true };
  }

  // 2. 극단적 비관 (공포 시 역발상 기회이므로 감점만)
  if (bearishRatio > 0.7 && messageCount >= 10) {
    return { scoreAdj: -8, blockEntry: false };
  }

  // 3. 과열 (높은 언급 + 극단적 낙관)
  if (mentionZ >= 3.0 && bullishRatio > 0.8) {
    return { scoreAdj: -5, blockEntry: false };
  }

  // 4. 건전한 낙관 (적당한 언급 + 낙관 우위)
  if (bullishRatio > 0.55 && bullishRatio <= 0.8 && mentionZ < 2.5 && messageCount >= 5) {
    return { scoreAdj: bullishRatio > 0.65 ? 5 : 3, blockEntry: false };
  }

  // 5. 약한 낙관
  if (bullishRatio > 0.5 && messageCount >= 3) {
    return { scoreAdj: 2, blockEntry: false };
  }

  return { scoreAdj: 0, blockEntry: false };
}

// ── 메인 함수 ──

/**
 * 해외주식 커뮤니티 감성 배치 수집
 * @param symbols - 종목 심볼 배열 (e.g., ['NVDA', 'AAPL'])
 * @returns symbol → result 맵
 */
export async function fetchOverseasCommunity(
  symbols: string[],
): Promise<Map<string, OverseasCommunityResult>> {
  const results = new Map<string, OverseasCommunityResult>();
  const BATCH = 3; // StockTwits rate limit 준수

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(async (symbol) => {
        // 캐시 히트
        const cached = _cache.get(symbol);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          results.set(symbol, cached);
          return;
        }

        const data = await fetchStockTwitsSentiment(symbol);
        if (!data) return;

        const total = data.bullishCount + data.bearishCount;
        const bullishRatio = total > 0 ? data.bullishCount / total : 0.5;
        const bearishRatio = total > 0 ? data.bearishCount / total : 0.5;
        const mentionZ = calcMentionZ(symbol, data.messageCount);
        const { scoreAdj, blockEntry } = computeScoreAdj(
          bullishRatio, bearishRatio, mentionZ, data.pumpHits, data.messageCount,
        );

        const result: OverseasCommunityResult = {
          symbol,
          messageCount: data.messageCount,
          bullishRatio,
          bearishRatio,
          mentionZ,
          pumpKeywordHits: data.pumpHits,
          blockEntry,
          scoreAdj,
          fetchedAt: Date.now(),
        };

        _cache.set(symbol, result);
        results.set(symbol, result);
      }),
    );

    // 배치 간 딜레이 (rate limit 방지)
    if (i + BATCH < symbols.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 로깅
  const significant = [...results.values()].filter((r) => r.scoreAdj !== 0 || r.blockEntry);
  if (significant.length > 0) {
    logger.info(
      `🌐 OS Community ${results.size}종목: ${significant.map((r) => `${r.symbol}(Z=${r.mentionZ.toFixed(1)},bull=${(r.bullishRatio * 100).toFixed(0)}%,adj=${r.scoreAdj > 0 ? '+' : ''}${r.scoreAdj}${r.blockEntry ? ',BLOCK' : ''})`).join(' ')}`,
      { component: COMP },
    );
  }

  return results;
}

// ── Pipeline 연동 함수 ──

/** 해외 파이프라인 점수 조정용 (캐시 미스 → 0) */
export function getOverseasCommunityAdj(symbol: string): number {
  const cached = _cache.get(symbol);
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return 0;
  return Math.max(-15, Math.min(5, cached.scoreAdj));
}

/** 해외 펌프 차단 여부 */
export function isOverseasPumpBlocked(symbol: string): boolean {
  const cached = _cache.get(symbol);
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return false;
  return cached.blockEntry;
}

/** 캐시된 결과 조회 (대시보드용) */
export function getOverseasCommunityResult(symbol: string): OverseasCommunityResult | null {
  const cached = _cache.get(symbol);
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  return cached;
}
