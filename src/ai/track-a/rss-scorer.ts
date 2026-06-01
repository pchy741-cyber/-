/**
 * RSS 뉴스 + 거래량 기반 스코어링 — AI 쿼터 없이 80~90점 생성
 *
 * 점수 구성:
 *   기술지표(analyzeTechnicals): 최대 75점
 *   뉴스 감성 보너스:           최대 +15점
 *   거래량/모멘텀 보너스:        최대 +10점
 *   외국인/기관 수급 보너스:     최대 +8점
 *   ─────────────────────────
 *   합계: 최대 108점 → min(100, 합계)
 */
import type { DailyCandle } from '../../kis/market.js';
import type { ScoringResult } from '../../db/models.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';
import { logger } from '../../utils/logger.js';

const COMP = 'RSS_SCORER';

// 한국 긍정/부정 키워드 (단순 감성 분석)
const POSITIVE_KW = ['실적개선','어닝서프라이즈','목표가상향','매수추천','신고가','수주','호재','수익증가','배당확대','자사주매입','영업이익','흑자','상향','증가','성장'];
const NEGATIVE_KW = ['실적부진','어닝쇼크','목표가하향','손실확대','악재','우려','감소','적자','하락','규제','소송','리콜','하향','감소','둔화'];

interface WatchlistItem { stock_code: string; stock_name: string; }

/** Google News RSS로 종목 뉴스 감성 점수 계산 (-15 ~ +15) */
async function getNewsScore(stockCode: string, stockName: string): Promise<number> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return 0;
    const xml = await res.text();

    // 최근 뉴스 제목 추출 (최대 5개)
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
      .slice(1, 6) // 첫번째는 피드 제목
      .map(m => m[1]);

    if (titles.length === 0) return 0;

    let score = 0;
    for (const title of titles) {
      const pos = POSITIVE_KW.filter(kw => title.includes(kw)).length;
      const neg = NEGATIVE_KW.filter(kw => title.includes(kw)).length;
      score += (pos - neg) * 3;
    }

    return Math.max(-15, Math.min(15, score));
  } catch {
    return 0;
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
  if (topGainerCodes.has(code)) bonus += 6;  // 오늘 등락률 상위
  if (topVolumeCodes.has(code)) bonus += 4;  // 오늘 거래량 상위

  // 최근 3일 상승 추세
  if (candles.length >= 4) {
    const recent = candles.slice(-4);
    const rising = recent.slice(1).every((c, i) => c.close >= recent[i].close);
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
  mode: string,
  watchlist: WatchlistItem[],
  chartData: Map<string, DailyCandle[]>,
  topGainerCodes: Set<string>,
  topVolumeCodes: Set<string>,
  flowAdjMap: Map<string, number>,
): Promise<ScoringResult[]> {
  logger.info(`RSS 스코어링 시작: ${watchlist.length}종목 (Gemini 대체)`, { component: COMP });
  const results: ScoringResult[] = [];

  // 뉴스 스코어는 상위 20종목만 (rate limit 방지)
  const topCandidates = watchlist.slice(0, 20);
  const newsScores = new Map<string, number>();

  await Promise.allSettled(
    topCandidates.map(async w => {
      const score = await getNewsScore(w.stock_code, w.stock_name);
      if (score !== 0) newsScores.set(w.stock_code, score);
    })
  );

  logger.info(`뉴스 스코어 완료: ${newsScores.size}종목`, { component: COMP });

  for (const w of watchlist) {
    const candles = chartData.get(w.stock_code) ?? [];
    if (candles.length < 30) continue;

    const tech = analyzeTechnicals(candles as any);
    if (!tech) continue;

    // 기술지표 기반 베이스 점수 (75점 캡 제거 — RSS 모드에서는 full range)
    let baseScore = 50 + Math.round(tech.score * 0.6);
    baseScore = Math.max(0, Math.min(82, baseScore)); // RSS 단독 상한 82

    const newsBonus = newsScores.get(w.stock_code) ?? 0;
    const momentumBonus = getMomentumScore(w.stock_code, candles, topGainerCodes, topVolumeCodes);
    const flowBonus = getFlowBonus(flowAdjMap.get(w.stock_code) ?? 0);

    // 눌림목 보너스: MA 이탈 후 반등 확인 = 최적 매수 타점
    const pullbackBonus = tech.pullbackSignal ? 8 : 0;
    // 눌림목 없고 base도 낮으면 과매수 주의 감점
    const overextendedPenalty = (!tech.pullbackSignal && baseScore < 70 && tech.volumeRatio < 1.3) ? -5 : 0;

    const composite = Math.min(100, baseScore + newsBonus + momentumBonus + flowBonus + pullbackBonus + overextendedPenalty);

    // 신호 결정 + 눌림목 확인 시 confidence 상향
    let signal: ScoringResult['signal'] = 'HOLD';
    let confidence = 0.55;
    if (composite >= 85) { signal = 'STRONG_BUY'; confidence = 0.72; }
    else if (composite >= 78) { signal = 'BUY'; confidence = 0.65; }
    else if (composite <= 35) { signal = 'SELL'; confidence = 0.65; }
    else if (composite <= 25) { signal = 'STRONG_SELL'; confidence = 0.72; }

    // 눌림목 + 거래량 콤보: confidence 추가 상향 (Track B 진입 문턱 넘기 용이)
    if (tech.pullbackSignal && composite >= 78 && tech.volumeRatio >= 1.3) {
      confidence = Math.min(0.82, confidence + 0.10);
    }

    const reasoningParts = [
      `[RSS] tech=${baseScore}`,
      pullbackBonus > 0 ? `pb+${pullbackBonus}` : '',
      newsBonus !== 0 ? `news${newsBonus > 0 ? '+' : ''}${newsBonus}` : '',
      momentumBonus > 0 ? `momentum+${momentumBonus}` : '',
      flowBonus !== 0 ? `flow${flowBonus > 0 ? '+' : ''}${flowBonus}` : '',
      overextendedPenalty < 0 ? `overextended${overextendedPenalty}` : '',
      `RSI=${tech.rsi14.toFixed(0)} vol=${tech.volumeRatio.toFixed(1)}x`,
    ].filter(Boolean).join(' ');

    results.push({
      stock_code: w.stock_code,
      composite_score: composite,
      fundamental_score: baseScore,
      technical_score: baseScore,
      sentiment_score: newsBonus + 50,
      signal,
      confidence,
      reasoning: reasoningParts,
    });
  }

  const above80 = results.filter(r => r.composite_score >= 80).length;
  logger.info(`RSS 스코어링 완료: ${results.length}개, 80점+: ${above80}개`, { component: COMP });
  return results;
}
