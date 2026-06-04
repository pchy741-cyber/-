/**
 * 와이즈리포트 컨센서스 스크래핑 — 상승세/하락세 시그널
 * Source: comp.wisereport.co.kr (FnGuide 제공, JSON API, 무인증)
 *
 * 활용:
 * - 투자의견 상향 = 상승세 → 매수 가중치 +
 * - 투자의견 하향 = 하락세 → 매수 제외 or 손절 빨리
 * - 목표가 괴리율 → TP 설정 참고
 */

import { logger } from '../utils/logger.js';

// ── 타입 ──

export interface ConsensusChange {
  code: string;          // 종목코드 (6자리)
  name: string;          // 종목명
  direction: 'UP' | 'DOWN';  // 상향/하향
  rating: string;        // 현재 투자의견 (BUY, HOLD, etc.)
  prevRating: string;    // 이전 투자의견
  broker: string;        // 증권사
  analyst: string;       // 애널리스트
  date: string;          // 등록일 (YYYYMMDD)
  consensusScore: number; // 컨센서스 점수 (1~5, 5=Strong Buy)
}

export interface ConsensusSignal {
  code: string;
  name: string;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  upgradeCount: number;    // 최근 상향 수
  downgradeCount: number;  // 최근 하향 수
  netScore: number;        // upgradeCount - downgradeCount
  consensusAvg: number;    // 평균 컨센서스 점수 (1~5)
  latestDate: string;
}

// ── 캐시 ──

let _cache: { signals: Map<string, ConsensusSignal>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 4 * 60 * 60_000; // 4시간 (컨센서스는 자주 안 바뀜)

const BASE_URL = 'https://comp.wisereport.co.kr/earnings/getData.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ── API 호출 ──

interface WiseReportItem {
  CMP_CD: string;
  CMP_NM: string;
  ANL_NM: string;
  BRK_NM: string;
  DEG: string;
  DEG_PREV: string;
  DEG_CNS: number;
  REG_DT: string;
}

async function fetchRatingChanges(direction: 'U' | 'D', pages = 3): Promise<ConsensusChange[]> {
  const results: ConsensusChange[] = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const url = `${BASE_URL}?eGubun=Comment&rpt=1&updn=${direction}&perpage=30&curpage=${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) break;

      const json = await res.json() as { data: WiseReportItem[] };
      if (!json.data?.length) break;

      for (const item of json.data) {
        results.push({
          code: item.CMP_CD,
          name: item.CMP_NM,
          direction: direction === 'U' ? 'UP' : 'DOWN',
          rating: item.DEG,
          prevRating: item.DEG_PREV,
          broker: item.BRK_NM,
          analyst: item.ANL_NM,
          date: item.REG_DT,
          consensusScore: item.DEG_CNS ?? 0,
        });
      }

      // rate limit 존중
      if (page < pages) await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      logger.warn(`와이즈리포트 ${direction === 'U' ? '상향' : '하향'} 페이지${page} 실패: ${err}`, { component: 'CONSENSUS' });
      break;
    }
  }

  return results;
}

// ── 시그널 합산 ──

function buildSignals(upgrades: ConsensusChange[], downgrades: ConsensusChange[]): Map<string, ConsensusSignal> {
  const map = new Map<string, ConsensusSignal>();

  const process = (items: ConsensusChange[]) => {
    for (const item of items) {
      const existing = map.get(item.code);
      if (existing) {
        if (item.direction === 'UP') existing.upgradeCount++;
        else existing.downgradeCount++;
        existing.netScore = existing.upgradeCount - existing.downgradeCount;
        if (item.consensusScore > 0) {
          existing.consensusAvg = (existing.consensusAvg + item.consensusScore) / 2;
        }
        if (item.date > existing.latestDate) existing.latestDate = item.date;
      } else {
        map.set(item.code, {
          code: item.code,
          name: item.name,
          trend: 'NEUTRAL',
          upgradeCount: item.direction === 'UP' ? 1 : 0,
          downgradeCount: item.direction === 'DOWN' ? 1 : 0,
          netScore: item.direction === 'UP' ? 1 : -1,
          consensusAvg: item.consensusScore || 3.0,
          latestDate: item.date,
        });
      }
    }
  };

  process(upgrades);
  process(downgrades);

  // trend 결정
  for (const signal of map.values()) {
    if (signal.netScore >= 2 || (signal.netScore >= 1 && signal.consensusAvg >= 4.0)) {
      signal.trend = 'BULLISH';
    } else if (signal.netScore <= -2 || (signal.netScore <= -1 && signal.consensusAvg <= 2.5)) {
      signal.trend = 'BEARISH';
    } else {
      signal.trend = 'NEUTRAL';
    }
  }

  return map;
}

// ── Public API ──

/**
 * 전체 컨센서스 시그널 갱신 (캐시 4시간)
 * Track A 실행 시 1회 호출하여 매수/매도 판단에 반영
 */
export async function refreshConsensusSignals(): Promise<Map<string, ConsensusSignal>> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.signals;
  }

  try {
    const [upgrades, downgrades] = await Promise.all([
      fetchRatingChanges('U', 3),
      fetchRatingChanges('D', 3),
    ]);

    const signals = buildSignals(upgrades, downgrades);
    _cache = { signals, fetchedAt: Date.now() };

    const bullish = [...signals.values()].filter(s => s.trend === 'BULLISH').length;
    const bearish = [...signals.values()].filter(s => s.trend === 'BEARISH').length;
    logger.info(
      `📊 컨센서스 갱신: ${signals.size}종목 (상승세 ${bullish}, 하락세 ${bearish}, 중립 ${signals.size - bullish - bearish})`,
      { component: 'CONSENSUS' },
    );

    return signals;
  } catch (err) {
    logger.error(`컨센서스 갱신 실패: ${err}`, { component: 'CONSENSUS' });
    return _cache?.signals ?? new Map();
  }
}

/**
 * 특정 종목의 컨센서스 트렌드 조회
 * @returns 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null (데이터 없음)
 */
export function getConsensusTrend(code: string): ConsensusSignal | null {
  return _cache?.signals.get(code) ?? null;
}

/**
 * 매수 시 컨센서스 기반 신뢰도 보정
 * - BULLISH: +0.10 (매수 자신감 ↑)
 * - BEARISH: -0.15 (매수 자제)
 * - NEUTRAL/없음: 0
 */
export function getConsensusConfidenceAdj(code: string): number {
  const signal = getConsensusTrend(code);
  if (!signal) return 0;
  if (signal.trend === 'BULLISH') return 0.10;
  if (signal.trend === 'BEARISH') return -0.15;
  return 0;
}

/**
 * 전체 시장 분위기 — 상승세 비율
 * @returns 0~1 (0.7 이상이면 시장 전체 상승세)
 */
export function getMarketSentiment(): { bullishRatio: number; total: number } {
  if (!_cache || _cache.signals.size === 0) return { bullishRatio: 0.5, total: 0 };
  const signals = [..._cache.signals.values()];
  const bullish = signals.filter(s => s.trend === 'BULLISH').length;
  return { bullishRatio: bullish / signals.length, total: signals.length };
}
