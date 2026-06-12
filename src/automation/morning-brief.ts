/**
 * 장전 모닝브리프 — 08:40 실행
 *
 * 뉴스(매크로+종목) + 매크로스냅샷을 Gemini로 합산:
 *   → 오늘 시장 상황 한줄 요약 (KOSPI 방향, 위험 수준)
 *   → 종목별 뉴스 센티멘트 보정값 (-15 ~ +15)
 *
 * 결과는 getMorningBriefContext()로 캐시 제공 → opening-bell-job 워밍업 프롬프트에 주입
 */

import { getActiveWatchlist } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';
import { getMacroSnapshot } from './macro-data.js';
import { collectMacroNews, collectWatchlistNews, getTodayNews } from './news-collector.js';

export interface MorningBriefContext {
  marketSummary: string; // "VKOSPI=28 공포, KOSPI선물 -1.2%, 나스닥 -0.8% — 방어적 장세"
  riskLevel: 'LOW' | 'NEUTRAL' | 'HIGH' | 'EXTREME'; // 오늘 리스크 수준
  fearGreedIndex: number;
  vkospi: number;
  usdKrw: number;
  stockSentiments: Map<string, number>; // stock_code → -15 ~ +15
  macroHeadlines: string[]; // 주요 매크로 뉴스 3~5줄
  collectedAt: number;
}

let _briefCache: MorningBriefContext | null = null;
const CACHE_TTL_MS = 90 * 60 * 1000; // 90분 (장중 재사용)

/** 캐시된 모닝브리프 컨텍스트 반환 (없으면 null) */
export function getMorningBriefContext(): MorningBriefContext | null {
  if (!_briefCache) return null;
  if (Date.now() - _briefCache.collectedAt > CACHE_TTL_MS) return null;
  return _briefCache;
}

/** 08:40 KST 실행 — 뉴스+매크로 수집 → Gemini 합산 → 캐시 */
export async function runMorningBrief(): Promise<void> {
  logger.info('🌅 [MORNING_BRIEF] 장전 브리프 시작 (08:40)', { component: 'MORNING_BRIEF' });
  const t0 = Date.now();

  try {
    // 1. 매크로 + 뉴스 병렬 수집
    const [macro, _macroNewsText, _watchlistNewsText, watchlist] = await Promise.all([
      getMacroSnapshot(),
      collectMacroNews(),
      collectWatchlistNews(),
      getActiveWatchlist(),
    ]);

    // 2. 종목별 뉴스 읽기
    const stockNewsMap = getTodayNews();
    const stockCodes = watchlist.map((w) => w.stock_code);

    // 3. 리스크 레벨 결정 (Gemini 전 선행 판단)
    const riskLevel = assessRiskLevel(macro.vkospi, macro.fearGreedIndex, macro.kospiChange);

    // 4. 매크로 헤드라인 추출 (TOP 5)
    const macroHeadlines = extractHeadlines(_macroNewsText, 5);

    // 5. Gemini로 종목별 센티멘트 보정 + 시장 요약 생성
    const stockSentiments = new Map<string, number>();
    let marketSummary = buildFallbackSummary(macro, riskLevel);

    try {
      const { config: appCfg } = await import('../config/index.js');
      if (appCfg.geminiEnabled && (stockNewsMap.size > 0 || macroHeadlines.length > 0)) {
        const stockNewsLines = stockCodes
          .filter((code) => stockNewsMap.has(code))
          .map((code) => {
            const items = stockNewsMap.get(code)!.slice(0, 2);
            const name = watchlist.find((w) => w.stock_code === code)?.stock_name ?? code;
            return `${code}(${name}): ${items.map((i) => i.title).join(' | ')}`;
          })
          .slice(0, 15); // 최대 15종목

        const prompt = `당신은 한국 주식시장 전문 애널리스트입니다.
오늘 장 시작 전 시장 상황과 종목별 뉴스를 분석해서 간결한 브리프를 작성하세요.

## 매크로 지표
- VKOSPI: ${macro.vkospi.toFixed(1)} (25이상=공포, 35이상=극공포)
- USD/KRW: ${macro.usdKrw.toFixed(0)}
- KOSPI 전일 등락: ${macro.kospiChange > 0 ? '+' : ''}${macro.kospiChange.toFixed(2)}%
- Fear&Greed: ${macro.fearGreedIndex.toFixed(0)} (0=극공포, 100=극탐욕)
- 시장체제: ${macro.regime}

## 주요 매크로 뉴스 헤드라인
${macroHeadlines.slice(0, 5).join('\n') || '수집된 헤드라인 없음'}

## 감시 종목별 뉴스
${stockNewsLines.join('\n') || '수집된 종목 뉴스 없음'}

위 정보를 바탕으로 아래 JSON만 반환 (다른 텍스트 없이):
{
  "marketSummary": "오늘 시장 상황 한줄 요약 (50자 이내)",
  "stockAdjustments": [
    {"code": "종목코드", "adjustment": 숫자(-15~+15), "reason": "한줄이유"}
  ]
}

adjustment 기준:
- 호재 뉴스 (실적개선·수주·제품출시) → +5 ~ +15
- 악재 뉴스 (실적쇼크·소송·규제) → -5 ~ -15
- 뉴스 없거나 중립 → 0
- 매크로 VKOSPI>30 → 모든 종목에 -5 추가 적용 고려`;

        const raw = await callVertexGemini(prompt, '', {
          temperature: 0.1,
          maxOutputTokens: 1024,
          label: '모닝브리프',
        });

        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            marketSummary?: string;
            stockAdjustments?: Array<{ code: string; adjustment: number; reason: string }>;
          };
          if (parsed.marketSummary) marketSummary = parsed.marketSummary;
          for (const adj of parsed.stockAdjustments ?? []) {
            if (adj.code && typeof adj.adjustment === 'number') {
              stockSentiments.set(adj.code, Math.max(-15, Math.min(15, adj.adjustment)));
            }
          }
          logger.info(
            `🤖 [MORNING_BRIEF] Gemini 합산 완료 | 요약: "${marketSummary}" | 센티멘트 ${stockSentiments.size}종목`,
            { component: 'MORNING_BRIEF' },
          );
        }
      }
    } catch (gemErr) {
      logger.warn(`[MORNING_BRIEF] Gemini 실패, 폴백 사용: ${gemErr}`, { component: 'MORNING_BRIEF' });
    }

    _briefCache = {
      marketSummary,
      riskLevel,
      fearGreedIndex: macro.fearGreedIndex,
      vkospi: macro.vkospi,
      usdKrw: macro.usdKrw,
      stockSentiments,
      macroHeadlines,
      collectedAt: Date.now(),
    };

    logger.info(
      `✅ [MORNING_BRIEF] 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초) | 리스크=${riskLevel} | ${marketSummary}`,
      { component: 'MORNING_BRIEF' },
    );
  } catch (err) {
    logger.error(`[MORNING_BRIEF] 실패: ${err}`, { component: 'MORNING_BRIEF' });
  }
}

// ── 내부 헬퍼 ───────────────────────────────────────────────────────────────

function assessRiskLevel(vkospi: number, fearGreed: number, kospiChange: number): MorningBriefContext['riskLevel'] {
  if (vkospi >= 35 || fearGreed < 15 || kospiChange <= -3.0) return 'EXTREME';
  if (vkospi >= 25 || fearGreed < 30 || kospiChange <= -1.5) return 'HIGH';
  if (vkospi >= 18 || fearGreed < 45) return 'NEUTRAL';
  return 'LOW';
}

function buildFallbackSummary(
  macro: Awaited<ReturnType<typeof getMacroSnapshot>>,
  riskLevel: MorningBriefContext['riskLevel'],
): string {
  const riskLabel = { LOW: '안정', NEUTRAL: '중립', HIGH: '주의', EXTREME: '극공포' }[riskLevel];
  return `VKOSPI=${macro.vkospi.toFixed(0)} USD/KRW=${macro.usdKrw.toFixed(0)} F&G=${macro.fearGreedIndex.toFixed(0)} — ${riskLabel} 장세`;
}

function extractHeadlines(newsText: string, maxCount: number): string[] {
  if (!newsText) return [];
  return newsText
    .split('\n')
    .filter((line) => line.startsWith('- [') || line.startsWith('- '))
    .map((line) =>
      line
        .replace(/^- \[/, '')
        .replace(/\]\(.+?\)/, '')
        .replace(/^- /, '')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, maxCount);
}
