/**
 * AI 뉴스 분석 파이프라인 v22.1 — 비용 최소화 하이브리드
 *
 * 3단계 파이프라인:
 *   ① FinBERT (무료) — 헤드라인별 sentiment 사전 분석
 *   ② Gemini (최소 토큰) — 사전분석 요약만 입력, 종합 판단 + 한줄 요약
 *   ③ 폴백 — Gemini 실패 시 FinBERT + 키워드 결합
 *
 * 비용:
 *   - FinBERT: 무료 (HuggingFace Inference API)
 *   - Gemini: ~150 토큰 입력 (사전분석 요약만 전달) → 기존 500+ 대비 70% 절감
 *   - 30분 캐시로 하루 최대 16회 호출
 *
 * 기존 키워드 매칭(crash-profit.ts)과 독립 — 이 모듈이 우선, 폴백 시 키워드 사용
 */

import { logger } from '../utils/logger.js';

// ── 타입 ────────────────────────────────────────────────────────────────

export interface AnalyzedHeadline {
  title: string;
  sentiment: number;         // -1.0 ~ +1.0
  impact: number;            // 0~100
  category: string;          // MONETARY | GEOPOLITICAL | EARNINGS | INSTITUTIONAL | TRADE | SYSTEMIC | MACRO | OTHER
  summary: string;           // AI 한줄 요약
  isSystemicRisk: boolean;
  source: 'finbert' | 'keyword';  // 센티먼트 출처
}

export interface NewsAnalysis {
  headlines: AnalyzedHeadline[];
  overallSentiment: number;       // -1.0 ~ +1.0
  regimeAdjustment: number;       // -5 ~ +3
  marketImpactSummary: string;    // AI 종합 한줄
  deepAnalysis: string;           // 3~5문장 딥 분석
  bullCatalysts: string[];        // AI가 판별한 상승 촉매
  bearCatalysts: string[];        // AI가 판별한 하락 촉매
  outlook: string;                // SHORT_TERM_BULL / BEAR / NEUTRAL
  analysisSource: 'hybrid' | 'finbert_only' | 'fallback';
  analyzedAt: number;
}

// ── 캐시 ────────────────────────────────────────────────────────────────
let _analysisCache: NewsAnalysis | null = null;
const ANALYSIS_TTL = 30 * 60 * 1000;

export function getCachedNewsAnalysis(): NewsAnalysis | null {
  if (!_analysisCache) return null;
  if (Date.now() - _analysisCache.analyzedAt > ANALYSIS_TTL) return null;
  return _analysisCache;
}

// ── 메인 ────────────────────────────────────────────────────────────────

export async function analyzeNewsHeadlines(
  rawHeadlines?: Array<{ title: string; source: string; publishedAt: string }>,
): Promise<NewsAnalysis> {
  if (_analysisCache && Date.now() - _analysisCache.analyzedAt < ANALYSIS_TTL) {
    return _analysisCache;
  }

  // 1. 헤드라인 수집
  let headlines = rawHeadlines;
  if (!headlines) {
    try {
      const { getMacroHeadlines } = await import('./news-collector.js');
      headlines = await getMacroHeadlines();
    } catch {
      headlines = [];
    }
  }

  if (headlines.length === 0) {
    const empty: NewsAnalysis = {
      headlines: [],
      overallSentiment: 0,
      regimeAdjustment: 0,
      marketImpactSummary: '수집된 뉴스 없음',
      deepAnalysis: '',
      bullCatalysts: [],
      bearCatalysts: [],
      outlook: 'SHORT_TERM_NEUTRAL',
      analysisSource: 'fallback',
      analyzedAt: Date.now(),
    };
    _analysisCache = empty;
    return empty;
  }

  // 2. 중복 제거
  const deduped = deduplicateHeadlines(headlines.map((h) => h.title));

  // 3. ① FinBERT 사전 분석 (무료)
  const preScoredHeadlines = await preScoreWithFinBERT(deduped);

  // 4. ② Gemini 최소 토큰 종합 (사전분석 요약만 입력)
  try {
    const { config } = await import('../config/index.js');
    if (config.geminiEnabled) {
      const result = await callGeminiWithPreScored(preScoredHeadlines);
      if (result) {
        _analysisCache = result;
        logger.info(
          `🧠 [NEWS_AI] 하이브리드 분석 완료: ${result.headlines.length}건 | 센티먼트=${result.overallSentiment.toFixed(2)} | regime=${result.regimeAdjustment} | "${result.marketImpactSummary}"`,
          { component: 'NEWS_AI' },
        );
        return result;
      }
    }
  } catch (err) {
    logger.debug(`[NEWS_AI] Gemini 종합 실패, FinBERT 단독 사용: ${err}`, { component: 'NEWS_AI' });
  }

  // 5. ③ 폴백: FinBERT 결과만으로 종합
  const fallback = buildFromPreScored(preScoredHeadlines, 'finbert_only');
  _analysisCache = fallback;
  logger.info(
    `🧠 [NEWS_AI] FinBERT 단독 분석: ${fallback.headlines.length}건 | 센티먼트=${fallback.overallSentiment.toFixed(2)} | regime=${fallback.regimeAdjustment}`,
    { component: 'NEWS_AI' },
  );
  return fallback;
}

// ── ① FinBERT 사전 분석 ────────────────────────────────────────────────

interface PreScoredHeadline {
  title: string;
  finbertSentiment: number;  // -1 ~ +1
  finbertLabel: string;      // positive/negative/neutral
  isSystemicRisk: boolean;
  category: string;
}

async function preScoreWithFinBERT(titles: string[]): Promise<PreScoredHeadline[]> {
  const results: PreScoredHeadline[] = [];

  // FinBERT 배치 (무료, 24h 캐시)
  let finbertAvailable = !!process.env.HF_API_KEY;
  let finbertModule: typeof import('../market/finbert-sentiment.js') | null = null;
  if (finbertAvailable) {
    try {
      finbertModule = await import('../market/finbert-sentiment.js');
    } catch {
      finbertAvailable = false;
    }
  }

  for (const title of titles) {
    let sentiment = 0;
    let label = 'neutral';

    if (finbertAvailable && finbertModule) {
      try {
        const fb = await finbertModule.analyzeSentiment(title);
        if (fb) {
          sentiment = fb.signedScore;
          label = fb.label;
        }
      } catch { /* FinBERT 실패 시 키워드 폴백 */ }
    }

    // FinBERT 실패/미설정 시 키워드 기반
    if (label === 'neutral' && sentiment === 0) {
      const kw = keywordSentiment(title);
      sentiment = kw.sentiment;
      label = kw.label;
    }

    const isSystemic = SYSTEMIC_KW.some((kw) => title.includes(kw));
    const category = classifyCategory(title);

    results.push({ title, finbertSentiment: sentiment, finbertLabel: label, isSystemicRisk: isSystemic, category });
  }

  return results;
}

// ── ② Gemini 최소 토큰 종합 ────────────────────────────────────────────

async function callGeminiWithPreScored(scored: PreScoredHeadline[]): Promise<NewsAnalysis | null> {
  const { callVertexGemini } = await import('../utils/vertex-gemini.js');

  // 사전분석 요약: 헤드라인 대신 "센티먼트 점수 + 카테고리" 전달 → 토큰 70% 절감
  const positiveCount = scored.filter((s) => s.finbertSentiment > 0.2).length;
  const negativeCount = scored.filter((s) => s.finbertSentiment < -0.2).length;
  const neutralCount = scored.length - positiveCount - negativeCount;
  const systemicCount = scored.filter((s) => s.isSystemicRisk).length;
  const avgSentiment = scored.reduce((s, h) => s + h.finbertSentiment, 0) / (scored.length || 1);

  // 시스템 리스크 + 고영향 헤드라인만 원문 전달 (최대 5개)
  const importantHeadlines = scored
    .filter((s) => s.isSystemicRisk || Math.abs(s.finbertSentiment) >= 0.5)
    .slice(0, 5)
    .map((s) => `[${s.finbertLabel}/${s.category}] ${s.title}`)
    .join('\n');

  // 카테고리 분포
  const catCounts: Record<string, number> = {};
  for (const s of scored) {
    catCounts[s.category] = (catCounts[s.category] ?? 0) + 1;
  }
  const catSummary = Object.entries(catCounts)
    .filter(([, c]) => c > 0)
    .map(([cat, c]) => `${cat}:${c}`)
    .join(' ');

  const prompt = `당신은 한국 주식시장 전문 애널리스트입니다. 뉴스 ${scored.length}건 AI 사전분석 결과:
- 긍정 ${positiveCount}건 / 부정 ${negativeCount}건 / 중립 ${neutralCount}건
- 시스템리스크 키워드: ${systemicCount}건
- 평균센티먼트: ${avgSentiment.toFixed(2)} (-1부정~+1긍정)
- 카테고리: ${catSummary}
${importantHeadlines ? `\n주요 헤드라인:\n${importantHeadlines}` : ''}

위 사전분석을 전문 애널리스트 수준으로 종합하여 JSON만 반환:
{"regimeAdjustment":0,"marketImpactSummary":"한줄요약30자","deepAnalysis":"3~5문장 딥분석","bullCatalysts":["상승촉매1","상승촉매2"],"bearCatalysts":["하락촉매1","하락촉매2"],"outlook":"SHORT_TERM_NEUTRAL","headlineSummaries":[{"idx":0,"summary":"요약"}]}

규칙:
- regimeAdjustment: -5~+3 (시장 장세 점수 조정. 국민연금매도=-3, Fed금리인하=+2, 평범=0)
- marketImpactSummary: 투자자용 오늘 뉴스 종합 한줄 (한국어 30자)
- deepAnalysis: 전문가 수준 시장 분석 3~5문장. 현재 시장 핵심 동인, 단기 전망, 주의 리스크 포함. 구체적 수치와 맥락을 서술.
- bullCatalysts: 뉴스에서 추출한 상승 촉매 (최대 4개, 구체적으로)
- bearCatalysts: 뉴스에서 추출한 하락 촉매 (최대 4개, 구체적으로)
- outlook: SHORT_TERM_BULL / SHORT_TERM_BEAR / SHORT_TERM_NEUTRAL 중 하나
- headlineSummaries: 시스템리스크/고영향 헤드라인만 요약 (나머지 생략)
- 부정문 구분 필수: "금리인상 중단"→긍정, "전쟁 회피"→긍정`;

  const raw = await Promise.race([
    callVertexGemini(
      '한국 주식시장 전문 애널리스트. 딥한 시장 분석을 JSON으로 반환.',
      prompt,
      { temperature: 0.1, maxOutputTokens: 800, label: '뉴스-AI종합' },
    ),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
  ]);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]) as {
    regimeAdjustment?: number;
    marketImpactSummary?: string;
    deepAnalysis?: string;
    bullCatalysts?: string[];
    bearCatalysts?: string[];
    outlook?: string;
    headlineSummaries?: Array<{ idx: number; summary: string }>;
  };

  // Gemini 종합 결과 + FinBERT 개별 결과 합성
  const summaryMap = new Map<number, string>();
  for (const hs of parsed.headlineSummaries ?? []) {
    summaryMap.set(hs.idx, hs.summary);
  }

  const headlines: AnalyzedHeadline[] = scored.map((s, i) => ({
    title: s.title,
    sentiment: s.finbertSentiment,
    impact: s.isSystemicRisk ? 80 : Math.round(Math.abs(s.finbertSentiment) * 60),
    category: s.category,
    summary: summaryMap.get(i) ?? '',
    isSystemicRisk: s.isSystemicRisk,
    source: (s.finbertLabel !== 'neutral' ? 'finbert' : 'keyword') as 'finbert' | 'keyword',
  }));

  return {
    headlines,
    overallSentiment: clamp(avgSentiment, -1, 1),
    regimeAdjustment: clamp(parsed.regimeAdjustment ?? 0, -5, 3),
    marketImpactSummary: parsed.marketImpactSummary ?? '',
    deepAnalysis: parsed.deepAnalysis ?? '',
    bullCatalysts: Array.isArray(parsed.bullCatalysts) ? parsed.bullCatalysts : [],
    bearCatalysts: Array.isArray(parsed.bearCatalysts) ? parsed.bearCatalysts : [],
    outlook: parsed.outlook ?? 'SHORT_TERM_NEUTRAL',
    analysisSource: 'hybrid',
    analyzedAt: Date.now(),
  };
}

// ── ③ FinBERT 단독 종합 (Gemini 없이) ──────────────────────────────────

function buildFromPreScored(scored: PreScoredHeadline[], source: NewsAnalysis['analysisSource']): NewsAnalysis {
  const avgSentiment = scored.reduce((s, h) => s + h.finbertSentiment, 0) / (scored.length || 1);
  const systemicCount = scored.filter((s) => s.isSystemicRisk).length;

  let regimeAdj = 0;
  if (systemicCount >= 2) regimeAdj = -4;
  else if (systemicCount >= 1) regimeAdj = -2;
  else if (avgSentiment < -0.3) regimeAdj = -1;
  else if (avgSentiment > 0.3) regimeAdj = 1;

  const headlines: AnalyzedHeadline[] = scored.map((s) => ({
    title: s.title,
    sentiment: s.finbertSentiment,
    impact: s.isSystemicRisk ? 80 : Math.round(Math.abs(s.finbertSentiment) * 60),
    category: s.category,
    summary: '',
    isSystemicRisk: s.isSystemicRisk,
    source: 'finbert' as const,
  }));

  // FinBERT 단독 시 bull/bear 촉매 추출
  const bullCatalysts = scored.filter((s) => s.finbertSentiment > 0.3).map((s) => s.title).slice(0, 3);
  const bearCatalysts = scored.filter((s) => s.finbertSentiment < -0.3).map((s) => s.title).slice(0, 3);
  const outlook = regimeAdj > 0 ? 'SHORT_TERM_BULL' : regimeAdj < 0 ? 'SHORT_TERM_BEAR' : 'SHORT_TERM_NEUTRAL';

  return {
    headlines,
    overallSentiment: clamp(avgSentiment, -1, 1),
    regimeAdjustment: clamp(regimeAdj, -5, 3),
    marketImpactSummary: systemicCount > 0
      ? `시스템 리스크 ${systemicCount}건 — 경계`
      : avgSentiment < -0.2 ? '부정 뉴스 우세' : avgSentiment > 0.2 ? '긍정 뉴스 우세' : '중립 장세',
    deepAnalysis: '',
    bullCatalysts,
    bearCatalysts,
    outlook,
    analysisSource: source,
    analyzedAt: Date.now(),
  };
}

// ── 중복 제거 ───────────────────────────────────────────────────────────

function deduplicateHeadlines(titles: string[]): string[] {
  const unique: string[] = [];
  for (const title of titles) {
    const words = new Set(title.replace(/[^\w가-힣\s]/g, '').split(/\s+/).filter(Boolean));
    let isDup = false;
    for (const existing of unique) {
      const ew = new Set(existing.replace(/[^\w가-힣\s]/g, '').split(/\s+/).filter(Boolean));
      const inter = [...words].filter((w) => ew.has(w)).length;
      const union = new Set([...words, ...ew]).size;
      if (union > 0 && inter / union >= 0.5) { isDup = true; break; }
    }
    if (!isDup) unique.push(title);
  }
  return unique.slice(0, 20);
}

// ── 키워드 센티먼트 (FinBERT 미사용 시 폴백) ───────────────────────────

const NEG_KW = [
  '폭락', '급락', '하락', '위기', '공포', '침체', '전쟁', '제재', '매도', '손실',
  '파산', '디폴트', '부도', '긴축', '금리인상', '투매', '패닉', '붕괴',
  'crash', 'plunge', 'fear', 'fall', 'drop', 'sell-off', 'recession',
];
const POS_KW = [
  '상승', '반등', '랠리', '신고가', '회복', '호재', '매수', '완화', '금리인하',
  '실적개선', '수주', '돌파',
  'rally', 'surge', 'gain', 'record', 'rise', 'bull',
];

function keywordSentiment(title: string): { sentiment: number; label: string } {
  const lower = title.toLowerCase();
  let neg = 0, pos = 0;
  for (const kw of NEG_KW) if (lower.includes(kw)) neg++;
  for (const kw of POS_KW) if (lower.includes(kw)) pos++;
  const sentiment = clamp((pos - neg) * 0.3, -1, 1);
  const label = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
  return { sentiment, label };
}

// ── 시스템 리스크 키워드 ────────────────────────────────────────────────

const SYSTEMIC_KW = [
  '국민연금', '연기금', '리밸런싱', '대량매도', '매도폭탄', '오버행',
  '금융위기', '시스템리스크', '신용경색', '뱅크런', '자금이탈',
  '서킷브레이커', '사이드카', '패닉셀', '투매',
  '금리인상', '긴축', '테이퍼링', '양적긴축',
  '전쟁', '제재', '무역전쟁', '관세', '수출규제',
  '블록딜', '대량매각', '공매도과열', '마진콜',
  '경기침체', '디폴트', '부도', '파산', '신용등급하향',
];

// ── 카테고리 분류 ───────────────────────────────────────────────────────

function classifyCategory(title: string): string {
  const t = title.toLowerCase();
  if (/금리|기준금리|fed|fomc|인상|인하|양적|긴축|통화/.test(t)) return 'MONETARY';
  if (/전쟁|제재|북한|미중|관세|수출규제|지정학/.test(t)) return 'GEOPOLITICAL';
  if (/실적|어닝|매출|영업이익|순이익|분기|반기/.test(t)) return 'EARNINGS';
  if (/국민연금|연기금|기관|외국인|순매수|순매도|블록딜/.test(t)) return 'INSTITUTIONAL';
  if (/무역|수출|수입|관세|fta|통상/.test(t)) return 'TRADE';
  if (/위기|붕괴|서킷|사이드카|뱅크런|디폴트|파산/.test(t)) return 'SYSTEMIC';
  if (/gdp|cpi|고용|실업|pmi|소비자|경기/.test(t)) return 'MACRO';
  return 'OTHER';
}

// ── 유틸 ────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
