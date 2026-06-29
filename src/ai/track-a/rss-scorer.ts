/**
 * RSS 뉴스 감성분석 + 기술지표 스코어링 — AI API 없이 무료 종합 판단
 *
 * 점수 구성:
 *   기술지표(analyzeTechnicals): 최대 82점 (베이스)
 *   뉴스 감성(70+ 키워드):      ±15점 (종목 뉴스 NLP)
 *   시장 감성(KOSPI/증시):      ±5점  (시장 전체 톤)
 *   거래량/모멘텀:              +10점 (등락률/거래량/추세)
 *   수급(외국인/기관):          ±8점
 *   눌림목:                    +8점
 *   ─────────────────────────
 *   합계: min(100, 합계)
 *
 * 비용: $0/일 (Google News RSS 무료)
 */

import { analyzeTechnicals } from '../../analysis/indicators.js';
import type { ScoringResult, WatchlistItem } from '../../db/models.js';
import type { DailyCandle } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';

const COMP = 'RSS_SCORER';

// ── 스코어링 상수 ──
const MIN_CANDLES = 30; // 기술분석 최소 캔들 수
const TECH_SCORE_WEIGHT = 0.6; // 기술지표 점수 가중치
const BASE_SCORE = 50;
const RSS_MAX_SCORE = 82; // RSS 단독 상한
const NEWS_SCORE_MAX = 15;
const MARKET_SENTIMENT_CACHE_MS = 30 * 60_000; // 시장 감성 캐시 30분
const NEWS_BATCH_SIZE = 30; // Google RSS 배치 크기
const NEWS_BATCH_DELAY_MS = 300; // 배치 간 지연 (ms)
const PULLBACK_BONUS = 8;
const OVEREXTENDED_PENALTY = -5;
const OVEREXTENDED_BASE_THRESHOLD = 70; // 과매수 감점 기준 점수
const OVEREXTENDED_VOL_THRESHOLD = 1.3; // 과매수 거래량 비율 기준
const STRONG_BUY_THRESHOLD = 82; // AI 프롬프트 기준 통일 (82+=STRONG_BUY)
const BUY_THRESHOLD = 68; // 68~81=BUY (프롬프트 기준)
const STRONG_SELL_THRESHOLD = 25;
const SELL_THRESHOLD = 30; // ensemble.ts 기준 통일 (30~49=SELL)
const PULLBACK_VOL_COMBO_THRESHOLD = 1.3; // 눌림목+거래량 콤보 기준
const PULLBACK_CONFIDENCE_BOOST = 0.08;
const MAX_CONFIDENCE = 0.9;
const YT_CACHE_TTL_MS = 30 * 60_000; // 유튜브 감성 캐시 30분
const YT_LOOKBACK_MS = 48 * 3600_000; // 유튜브 최근 48시간

// ── 한국 긍정/부정 키워드 (감성 분석) ──
// weight: 3=강한 시그널, 2=중간, 1=약한
const POSITIVE: [string, number][] = [
  // 실적 (강)
  ['어닝서프라이즈', 3],
  ['실적개선', 3],
  ['영업이익 증가', 3],
  ['사상최대', 3],
  ['흑자전환', 3],
  ['매출 증가', 2],
  ['수익증가', 2],
  ['실적 호조', 2],
  ['순이익', 2],
  // 투자의견 (강)
  ['목표가 상향', 3],
  ['매수 추천', 3],
  ['투자의견 상향', 3],
  ['아웃퍼폼', 2],
  // 수급 (중)
  ['외국인 순매수', 2],
  ['기관 순매수', 2],
  ['자사주 매입', 2],
  ['자사주 취득', 2],
  // 사업 (중)
  ['대규모 수주', 2],
  ['신규 수주', 2],
  ['수출 증가', 2],
  ['공급계약', 2],
  ['MOU', 1],
  // 주가 (중)
  ['신고가', 2],
  ['52주 최고', 2],
  ['상한가', 2],
  ['급등', 2],
  // 배당/주주 (중)
  ['배당 확대', 2],
  ['배당금 인상', 2],
  ['주주환원', 2],
  // 테마/성장 (약)
  ['성장', 1],
  ['호재', 1],
  ['상향', 1],
  ['증가', 1],
  ['개선', 1],
  ['확대', 1],
  ['반등', 1],
  ['회복', 1],
  ['AI 수혜', 2],
  ['반도체 호황', 2],
  ['수출 호조', 2],
];
const NEGATIVE: [string, number][] = [
  // 실적 (강)
  ['어닝쇼크', 3],
  ['실적 부진', 3],
  ['적자 전환', 3],
  ['적자 확대', 3],
  ['영업손실', 3],
  ['매출 감소', 2],
  ['실적 악화', 2],
  ['수익 감소', 2],
  // 투자의견 (강)
  ['목표가 하향', 3],
  ['투자의견 하향', 3],
  ['매도 추천', 3],
  ['언더퍼폼', 2],
  // 리스크 (강)
  ['상장폐지', 3],
  ['횡령', 3],
  ['분식회계', 3],
  ['검찰', 2],
  ['압수수색', 3],
  // 수급 (중)
  ['외국인 순매도', 2],
  ['기관 순매도', 2],
  ['대량 매도', 2],
  ['블록딜', 2],
  // 사업 (중)
  ['소송', 2],
  ['리콜', 2],
  ['규제', 2],
  ['제재', 2],
  ['과징금', 2],
  // 주가 (중)
  ['52주 최저', 2],
  ['하한가', 2],
  ['급락', 2],
  ['폭락', 2],
  // 일반 (약)
  ['우려', 1],
  ['하락', 1],
  ['둔화', 1],
  ['감소', 1],
  ['악재', 1],
  ['하향', 1],
  ['위축', 1],
  ['금리 인상', 2],
  ['경기침체', 2],
  ['무역분쟁', 2],
];


// ── 뉴스 감성 점수 캐시 (Track B 파이프라인 연동용) ──
// Quick Re-Score(1~60분) / Surge Detector가 getNewsScore() 호출 시 자동 적재
// Track B pipeline은 getCachedNewsAdj()로 네트워크 호출 없이 참조
const NEWS_SCORE_CACHE = new Map<string, { score: number; fetchedAt: number }>();
const NEWS_CACHE_TTL_MS = 90 * 60_000; // 90분 (Quick Re-Score 주기보다 여유)

/** Track B 파이프라인용: 캐시된 뉴스 감성 → 점수 보정값 (-6 ~ +5) */
export function getCachedNewsAdj(stockCode: string): number {
  const cached = NEWS_SCORE_CACHE.get(stockCode);
  if (!cached || Date.now() - cached.fetchedAt > NEWS_CACHE_TTL_MS) return 0;
  const s = cached.score;
  // 강한 긍정(8+): +5, 중간(5+): +3, 약한(3+): +1
  // 강한 부정(-8↓): -6, 중간(-5↓): -3, 약한(-3↓): -1
  if (s >= 8) return 5;
  if (s >= 5) return 3;
  if (s >= 3) return 1;
  if (s <= -8) return -6;
  if (s <= -5) return -3;
  if (s <= -3) return -1;
  return 0;
}

/** Google News RSS로 종목 뉴스 감성 점수 계산 (-15 ~ +15) */
export async function getNewsScore(_stockCode: string, stockName: string): Promise<{ score: number; headlines: string[] }> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { score: 0, headlines: [] };
    const xml = await res.text();

    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
      .slice(1, 8) // 최대 7개 (더 넓은 범위)
      .map((m) => m[1]);

    if (titles.length === 0) return { score: 0, headlines: [] };

    let score = 0;
    for (const title of titles) {
      for (const [kw, weight] of POSITIVE) {
        if (title.includes(kw)) score += weight;
      }
      for (const [kw, weight] of NEGATIVE) {
        if (title.includes(kw)) score -= weight;
      }
    }

    const bounded = Math.max(-NEWS_SCORE_MAX, Math.min(NEWS_SCORE_MAX, score));
    // 캐시 적재 — Track B pipeline이 getCachedNewsAdj()로 참조
    NEWS_SCORE_CACHE.set(_stockCode, { score: bounded, fetchedAt: Date.now() });
    return { score: bounded, headlines: titles.slice(0, 3) };
  } catch {
    return { score: 0, headlines: [] };
  }
}

/**
 * v16.2.3: Track B 리서치봇용 — stale 캐시 엔트리 배치 갱신
 * Track B 3분 주기에 호출하여 NEWS_SCORE_CACHE 공백 해소
 * @param stocks - { stockCode, stockName }[] 감시 목록
 * @param maxRefresh - 한 사이클 최대 갱신 건수 (Google RSS rate limit 방지)
 * @returns 갱신된 종목 수
 */
export async function refreshStaleNewsScores(
  stocks: Array<{ stockCode: string; stockName: string }>,
  maxRefresh = 3,
): Promise<number> {
  const now = Date.now();
  const stale = stocks.filter((s) => {
    const c = NEWS_SCORE_CACHE.get(s.stockCode);
    return !c || now - c.fetchedAt > NEWS_CACHE_TTL_MS;
  });
  if (stale.length === 0) return 0;
  // 우선순위: 캐시 없는 종목 → 가장 오래된 순
  stale.sort((a, b) => {
    const ca = NEWS_SCORE_CACHE.get(a.stockCode);
    const cb = NEWS_SCORE_CACHE.get(b.stockCode);
    return (ca?.fetchedAt ?? 0) - (cb?.fetchedAt ?? 0);
  });
  let refreshed = 0;
  for (const s of stale.slice(0, maxRefresh)) {
    await getNewsScore(s.stockCode, s.stockName);
    refreshed++;
    if (refreshed < maxRefresh) await new Promise((r) => setTimeout(r, 500)); // 500ms 간격
  }
  return refreshed;
}

/** 시장 전체 뉴스 감성 (-10 ~ +10) — KOSPI/코스닥/경제 전반 */
let _marketSentimentCache: { score: number; fetchedAt: number } | null = null;
async function getMarketSentiment(): Promise<number> {
  if (_marketSentimentCache && Date.now() - _marketSentimentCache.fetchedAt < MARKET_SENTIMENT_CACHE_MS) {
    return _marketSentimentCache.score;
  }
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent('코스피 증시')}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return 0;
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].slice(1, 6).map((m) => m[1]);

    let score = 0;
    const MARKET_POS: [string, number][] = [
      ['상승', 2],
      ['반등', 2],
      ['랠리', 3],
      ['외국인 매수', 2],
      ['최고치', 2],
      ['호조', 1],
    ];
    const MARKET_NEG: [string, number][] = [
      ['하락', 2],
      ['폭락', 3],
      ['급락', 3],
      ['외국인 매도', 2],
      ['경기침체', 3],
      ['금리', 1],
      ['공포', 2],
    ];
    for (const title of titles) {
      for (const [kw, w] of MARKET_POS) {
        if (title.includes(kw)) score += w;
      }
      for (const [kw, w] of MARKET_NEG) {
        if (title.includes(kw)) score -= w;
      }
    }
    const clamped = Math.max(-10, Math.min(10, score));
    _marketSentimentCache = { score: clamped, fetchedAt: Date.now() };
    return clamped;
  } catch {
    return 0;
  }
}

// ── 유튜브 인플루언서 시장 분위기 감지 (무료, 30분 캐시) ──
// weight: 채널 신뢰도 (클릭베이트 채널은 낮게)
const YT_CHANNELS = [
  { id: 'UChlv4GSd7OQl3js-jkLOnFA', name: '삼프로TV', weight: 1.0 },
  { id: 'UCWskYkV4c4S9D__rsfOl2JA', name: '한경글로벌마켓', weight: 1.0 },
  { id: 'UCvil4OAt-zShzkKHsg9EQAw', name: '김작가TV', weight: 0.3 },
];
const YT_BULLISH: [string, number][] = [
  ['상승장', 3],
  ['불장', 3],
  ['랠리', 3],
  ['반등 시작', 3],
  ['매수', 2],
  ['사야', 2],
  ['저점', 2],
  ['골든크로스', 2],
  ['신고가', 2],
  ['호황', 2],
  ['급등', 2],
  ['폭등', 3],
  ['돌파', 2],
  ['기회', 1],
  ['회복', 1],
  ['바닥 확인', 2],
  ['상승 전환', 2],
];
const YT_BEARISH: [string, number][] = [
  ['폭락', 3],
  ['하락장', 3],
  ['공포', 3],
  ['위기', 3],
  ['폭풍전야', 3],
  ['매도', 2],
  ['팔아야', 2],
  ['빠져라', 2],
  ['데드크로스', 2],
  ['추락', 2],
  ['붕괴', 3],
  ['급락', 2],
  ['조정', 1],
  ['하락', 1],
  ['침체', 2],
  ['위험', 2],
  ['도망', 2],
  ['떨어진다', 1],
  ['녹는다', 2],
  ['녹아내', 2],
];
// 질문형/가정문 → 실제 시장 공포가 아니라 분석 콘텐츠 → 점수 감쇄
const YT_DAMPEN_PATTERNS = [/할까\??$/, /될까\??$/, /일까\??$/, /수 있다/, /전에/, /기 전/];

let _ytSentimentCache: { score: number; detail: string; fetchedAt: number } | null = null;

/** 유튜브 인플루언서 시장 감성 (-5 ~ +5) — 최근 48시간 영상 제목 분석 */
async function getYouTubeSentiment(): Promise<{ score: number; detail: string }> {
  if (_ytSentimentCache && Date.now() - _ytSentimentCache.fetchedAt < YT_CACHE_TTL_MS) {
    return { score: _ytSentimentCache.score, detail: _ytSentimentCache.detail };
  }
  try {
    const cutoff = Date.now() - YT_LOOKBACK_MS; // 48시간 이내만
    let totalScore = 0;
    const matchedTitles: string[] = [];

    const feeds = await Promise.allSettled(
      YT_CHANNELS.map(async (ch) => {
        const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const xml = await res.text();
        // Atom 형식: <entry><title>...</title><published>...</published></entry>
        const entries = [
          ...xml.matchAll(
            /<entry>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<published>(.*?)<\/published>[\s\S]*?<\/entry>/g,
          ),
        ];
        return entries
          .filter((e) => new Date(e[2]).getTime() > cutoff)
          .map((e) => ({ title: e[1], channel: ch.name, weight: ch.weight }));
      }),
    );

    for (const result of feeds) {
      if (result.status !== 'fulfilled') continue;
      for (const { title, channel, weight } of result.value) {
        let entryScore = 0;
        for (const [kw, w] of YT_BULLISH) {
          if (title.includes(kw)) entryScore += w;
        }
        for (const [kw, w] of YT_BEARISH) {
          if (title.includes(kw)) entryScore -= w;
        }
        // 질문형/가정문 감쇄 ("~할까?", "~수 있다" → 분석 영상, 점수 반감)
        if (entryScore !== 0 && YT_DAMPEN_PATTERNS.some((p) => p.test(title))) {
          entryScore = Math.round(entryScore * 0.5);
        }
        if (entryScore !== 0) {
          totalScore += Math.round(entryScore * weight);
          matchedTitles.push(`${channel}:"${title.slice(0, 25)}"`);
        }
      }
    }

    const clamped = Math.max(-5, Math.min(5, totalScore));
    const detail = matchedTitles.length > 0 ? matchedTitles.slice(0, 2).join(', ') : '';
    _ytSentimentCache = { score: clamped, detail, fetchedAt: Date.now() };
    if (clamped !== 0) {
      logger.info(`📺 유튜브 감성: ${clamped > 0 ? '+' : ''}${clamped} (${detail})`, { component: COMP });
    }
    return { score: clamped, detail };
  } catch {
    return { score: 0, detail: '' };
  }
}

/** 거래량/모멘텀 보너스 계산 */
function getMomentumScore(
  code: string,
  candles: DailyCandle[],
  topGainerCodes: Set<string>,
  topVolumeCodes: Set<string>,
): number {
  let bonus = 0;
  if (topGainerCodes.has(code)) bonus += 6; // 오늘 등락률 상위
  if (topVolumeCodes.has(code)) bonus += 4; // 오늘 거래량 상위

  // 최근 3일 상승 추세 (descending: index 0 = newest)
  if (candles.length >= 4) {
    const recent = candles.slice(0, 4); // 최신 4일
    // descending: recent[0]=today, recent[1]=yesterday, ...
    // rising = today > yesterday > day_before > ...
    const rising = recent.slice(0, -1).every((c, i) => c.close >= recent[i + 1].close);
    if (rising) bonus += 3;
  }

  return Math.min(10, bonus);
}

/** 수급 보너스 (외국인/기관 순매수) */
function getFlowBonus(flowAdj: number): number {
  return Math.max(-8, Math.min(8, flowAdj));
}

/** RSS + 기술지표 기반 종목 스코어링 (Gemini/GPT 없음) */
export async function runRSSScoring(
  _mode: string,
  watchlist: Pick<WatchlistItem, 'stock_code' | 'stock_name'>[],
  chartData: Map<string, DailyCandle[]>,
  topGainerCodes: Set<string>,
  topVolumeCodes: Set<string>,
  flowAdjMap: Map<string, number>,
): Promise<ScoringResult[]> {
  logger.info(`RSS 스코어링 시작: ${watchlist.length}종목 (뉴스 감성 + 기술지표)`, { component: COMP });
  const results: ScoringResult[] = [];

  // 시장 전체 감성 (30분 캐시) + 유튜브 인플루언서 감성
  const [marketSentiment, ytSentiment] = await Promise.all([getMarketSentiment(), getYouTubeSentiment()]);

  // 종목별 뉴스 스코어 — 전종목 배치 처리 (Google RSS rate limit 대응: 30개씩, 300ms 간격)
  const newsScores = new Map<string, { score: number; headlines: string[] }>();
  for (let i = 0; i < watchlist.length; i += NEWS_BATCH_SIZE) {
    const batch = watchlist.slice(i, i + NEWS_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (w) => {
        const result = await getNewsScore(w.stock_code, w.stock_name);
        if (result.score !== 0) newsScores.set(w.stock_code, result);
      }),
    );
    if (i + NEWS_BATCH_SIZE < watchlist.length) await new Promise((r) => setTimeout(r, NEWS_BATCH_DELAY_MS));
  }

  logger.info(
    `뉴스 감성 완료: ${newsScores.size}종목 시그널, 시장감성=${marketSentiment > 0 ? '+' : ''}${marketSentiment}, 유튜브=${ytSentiment.score > 0 ? '+' : ''}${ytSentiment.score}`,
    { component: COMP },
  );

  for (const w of watchlist) {
    const candles = chartData.get(w.stock_code) ?? [];
    if (candles.length < MIN_CANDLES) continue;

    const tech = analyzeTechnicals(candles);
    if (!tech) continue;

    // 기술지표 기반 베이스 점수 (75점 캡 제거 — RSS 모드에서는 full range)
    let baseScore = BASE_SCORE + Math.round(tech.score * TECH_SCORE_WEIGHT);
    baseScore = Math.max(0, Math.min(RSS_MAX_SCORE, baseScore));

    const newsResult = newsScores.get(w.stock_code);
    const newsBonus = newsResult?.score ?? 0;
    const momentumBonus = getMomentumScore(w.stock_code, candles, topGainerCodes, topVolumeCodes);
    const flowBonus = getFlowBonus(flowAdjMap.get(w.stock_code) ?? 0);

    // 눌림목 보너스
    const pullbackBonus = tech.pullbackSignal ? PULLBACK_BONUS : 0;
    // 과매수 감점 — v10.11: 비교연산자 수정 (기존 < → >= : 과매수=높은점수+높은거래량)
    const overextendedPenalty = !tech.pullbackSignal && baseScore >= OVEREXTENDED_BASE_THRESHOLD && tech.volumeRatio >= OVEREXTENDED_VOL_THRESHOLD ? OVEREXTENDED_PENALTY : 0;
    // 시장 감성 반영 (±10 → ±5점으로 축소 적용, 개별 종목보다 영향 낮게)
    const marketBonus = Math.round(marketSentiment * 0.5);
    // 유튜브 인플루언서 감성 (±5, 시장 레짐 보정)
    const ytBonus = ytSentiment.score;

    const composite = Math.min(
      100,
      baseScore + newsBonus + momentumBonus + flowBonus + pullbackBonus + overextendedPenalty + marketBonus + ytBonus,
    );

    // 신호 결정 + 눌림목 확인 시 confidence 상향
    // HOLD 기본값 0.63: RSS 폴백은 AI 분석 없으므로 GPT 대비 -2% 패널티 (과신 방지)
    // (너무 낮추면 pipeline 0.60 필터 탈락 → 전 종목 매수 차단 버그)
    let signal: ScoringResult['signal'] = 'HOLD';
    let confidence = 0.63; // RSS 폴백: GPT(0.65) 대비 -0.02 패널티
    if (composite >= STRONG_BUY_THRESHOLD) {
      signal = 'STRONG_BUY';
      confidence = 0.78; // RSS 폴백: GPT(0.82~0.9) 대비 -0.04 패널티
    } else if (composite >= BUY_THRESHOLD) {
      signal = 'BUY';
      confidence = 0.68; // RSS 폴백: GPT(0.72) 대비 -0.04 패널티
    } else if (composite <= STRONG_SELL_THRESHOLD) {
      signal = 'STRONG_SELL';
      confidence = 0.76;
    } else if (composite <= SELL_THRESHOLD) {
      signal = 'SELL';
      confidence = 0.66;
    }

    // 눌림목 + 거래량 콤보: confidence 추가 상향 (Track B 진입 문턱 넘기 용이)
    if (tech.pullbackSignal && composite >= BUY_THRESHOLD && tech.volumeRatio >= PULLBACK_VOL_COMBO_THRESHOLD) {
      confidence = Math.min(MAX_CONFIDENCE, confidence + PULLBACK_CONFIDENCE_BOOST);
    }

    const reasoningParts = [
      `[RSS+NLP] tech=${baseScore}`,
      pullbackBonus > 0 ? `pb+${pullbackBonus}` : '',
      newsBonus !== 0 ? `news${newsBonus > 0 ? '+' : ''}${newsBonus}` : '',
      marketBonus !== 0 ? `mkt${marketBonus > 0 ? '+' : ''}${marketBonus}` : '',
      momentumBonus > 0 ? `momentum+${momentumBonus}` : '',
      ytBonus !== 0 ? `yt${ytBonus > 0 ? '+' : ''}${ytBonus}` : '',
      flowBonus !== 0 ? `flow${flowBonus > 0 ? '+' : ''}${flowBonus}` : '',
      overextendedPenalty < 0 ? `overextended${overextendedPenalty}` : '',
      `RSI=${tech.rsi14.toFixed(0)} vol=${tech.volumeRatio.toFixed(1)}x`,
      newsResult?.headlines?.[0] ? `"${newsResult.headlines[0].slice(0, 30)}"` : '',
    ]
      .filter(Boolean)
      .join(' ');

    results.push({
      stock_code: w.stock_code,
      composite_score: composite,
      fundamental_score: baseScore,
      technical_score: baseScore,
      sentiment_score: newsBonus + BASE_SCORE,
      signal,
      confidence,
      reasoning: reasoningParts,
    });
  }

  const above80 = results.filter((r) => r.composite_score >= 80).length;
  logger.info(`RSS 스코어링 완료: ${results.length}개, 80점+: ${above80}개`, { component: COMP });
  return results;
}
