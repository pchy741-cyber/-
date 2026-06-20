/**
 * Community Sentinel — 커뮤니티 언급 추적 + 센티먼트 + FOMO/펌프 감지
 *
 * 데이터 소스 (V1):
 *   YELLOW: 네이버 금융 종목토론방 (기존 community-sentiment.ts 패턴 확장)
 *
 * 핵심 원칙:
 * - 커뮤니티 데이터 단독 매수 금지
 * - 커뮤니티 데이터 단독 비중 확대 금지
 * - 상방 가점 최대 +5, 하방 감점 최대 -20 (비대칭)
 * - 원문/닉네임/개인정보 저장 금지 — 집계 통계만 유지
 * - 로그인 우회, 쿠키 재사용, 캡차 우회, 세션 탈취 금지
 *
 * Privacy: 원문 미저장. 저장 항목:
 *   - 종목별 제목 개수 (integer)
 *   - 키워드 매치 횟수 (집계)
 *   - Z-score (수치)
 */

import { getDisclosureScoreAdjustment } from './dart-monitor.js';
import {
  assessPumpRisk,
  checkDryPullback,
  computeCommunityAdj,
  FOMO_KEYWORDS,
  PUMP_KEYWORDS,
  type PumpRiskResult,
} from './community-guards.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

const COMP = 'COMMUNITY_SENTINEL';

// ── Types ──

export interface CommunitySentinelResult {
  stockCode: string;
  mentionCount: number;     // 제목 수 (원문 미저장)
  mentionZ: number;         // 롤링 Z-score
  sentimentScore: number;   // -100 ~ +100
  posRatio: number;         // 0.0~1.0
  negRatio: number;         // 0.0~1.0
  pumpRisk: PumpRiskResult;
  fomoDetected: boolean;
  dryPullback: boolean;
  scoreAdj: number;         // -20 ~ +5 (파이프라인 연동값)
  fetchedAt: number;
}

// ── 캐시 ──

const _resultCache = new Map<string, CommunitySentinelResult>();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2시간

// 롤링 7일 언급 이력 (Z-score 계산용, 수치만 저장)
const _mentionHistory = new Map<string, number[]>();
const HISTORY_MAX_DAYS = 7;
const HISTORY_MAX_ENTRIES = 200;

// 만료 엔트리 정리 (30분 주기)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _resultCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) _resultCache.delete(key);
  }
  if (_resultCache.size > 500) _resultCache.clear();
  if (_mentionHistory.size > HISTORY_MAX_ENTRIES) _mentionHistory.clear();
}, 30 * 60 * 1000).unref();

// ── 키워드 목록 (기존 community-sentiment.ts 확장) ──

const POSITIVE_WORDS = [
  '상승', '급등', '호재', '매수', '돌파', '강세', '신고가',
  '저점', '반등', '추천', '목표가', '상향', '흑자', '성장', '기대',
  '실적개선', '수주', '흑전', '배당',
];

const NEGATIVE_WORDS = [
  '하락', '급락', '악재', '매도', '주의', '약세', '신저가',
  '고점', '손절', '폭락', '위험', '하향', '적자', '우려', '조심',
  '상폐', '감자', '횡령', '배임', '유증',
];

// ── Z-Score 계산 ──

function calcMentionZScore(stockCode: string, currentCount: number): number {
  const history = _mentionHistory.get(stockCode) ?? [];

  // 이력 부족(3일 미만): 계산 불가 → 0
  if (history.length < 3) return 0;

  const mean = history.reduce((s, v) => s + v, 0) / history.length;
  const variance = history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length;
  const stdDev = Math.sqrt(variance);

  // 표준편차 0 (모든 값 동일): Z-score 의미 없음
  if (stdDev < 0.5) return currentCount > mean ? 1.0 : 0;

  return (currentCount - mean) / stdDev;
}

function updateMentionHistory(stockCode: string, count: number): void {
  const history = _mentionHistory.get(stockCode) ?? [];
  history.push(count);
  if (history.length > HISTORY_MAX_DAYS) history.shift();
  _mentionHistory.set(stockCode, history);
}

// ── 네이버 토론방 스크래핑 (기존 패턴 확장) ──

interface NaverBoardStats {
  titleCount: number;
  posRatio: number;       // 0.0~1.0
  negRatio: number;       // 0.0~1.0
  pumpKeywordHits: number;
  fomoKeywordHits: number;
  sentimentScore: number; // -100~+100
}

async function fetchNaverBoardStats(stockCode: string): Promise<NaverBoardStats | null> {
  try {
    const url = `https://finance.naver.com/item/board.nhn?code=${stockCode}&page=1`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Referer: 'https://finance.naver.com/',
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const titles: string[] = [];

    // <a class="title" ...>제목</a> 패턴 추출 (원문 저장 안 함 — 함수 내에서만 사용)
    const re = /class="title"[^>]*>\s*([^<]{2,60})\s*</g;
    let m: RegExpExecArray | null = re.exec(html);
    while (m !== null && titles.length < 20) {
      const t = m[1].trim();
      if (t && !t.includes('등록') && t.length > 2) titles.push(t);
      m = re.exec(html);
    }

    if (titles.length === 0) return null;

    // 키워드 매칭 (집계만, 원문 미보존)
    let posCount = 0, negCount = 0, pumpHits = 0, fomoHits = 0;
    for (const t of titles) {
      for (const w of POSITIVE_WORDS) if (t.includes(w)) posCount++;
      for (const w of NEGATIVE_WORDS) if (t.includes(w)) negCount++;
      for (const w of PUMP_KEYWORDS) if (t.includes(w)) pumpHits++;
      for (const w of FOMO_KEYWORDS) if (t.includes(w)) fomoHits++;
    }

    const total = posCount + negCount;
    const posRatio = total > 0 ? posCount / total : 0.5;
    const negRatio = total > 0 ? negCount / total : 0.5;
    const sentimentScore = total > 0 ? Math.round(((posCount - negCount) / total) * 100) : 0;

    return {
      titleCount: titles.length,
      posRatio,
      negRatio,
      pumpKeywordHits: pumpHits,
      fomoKeywordHits: fomoHits,
      sentimentScore,
    };
  } catch (err) {
    logger.debug(`커뮤니티 감시 실패 (${stockCode}): ${err}`, { component: 'COMMUNITY' });
    return null;
  }
}

// ── 메인: 배치 분석 ──

/**
 * Community Sentinel 배치 실행
 * 스케줄러에서 30분 간격으로 호출 (장중 09:30~15:00)
 *
 * @param stockCodes 감시 종목 코드 (최대 12개)
 * @param chartDataMap 일봉 데이터 (dry pullback 검증용, 선택)
 * @param priceChanges 당일/3일 등락률 (anti-pump 검증용, 선택)
 */
export async function runCommunitySentinel(
  stockCodes: string[],
  chartDataMap?: Map<string, import('../kis/market.js').DailyCandle[]>,
  priceChanges?: Map<string, { change1D: number; change3D: number; marketCap?: number }>,
): Promise<Map<string, CommunitySentinelResult>> {
  const results = new Map<string, CommunitySentinelResult>();
  const targets = stockCodes.slice(0, 12); // 과도한 스크래핑 방지

  const BATCH = 4;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (code) => {
        // 캐시 히트
        const cached = _resultCache.get(code);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          return { code, result: cached };
        }

        // 네이버 토론방 스크래핑
        const stats = await fetchNaverBoardStats(code);
        if (!stats) return { code, result: null };

        // Z-score 계산 + 이력 갱신
        const mentionZ = calcMentionZScore(code, stats.titleCount);
        updateMentionHistory(code, stats.titleCount);

        // 가격 변동 데이터
        const priceData = priceChanges?.get(code);
        const change1D = priceData?.change1D ?? 0;
        const change3D = priceData?.change3D ?? 0;
        const marketCap = priceData?.marketCap;

        // DART 공시 확인 (기존 캐시 활용)
        const dartAdj = getDisclosureScoreAdjustment(code);
        const hasDartDisclosure = dartAdj !== 0;

        // Anti-Pump Guard
        const pumpRisk = assessPumpRisk({
          mentionZ,
          changePct1D: change1D,
          changePct3D: change3D,
          marketCapKrw: marketCap,
          hasDartDisclosure,
          hasConsensus: false, // V1에서는 단순화 — pipeline에서 이미 컨센서스 처리
          pumpKeywordHits: stats.pumpKeywordHits,
          fomoKeywordHits: stats.fomoKeywordHits,
        });

        // FOMO 감지
        const fomoDetected = mentionZ > 3.0 && stats.posRatio > 0.8;

        // Dry Pullback (차트 데이터 있을 때만)
        const candles = chartDataMap?.get(code);
        const dryPullback = candles ? checkDryPullback(candles) : false;

        // 교차검증은 간략 버전 (V1: DART 악재 없으면 통과)
        const crossValidated = dartAdj >= 0;

        // 최종 점수 조정 계산
        const scoreAdj = computeCommunityAdj({
          mentionZ,
          posRatio: stats.posRatio,
          negRatio: stats.negRatio,
          pumpRisk,
          dryPullbackValid: dryPullback,
          crossValidated,
        });

        const result: CommunitySentinelResult = {
          stockCode: code,
          mentionCount: stats.titleCount,
          mentionZ,
          sentimentScore: stats.sentimentScore,
          posRatio: stats.posRatio,
          negRatio: stats.negRatio,
          pumpRisk,
          fomoDetected,
          dryPullback,
          scoreAdj,
          fetchedAt: Date.now(),
        };

        _resultCache.set(code, result);
        return { code, result };
      }),
    );

    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value.result) {
        results.set(s.value.code, s.value.result);
      }
    }

    // 배치 간 딜레이 (봇 차단 방지)
    if (i + BATCH < targets.length) await sleep(300);
  }

  // 로깅
  const significant = [...results.values()].filter((r) => r.scoreAdj !== 0 || r.pumpRisk.blockEntry);
  if (significant.length > 0) {
    logger.info(
      `🗣️ Community Sentinel ${results.size}종목: ${significant.map((r) => `${r.stockCode}(Z=${r.mentionZ.toFixed(1)},adj=${r.scoreAdj > 0 ? '+' : ''}${r.scoreAdj}${r.pumpRisk.blockEntry ? ',BLOCK' : ''})`).join(' ')}`,
      { component: COMP },
    );
  } else if (results.size > 0) {
    logger.info(`🗣️ Community Sentinel ${results.size}종목 수집 (유의미 신호 없음)`, { component: COMP });
  }

  return results;
}

// ── Pipeline 연동 함수들 ──

/**
 * Track B pipeline.ts 점수 조정용 (기존 dartAdj 패턴과 동일)
 * 캐시 미스 시 0 반환 (fail-safe)
 * Range: -20 ~ +5
 */
export function getCommunityScoreAdjustment(stockCode: string): number {
  try {
    const cached = _resultCache.get(stockCode);
    if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return 0;
    const adj = cached.scoreAdj;
    if (!Number.isFinite(adj)) return 0;
    return Math.max(-20, Math.min(5, adj));
  } catch (err) {
    logger.debug(`커뮤니티 스코어 조회 실패 (${stockCode}): ${err}`, { component: 'COMMUNITY' });
    return 0;
  }
}

/**
 * Hard Gate용: 펌프 리스크 차단 여부
 * 캐시에 있고 blockEntry=true면 매수 차단
 */
export function isCommunityPumpBlocked(stockCode: string): boolean {
  try {
    const cached = _resultCache.get(stockCode);
    if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return false;
    return cached.pumpRisk.blockEntry;
  } catch (err) {
    logger.debug(`펌프 차단 조회 실패 (${stockCode}): ${err}`, { component: 'COMMUNITY' });
    return false;
  }
}

/**
 * 캐시 초기화 (테스트/강제 갱신용)
 */
export function clearCommunitySentinelCache(code?: string): void {
  if (code) {
    _resultCache.delete(code);
    _mentionHistory.delete(code);
  } else {
    _resultCache.clear();
    _mentionHistory.clear();
  }
}
