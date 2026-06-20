import { PARK_STOCK_CODE } from '../track-b/defense-park.js';
import { getStockAccuracyContext } from '../../automation/self-learning.js';
import { cacheScores } from '../../cache/redis.js';
import {
  getActiveStrategy,
  getActiveWatchlist,
  getPool,
  getRecentSources,
  isMemoryMode,
  logSystem,
  upsertAIScore,
} from '../../db/client.js';
import { type ScoringResult, ScoringResultSchema } from '../../db/models.js';
import {
  type DailyCandle,
  getBatchInvestorFlow,
  getBatchPrices,
  getChangeRankingStocks,
  getDailyChart,
  getKSTNow,
  getVolumeRankingStocks,
  isDelistingRisk,
} from '../../kis/market.js';
import { getCommunitysentiment } from '../../market/community-sentiment.js';
import { getKrTrendSignals } from '../../market/google-trends.js';
import { fetchStockDisclosures } from '../../market/krx-disclosure.js';
import { getKrxOptionsSignal } from '../../market/krx-options.js';
import { getMacroSignal } from '../../market/macro-signal.js';
import { safeParseScoresJson } from '../../utils/json-repair.js';
import { logger } from '../../utils/logger.js';
import { runGeminiAnalysis } from './gemini.js';
import { runGeminiScoring } from './gemini-scorer.js';
import { analyzeNewsWithGroq } from './groq-news.js';

function normalizeStockCode(raw: unknown): string {
  const text = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!text) return '';
  if (/^\d{1,6}$/.test(text)) return text.padStart(6, '0');
  return text.replace(/[^A-Z0-9.-]/g, '');
}

/**
 * Gemini Flash 통합 분석+스코어링 (Gemini 스코어링 실패 시 폴백 — 무료 티어)
 */
async function runGeminiFallbackAnalysis(
  mode: string,
  watchlist: Array<{ stock_code: string; stock_name: string }>,
  chartData: Map<string, DailyCandle[]>,
  strategy: any,
): Promise<ScoringResult[]> {
  const { callVertexGemini } = await import('../../utils/vertex-gemini.js');

  // ⚡ 토큰 절감: 20일 종가 제거 (5일이면 트렌드 판단 충분)
  const chartSummary = watchlist
    .map((stock) => {
      const candles = chartData.get(stock.stock_code) ?? [];
      if (candles.length === 0) return `${stock.stock_name}(${stock.stock_code}): 데이터없음`;
      const latest = candles[0];
      const high52w = Math.max(...candles.map((c) => c.high));
      const dropPct = latest ? (((latest.close - high52w) / high52w) * 100).toFixed(1) : 'N/A';
      return `${stock.stock_name}(${stock.stock_code}): 종가${latest?.close} 고점대비${dropPct}%
  5일종가:${candles
    .slice(0, 5)
    .map((c) => c.close)
    .join(',')} 5일거래량:${candles
    .slice(0, 5)
    .map((c) => c.volume)
    .join(',')}`;
    })
    .join('\n');

  const ceoPrompt = strategy?.gemini_prompt || strategy?.gpt_prompt || '';

  logger.info(`Gemini 통합 분석 시작 (${watchlist.length}개 종목, 모드: ${mode})`, { component: 'TRACK_A' });

  const userMsg = `당신은 주식 분석+스코어링 전문가입니다. 아래 차트 데이터를 분석하여 종목별 점수를 매겨주세요.

## 모드: ${mode}
${ceoPrompt ? `## CEO 지시사항\n${ceoPrompt}\n` : ''}
## 스코어링 룰
- 기본 50점 시작
- 기관/외국인 추정 순매수(거래량 급증): +15점
- 고점 대비 -10%~-25% 눌림목: +20점
- 거래량 급증(평균 2배+): +5점
- 상승 추세(5일 종가 > 20일 평균): +10점
- 하락 추세: -15점
- 과매수 구간(급등 후): -10점
- 소스/데이터 부족: 0점 NO_DATA

## 차트 데이터
${chartSummary}

## 출력 (JSON만, 다른 텍스트 금지)
{"scores":[{"stock_code":"코드","stock_name":"이름","composite_score":0,"fundamental_score":0,"technical_score":0,"sentiment_score":0,"confidence":0.0,"signal":"STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL|NO_DATA","target_price":0,"stop_loss_price":0,"reasoning":"근거"}]}`;

  const text = await callVertexGemini('당신은 주식 분석 전문가입니다. JSON 형식으로만 응답합니다.', userMsg, {
    temperature: 0.2,
    label: 'TrackA-Flash폴백',
  });

  // Resilient JSON parsing — 잘린 응답에서도 개별 스코어 복구
  const parsedResponse = safeParseScoresJson(text, 'GeminiFlashFallback');
  if (!parsedResponse || parsedResponse.scores.length === 0) {
    logger.warn('Gemini Flash 응답에서 스코어를 추출할 수 없음', {
      component: 'TRACK_A',
      rawLength: text.length,
      rawPreview: text.slice(0, 500),
    });
    return []; // throw 대신 빈 배열 반환
  }

  const rawScores = parsedResponse.scores;
  const validScores: ScoringResult[] = [];
  for (const score of rawScores) {
    const result = ScoringResultSchema.safeParse(score);
    if (result.success && result.data.signal !== 'NO_DATA') {
      validScores.push(result.data);
    } else if (!result.success) {
      const code =
        typeof score === 'object' && score !== null && 'stock_code' in score
          ? String((score as Record<string, unknown>).stock_code)
          : 'UNKNOWN';
      logger.warn(`Flash 폴백 스코어 검증 실패 (${code}): ${result.error.message}`, { component: 'TRACK_A' });
    }
  }
  logger.info(`Gemini Flash 통합 분석 완료: ${validScores.length}/${rawScores.length}개 유효`, {
    component: 'TRACK_A',
  });
  return validScores;
}

/**
 * Track A 전체 파이프라인
 * 하루 1~2회 실행 (장 시작 전 07:30, 장 마감 후 18:00)
 *
 * 흐름:
 * 1. DB에서 감시 목록 로드
 * 2. KIS에서 종목별 일봉 차트 수집
 * 3. Gemini 1.5 Pro → 정보 정제
 * 4. GPT-4o → 스코어링
 * 5. 결과를 ai_scores 테이블에 캐싱
 */
export async function runTrackAPipeline(additionalSources?: string): Promise<void> {
  const startTime = Date.now();
  logger.info('🚀 Track A 파이프라인 시작', { component: 'TRACK_A' });

  try {
    // 1. 감시 목록 로드 + 시장 발굴 종목 병합
    const watchlist = await getActiveWatchlist();
    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_A' });
      return;
    }

    // 시장 발굴: 거래량/등락률 상위 종목을 추가 스코어링 대상으로 병합 (워치리스트 순환에서 자동 추가 가능)
    // normalizeStockCode 적용 후 비교해야 포맷 불일치(앞자리 0 등)로 필터 뚫리는 것 방지
    const watchlistCodes = new Set(watchlist.map((w) => normalizeStockCode(w.stock_code)));
    const [volumeTop, changeTop] = await Promise.allSettled([
      getVolumeRankingStocks('J', 50),
      getChangeRankingStocks(30),
    ]);
    const discoveryStocks = [
      ...(volumeTop.status === 'fulfilled' ? volumeTop.value : []),
      ...(changeTop.status === 'fulfilled' ? changeTop.value : []),
    ].filter((s) => !watchlistCodes.has(normalizeStockCode(s.stock_code)));
    // 중복 제거
    const discoveryMap = new Map(discoveryStocks.map((s) => [normalizeStockCode(s.stock_code), s]));
    const discoveryList = [...discoveryMap.values()].slice(0, 50);

    // 발굴 종목을 watchlist에 inactive로 미리 등록 (ai_scores FK 제약 충족용)
    // Track B는 is_active=false 종목을 무시하므로 실제 매매 영향 없음
    if (discoveryList.length > 0 && !isMemoryMode()) {
      await Promise.allSettled(
        discoveryList.map((s) =>
          getPool().query(
            `INSERT INTO watchlist (stock_code, stock_name, is_active)
           VALUES ($1, $2, false)
           ON CONFLICT (stock_code) DO NOTHING`,
            [normalizeStockCode(s.stock_code), s.stock_name || s.stock_code],
          ),
        ),
      );
      logger.info(`발굴 종목 ${discoveryList.length}개 watchlist 임시 등록 (inactive)`, { component: 'TRACK_A' });
    }

    // 파킹 ETF는 스코어링 제외 (SOFR ETF / TIGER 머니마켓 등 — 일반 매매 종목 아님)
    const PARK_EXCLUDE = new Set([PARK_STOCK_CODE, '333940', '441680', '481770']);
    // allStocks: normalizeStockCode 적용 후 Map으로 최종 중복 제거 (watchlist 우선)
    const allStocksMap = new Map<string, { stock_code: string; stock_name: string }>();
    for (const s of [
      ...watchlist.map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
      ...discoveryList,
    ]) {
      const code = normalizeStockCode(s.stock_code);
      if (!code || PARK_EXCLUDE.has(code) || allStocksMap.has(code)) continue;
      allStocksMap.set(code, {
        stock_code: code,
        stock_name: String(s.stock_name ?? '').trim() || code,
      });
    }
    const allStocks = [...allStocksMap.values()];
    logger.info(
      `감시 종목: ${watchlist.length}개 + 발굴 후보: ${discoveryList.length}개 = 합계 ${allStocks.length}개 (중복제거 후)`,
      { component: 'TRACK_A' },
    );

    // 2. CEO 전략 설정 로드
    const strategy = await getActiveStrategy();
    const mode = strategy?.mode ?? 'SWING';
    // NotebookLM 소스 파싱 (JSON 배열 또는 레거시 텍스트)
    let notebookPrompt = '';
    const rawNb = strategy?.notebooklm_prompt?.trim() || '';
    if (rawNb) {
      try {
        const sources = JSON.parse(rawNb) as Array<{
          id?: string;
          title?: string;
          content?: string;
          created_at?: string;
        }>;
        if (Array.isArray(sources) && sources.length > 0) {
          notebookPrompt = sources.map((s) => `### ${s.title || '소스'}\n${s.content || ''}`).join('\n\n');
          const totalChars = notebookPrompt.length;
          logger.info(
            `📚 NotebookLM: ${sources.length}개 소스 Gemini 주입 (${totalChars}자) — [${sources.map((s) => s.title || '제목없음').join(', ')}]`,
            { component: 'TRACK_A' },
          );
        }
      } catch {
        notebookPrompt = rawNb; // 레거시 텍스트
        logger.info(`📚 NotebookLM: 레거시 텍스트 주입 (${rawNb.length}자)`, { component: 'TRACK_A' });
      }
    }
    const geminiBase = strategy?.gemini_prompt?.trim() || '';
    const customGeminiPrompt = notebookPrompt
      ? `## NotebookLM 소스 분석\n${notebookPrompt}\n\n${geminiBase}`
      : geminiBase || undefined;
    const customGptPrompt = strategy?.gpt_prompt;

    // 3. 종목별 차트 데이터 수집 — 5개씩 병렬 (kisRateLimiter가 내부 12/sec 관리)
    const chartData = new Map<string, DailyCandle[]>();
    const CHART_BATCH = 5;
    for (let i = 0; i < allStocks.length; i += CHART_BATCH) {
      const batch = allStocks.slice(i, i + CHART_BATCH);
      const results = await Promise.allSettled(batch.map((w) => getDailyChart(w.stock_code, 30)));
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled') {
          chartData.set(batch[j].stock_code, r.value);
        } else {
          logger.warn(`차트 수집 실패: ${batch[j].stock_code} - ${r.reason}`, { component: 'TRACK_A' });
          chartData.set(batch[j].stock_code, []);
        }
      }
    }

    // 3-b. 배당수익률 일괄 조회 + 상폐리스크 필터 (관리종목/거래정지/경고 종목 스코어링 제외)
    const dividendData = new Map<string, number>();
    try {
      const priceMap = await getBatchPrices(allStocks.map((s) => s.stock_code));

      // 상폐리스크 종목 스코어링 제외 — 워치리스트에서 제거하지 않음 (매수만 차단하면 충분)
      const delistRiskCodes: string[] = [];
      for (const [code, price] of priceMap.entries()) {
        if (isDelistingRisk(price)) {
          delistRiskCodes.push(code);
          logger.warn(
            `⚠️ 상폐리스크 종목 스코어링 제외: ${code} ${price.stockName} (halt=${price.haltYn} mang=${price.mangIssuClsCode} warn=${price.mrktWarnClsCode})`,
            { component: 'TRACK_A' },
          );
        }
        if (price.dividendYield > 0) dividendData.set(code, price.dividendYield);
      }
      if (delistRiskCodes.length > 0) {
        const riskSet = new Set(delistRiskCodes);
        allStocks.splice(0, allStocks.length, ...allStocks.filter((s) => !riskSet.has(s.stock_code)));
        logger.info(`상폐리스크 필터: ${delistRiskCodes.length}개 제외 → 잔여 ${allStocks.length}개 스코어링`, {
          component: 'TRACK_A',
        });
      }
      logger.info(`배당수익률 조회: ${dividendData.size}개 종목`, { component: 'TRACK_A' });
    } catch (err) {
      logger.warn(`배당수익률/상폐리스크 조회 실패 (스킵): ${err}`, { component: 'TRACK_A' });
    }

    // 3-c. 종목별 기관/외국인 수급 조회 (KIS INVESTOR_FLOW)
    let investorFlowSection = '';
    try {
      const flowMap = await getBatchInvestorFlow(allStocks.map((s) => s.stock_code));
      if (flowMap.size > 0) {
        const lines = [...flowMap.values()]
          .filter((f) => f.institutionNet !== 0 || f.foreignNet !== 0)
          .map((f) => {
            const inst =
              f.institutionNet > 0
                ? `기관 순매수 +${f.institutionNet.toLocaleString()}주`
                : `기관 순매도 ${f.institutionNet.toLocaleString()}주`;
            const frgn =
              f.foreignNet > 0
                ? `외국인 순매수 +${f.foreignNet.toLocaleString()}주`
                : `외국인 순매도 ${f.foreignNet.toLocaleString()}주`;
            return `${f.stockCode}: ${inst}, ${frgn}, 외국인보유율 ${f.foreignHoldingPct.toFixed(1)}%`;
          });
        if (lines.length > 0) {
          investorFlowSection = `## 당일 기관/외국인 수급 데이터 (KIS 실시간)\n${lines.join('\n')}`;
          logger.info(`수급 데이터 ${flowMap.size}개 종목 Gemini 주입`, { component: 'TRACK_A' });
        }
      }
    } catch (err) {
      logger.warn(`수급 조회 실패 (스킵): ${err}`, { component: 'TRACK_A' });
    }

    // 4. CEO 참고소스 로드 (market_sources 테이블 → Gemini 서론 주입)
    const dbSources = await getRecentSources(10);
    let combinedSources = additionalSources ?? '';
    if (dbSources.length > 0) {
      const sourcesText = dbSources
        .map((s) => {
          const typeLabel =
            s.source_type === 'youtube'
              ? '[YouTube]'
              : s.source_type === 'research'
                ? '[리서치]'
                : s.source_type === 'news'
                  ? '[뉴스]'
                  : '[기사]';
          return `${typeLabel} ${s.title}: ${s.url}${s.memo ? ` (메모: ${s.memo})` : ''}`;
        })
        .join('\n');
      combinedSources = combinedSources
        ? `${combinedSources}\n\n## CEO 등록 참고소스\n${sourcesText}`
        : `## CEO 등록 참고소스\n${sourcesText}`;
      logger.info(`참고소스 ${dbSources.length}건 스코어러에 주입`, { component: 'TRACK_A' });
    }

    // 4-a-2. 국내 AI 인사이트 갱신 + 주입 (최근 30일 실거래 패턴 분석 — GPT-4o-mini)
    try {
      const { generateKRInsights, getKRInsights } = await import('../overseas/insights-generator.js');
      await generateKRInsights(); // 4시간 간격 자동 스킵
      const krInsights = await getKRInsights();
      if (krInsights) {
        const section = `## 국내 실거래 AI 인사이트 (최근 30일 패턴)\n${krInsights}`;
        combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
        logger.info('국내 AI 인사이트 GPT 스코어러에 주입', { component: 'TRACK_A' });
      }
    } catch (err) {
      logger.warn(`국내 인사이트 로드 실패 (스킵): ${err}`, { component: 'TRACK_A' });
    }

    // 4-b. 종목별 실거래 정확도 컨텍스트 주입 (score_accuracy 기반)
    try {
      const accuracyCtx = await getStockAccuracyContext(allStocks.map((s) => s.stock_code));
      if (accuracyCtx) {
        combinedSources = combinedSources ? `${combinedSources}\n${accuracyCtx}` : accuracyCtx;
        logger.info('실거래 정확도 컨텍스트 스코어링에 주입', { component: 'TRACK_A' });
      }
    } catch {
      /* 실패해도 스코어링 계속 */
    }

    // 4-c. 기관/외국인 수급 데이터 주입
    if (investorFlowSection) {
      combinedSources = combinedSources ? `${combinedSources}\n\n${investorFlowSection}` : investorFlowSection;
    }

    // 4-j. 증권사 리서치 리포트 (네이버 리서치 자동 크롤링 → DB → Gemini 주입, 비용 0원)
    try {
      const { autoCrawlBrokerResearch, getBrokerResearchSection } = await import('./broker-research.js');
      await autoCrawlBrokerResearch(allStocks); // 새 리포트 자동 수집
      const brokerSection = await getBrokerResearchSection();
      if (brokerSection) {
        combinedSources = combinedSources ? `${combinedSources}\n\n${brokerSection}` : brokerSection;
        logger.info('증권사 리서치 스코어러에 주입', { component: 'TRACK_A' });
      }
    } catch (err) {
      logger.warn(`증권사 리서치 로드 실패 (스킵): ${err}`, { component: 'TRACK_A' });
    }

    // 4-k. DART 재무제표 AI 분석 (Vertex Gemini — GCP 크레딧 활용, 24시간 캐시)
    try {
      const { runDartResearchBatch } = await import('../../automation/dart-research.js');
      const topStockCodes = allStocks.slice(0, 5).map((s) => s.stock_code);
      const dartResults = await runDartResearchBatch(topStockCodes);
      const dartLines = dartResults
        .filter((r) => r.fundamentalScore !== undefined)
        .map((r) => {
          const fin = r.financial;
          const finLine = fin
            ? `매출YoY:${fin.revenueYoy > 0 ? '+' : ''}${fin.revenueYoy}% 영업이익YoY:${fin.operatingIncomeYoy > 0 ? '+' : ''}${fin.operatingIncomeYoy}% 마진:${fin.operatingMargin}% 부채비율:${fin.debtRatio}%`
            : '';
          return [
            `[${r.corpName}(${r.stockCode})] 펀더멘털:${r.fundamentalScore}점`,
            finLine,
            r.aiAnalysis ?? '',
            r.keyStrengths.length ? `강점:${r.keyStrengths.slice(0, 2).join(', ')}` : '',
            r.keyRisks.length ? `리스크:${r.keyRisks.slice(0, 2).join(', ')}` : '',
          ].filter(Boolean).join(' | ');
        });
      if (dartLines.length > 0) {
        const section = `## DART 재무제표 AI 분석 (Vertex Gemini GCP 크레딧)\n${dartLines.join('\n')}`;
        combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
        logger.info(`DART 재무 분석 ${dartLines.length}종목 스코어러에 주입 (Vertex AI)`, { component: 'TRACK_A' });
      }
    } catch (err) {
      logger.warn(`DART 재무 분석 실패 (스킵): ${err}`, { component: 'TRACK_A' });
    }

    // 4-d / 4-e / 4-f. 시장 인텔리전스 병렬 수집 (실패해도 파이프라인 계속)
    try {
      const stockMeta = allStocks.map((s) => ({ stockCode: s.stock_code, companyName: s.stock_name }));

      const [disclosures, trendSignals, groqSentiments, macroResult, communityResult, optionsResult] =
        await Promise.allSettled([
          fetchStockDisclosures(stockMeta), // 4-d. KRX KIND 공시
          getKrTrendSignals(stockMeta), // 4-f. Google Trends KR
          analyzeNewsWithGroq(stockMeta), // 4-e. Groq 뉴스 감성
          getMacroSignal(), // 4-g. 거시경제 신호 (USD/KRW + Nasdaq + FRED)
          getCommunitysentiment(stockMeta), // 4-h. 네이버 토론방 커뮤니티 감성
          getKrxOptionsSignal(), // 4-i. KRX 옵션 P/C + VKOSPI
        ]);

      // 4-d. KRX KIND 공시 섹션
      if (disclosures.status === 'fulfilled' && disclosures.value.length > 0) {
        const lines = disclosures.value.map((d) => `[${d.companyName}(${d.stockCode})] ${d.summary}`);
        const section = `## KRX KIND 당일 공시 (호재/악재 분류)\n${lines.join('\n')}`;
        combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
        logger.info(`KIND 공시 ${disclosures.value.length}종목 스코어러에 주입`, { component: 'TRACK_A' });
      }

      // 4-e. Groq 뉴스 감성 섹션
      if (groqSentiments.status === 'fulfilled' && groqSentiments.value.length > 0) {
        const lines = groqSentiments.value
          .filter((g) => Math.abs(g.score) >= 20) // 중립(±20 미만) 제외
          .map((g) => `${g.companyName}(${g.stockCode}): ${g.score > 0 ? '+' : ''}${g.score}점 — ${g.summary}`);
        if (lines.length > 0) {
          const section = `## Groq AI 뉴스 감성 분석 (Google News 기반)\n${lines.join('\n')}`;
          combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
          logger.info(`Groq 뉴스 감성 ${lines.length}건 스코어러에 주입`, { component: 'TRACK_A' });
        }
      }

      // 4-f. Google Trends 급등 섹션
      if (trendSignals.status === 'fulfilled' && trendSignals.value.length > 0) {
        const lines = trendSignals.value.map(
          (t) => `${t.companyName}(${t.stockCode}): Google Trends KR ${t.rank}위 (검색량 급등)`,
        );
        const section = `## Google Trends 한국 검색량 급등 종목\n${lines.join('\n')}`;
        combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
        logger.info(`Google Trends ${trendSignals.value.length}종목 스코어러에 주입`, { component: 'TRACK_A' });
      }

      // 4-g. 거시경제 신호 섹션
      if (macroResult.status === 'fulfilled') {
        const macro = macroResult.value;
        const section = `## 거시경제 신호 (${macro.direction})\n${macro.summary}\n점수 보정: ${macro.scoreAdj > 0 ? '+' : ''}${macro.scoreAdj}점 (전종목 반영)`;
        combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
        logger.info(`거시경제 신호 스코어러에 주입: ${macro.direction} (${macro.summary})`, { component: 'TRACK_A' });
      }

      // 4-h. 커뮤니티 감성 섹션
      if (communityResult.status === 'fulfilled' && communityResult.value.length > 0) {
        const meaningful = communityResult.value.filter((c) => Math.abs(c.score) >= 30);
        if (meaningful.length > 0) {
          const lines = meaningful.map(
            (c) =>
              `${c.companyName}(${c.stockCode}): 커뮤니티 ${c.score > 0 ? '+' : ''}${c.score}점 (게시글 ${c.postCount}건)`,
          );
          const section = `## 네이버 금융 토론방 커뮤니티 감성\n${lines.join('\n')}`;
          combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
          logger.info(`커뮤니티 감성 ${meaningful.length}종목 스코어러에 주입`, { component: 'TRACK_A' });
        }
      }

      // 4-i. KRX 옵션 플로우 섹션
      if (optionsResult.status === 'fulfilled') {
        const opt = optionsResult.value;
        const section = `## KRX 옵션 플로우 (기관 선행 지표)\n${opt.summary}\n공포지수(VKOSPI): ${opt.fearLevel} | P/C 비율: ${opt.pcRatio?.toFixed(2) ?? 'N/A'} | 시장 방향: ${opt.direction}`;
        combinedSources = combinedSources ? `${combinedSources}\n\n${section}` : section;
        logger.info(`KRX 옵션 신호 스코어러에 주입: ${opt.direction} fearLevel=${opt.fearLevel}`, {
          component: 'TRACK_A',
        });
      }
    } catch (err) {
      logger.warn(`시장 인텔리전스 수집 실패 (스킵): ${err}`, { component: 'TRACK_A' });
    }

    // 5. 레짐 감지 → 프롬프트 힌트
    let regimeHint: import('../prompts/track-a-analysis.js').RegimeHint = null;
    try {
      const { analyzeTechnicals: analyzeTech } = await import('../../analysis/indicators.js');
      const { detectRegimeV2 } = await import('../track-b/regime-v2.js');
      // 대표 종목(첫 5개)의 차트로 시장 레짐 판단
      const sampleStocks = allStocks.slice(0, 5);
      const regimeCounts = new Map<string, number>();
      for (const s of sampleStocks) {
        const candles = chartData.get(s.stock_code) ?? [];
        if (candles.length < 30) continue;
        const tech = analyzeTech(candles);
        if (!tech) continue;
        const closes = candles.map((c) => c.close);
        const result = detectRegimeV2(tech, closes);
        regimeCounts.set(result.regime, (regimeCounts.get(result.regime) ?? 0) + 1);
      }
      // 최다 레짐을 시장 레짐으로 설정
      let maxCount = 0;
      const validRegimes = new Set(['TREND_BULL', 'TREND_BEAR', 'RANGE_LOW_VOL', 'RANGE_HIGH_VOL', 'BREAKOUT', 'DISTRIBUTION']);
      for (const [regime, count] of regimeCounts) {
        if (count > maxCount && validRegimes.has(regime)) {
          maxCount = count;
          regimeHint = regime as NonNullable<typeof regimeHint>;
        }
      }
      if (regimeHint) {
        logger.info(`🎯 시장 레짐: ${regimeHint} (${maxCount}/${sampleStocks.length}개 종목)`, {
          component: 'TRACK_A',
        });
      }
    } catch {
      /* 레짐 감지 실패 시 null — 프롬프트 영향 없음 */
    }

    // 5-0. 앙상블 모드 분기
    let scores: ScoringResult[] = [];
    let geminiResult: Awaited<ReturnType<typeof runGeminiAnalysis>> | null = null;
    let scoringSource: 'gemini' | 'flash' | 'technical' = 'technical';

    const { config: appConfig } = await import('../../config/index.js');
    const ensembleEnabled = strategy?.ai_scoring_mode === 'ensemble';

    if (ensembleEnabled) {
      // 앙상블: Gemini 분석 먼저 시도 (있으면 ensemble에 제공, 없어도 OK)
      if (appConfig.geminiEnabled) {
        try {
          geminiResult = await runGeminiAnalysis({
            mode,
            watchlist: allStocks,
            chartData,
            dividendData: dividendData.size > 0 ? dividendData : undefined,
            additionalSources: combinedSources || undefined,
            customPrompt: customGeminiPrompt ?? undefined,
            regimeHint,
          });
        } catch (geminiErr) {
          logger.warn(`⚠️ 앙상블 Gemini 분석 실패 (계속 진행): ${geminiErr}`, { component: 'TRACK_A' });
        }
      }

      const topVolumeSet = new Set(
        volumeTop.status === 'fulfilled' ? volumeTop.value.slice(0, 30).map((s) => s.stock_code) : [],
      );
      const topGainerSet = new Set(
        changeTop.status === 'fulfilled' ? changeTop.value.slice(0, 20).map((s) => s.stock_code) : [],
      );

      const { runEnsembleScoring } = await import('./ensemble.js');
      scores = await runEnsembleScoring({
        mode,
        watchlist: allStocks,
        chartData,
        geminiAnalysis: geminiResult,
        strategy,
        regimeHint,
        ensembleConfig: strategy?.ensemble_config ?? undefined,
        topGainerCodes: topGainerSet,
        topVolumeCodes: topVolumeSet,
      });
      if (scores.length > 0) scoringSource = 'gemini'; // 앙상블 성공 → 최우선 source
      // 앙상블 실패 시 scores=[] → 아래 폴백 체인으로 자연스럽게 진입
    }

    // Step 5-0: GPT 1차 스코어링 — gpt-4o-mini로 전체 감시목록 스코어링
    // Gemini 강등 → GPT 실패 시 폴백으로만 사용 (CEO 지시 2026-06-17)
    if (scores.length === 0 && !ensembleEnabled && process.env.OPENAI_API_KEY) {
      try {
        const { runGPTScoring } = await import('./gpt-scorer.js');
        const gptPrimary = await runGPTScoring(mode, allStocks, chartData, regimeHint, strategy?.gpt_prompt ?? undefined, combinedSources || undefined);
        if (gptPrimary.length > 0) {
          scores = gptPrimary;
          scoringSource = 'gemini'; // Track B 호환성 유지
          logger.info(`✅ GPT 1차 스코어링 완료: ${scores.length}개 종목 (Gemini 강등됨)`, { component: 'TRACK_A' });

          // GPT 85+ 종목 → Claude 2차 검증
          const highScoreStocks = scores.filter((s) => s.composite_score >= 85);
          if (highScoreStocks.length > 0 && process.env.ANTHROPIC_API_KEY) {
            logger.info(`🎯 GPT 85+ ${highScoreStocks.length}개 → Claude 2차 검증`, { component: 'TRACK_A' });
            const verifyStocks = highScoreStocks.map((s) => {
              const wItem = allStocks.find((w) => w.stock_code === s.stock_code);
              return { stock_code: s.stock_code, stock_name: wItem?.stock_name ?? s.stock_code };
            });
            try {
              const { runClaudeScoring } = await import('./claude-scorer.js');
              const claudeScores = await runClaudeScoring(mode, verifyStocks, chartData, combinedSources || undefined);
              let verifiedCount = 0;
              let downgradedCount = 0;
              for (const gptScore of highScoreStocks) {
                const claude = claudeScores.find((s) => s.stock_code === gptScore.stock_code);
                if (!claude) continue;
                const avgScore = Math.round((gptScore.composite_score + claude.composite_score) / 2);
                const idx = scores.findIndex((s) => s.stock_code === gptScore.stock_code);
                if (idx === -1) continue;
                if (avgScore >= 80) {
                  scores[idx].composite_score = avgScore;
                  scores[idx].reasoning = `[GPT+Claude] GPT=${gptScore.composite_score} Claude=${claude.composite_score} → 평균${avgScore} | ${scores[idx].reasoning}`;
                  verifiedCount++;
                } else {
                  scores[idx].composite_score = Math.min(78, avgScore);
                  scores[idx].signal = 'BUY';
                  scores[idx].confidence = Math.min(scores[idx].confidence, 0.65);
                  scores[idx].reasoning = `[GPT+Claude 하향] GPT=${gptScore.composite_score} Claude=${claude.composite_score} → 평균${avgScore}<80 | ${scores[idx].reasoning}`;
                  downgradedCount++;
                }
              }
              logger.info(
                `🎯 Claude 2차 검증 완료: ${verifiedCount}개 통과, ${downgradedCount}개 하향`,
                { component: 'TRACK_A' },
              );
            } catch (claudeErr) {
              logger.warn(`⚠️ Claude 2차 검증 실패 (GPT 점수 유지): ${claudeErr}`, { component: 'TRACK_A' });
            }
          }
        }
      } catch (gptErr) {
        logger.warn(`⚠️ GPT 1차 스코어링 실패 → Gemini 폴백: ${gptErr}`, { component: 'TRACK_A' });
      }
    }

    // 5-1. Gemini 스코어링 제거 (2026-06-17 CEO 지시: Gemini → 뉴스 전용 격리)
    // GPT 실패/없을 때 → RSS 직행 (Gemini 무료 일일한도를 뉴스 분석에만 보존)
    if (scores.length === 0 && !ensembleEnabled) {
      logger.info('📰 GPT 없음/실패 → RSS 직행 (Gemini 뉴스 전용 격리, 스코어링 제외)', { component: 'TRACK_A' });
    }

    // Step 5-3b: RSS 뉴스+거래량 스코어링 (무료) — Gemini OFF 시 1순위 / 앙상블 실패 시 폴백
    if (scores.length === 0) {
      try {
        const { runRSSScoring } = await import('./rss-scorer.js');
        // 거래량/등락률 상위 Set 구성 (이미 수집된 discoveryStocks 활용)
        const topVolumeSet = new Set(
          volumeTop.status === 'fulfilled' ? volumeTop.value.slice(0, 30).map((s) => s.stock_code) : [],
        );
        const topGainerSet = new Set(
          changeTop.status === 'fulfilled' ? changeTop.value.slice(0, 20).map((s) => s.stock_code) : [],
        );
        scores = await runRSSScoring(mode, allStocks, chartData, topGainerSet, topVolumeSet, new Map());
        if (scores.length > 0) {
          scoringSource = 'flash';
          logger.info(`✅ RSS 스코어링 폴백 성공: ${scores.length}개 (Gemini/Claude 불필요, 무료)`, {
            component: 'TRACK_A',
          });
        }
      } catch (rssErr) {
        logger.warn(`⚠️ RSS 스코어링 폴백 실패: ${rssErr}`, { component: 'TRACK_A' });
      }
    }

    // Step 5-3c: RSS도 실패 → Claude Haiku 폴백
    if (scores.length === 0 && process.env.ANTHROPIC_API_KEY) {
      try {
        const { runClaudeScoring } = await import('./claude-scorer.js');
        scores = await runClaudeScoring(mode, allStocks, chartData, combinedSources || undefined);
        if (scores.length > 0) {
          scoringSource = 'flash';
          logger.info(`✅ Claude Haiku 폴백 성공: ${scores.length}개 스코어 (뉴스/매크로 포함)`, {
            component: 'TRACK_A',
          });
        }
      } catch (claudeErr) {
        logger.warn(`⚠️ Claude 폴백 실패: ${claudeErr}`, { component: 'TRACK_A' });
      }
    }

    // Step 5-4: 모두 실패 → 기술적 지표로 스코어 생성 (scoringSource 기본값 'technical')
    if (scores.length === 0) {
      logger.info('⚙️ AI 모두 실패 → 기술적 지표 기반 스코어 생성 (BUY/SELL 신호 활성)', { component: 'TRACK_A' });
      const { analyzeTechnicals } = await import('../../analysis/indicators.js');
      scores = allStocks.map((w) => {
        const candles = chartData.get(w.stock_code) ?? [];
        const geminiStock = geminiResult?.stocks?.find((s) => s.stock_code === w.stock_code);
        const analysis = geminiStock?.analysis;
        const reasoning = analysis
          ? `${analysis.positive_factors?.join(', ') || '정보없음'} / 리스크: ${analysis.negative_factors?.join(', ') || '없음'}`
          : 'Gemini 분석 없음';

        let compositeScore = 50;
        let technicalScore = 50;
        let tech: ReturnType<typeof analyzeTechnicals> = null;

        if (candles.length >= 30) {
          tech = analyzeTechnicals(candles);
          if (tech) {
            technicalScore = Math.max(0, Math.min(100, 50 + Math.round(tech.score * 0.5)));
            // 폴백 composite는 75 캡 — AI 없는 점수가 buyThreshold 83을 통과하지 못하게
            compositeScore = Math.min(75, technicalScore);
          }
        }

        // 기술적 지표 기반 신호 — AI 없어도 BUY/SELL 생성
        let signal: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL' | 'NO_DATA' = 'HOLD';
        let confidence = 0.5;
        if (tech) {
          if (tech.overallSignal === 'STRONG_BUY' || (tech.score >= 25 && tech.goldenCross)) {
            // 폴백 신뢰도 0.72→0.58: AI 검증 없는 기술 신호는 과신하지 않는다
            signal = 'STRONG_BUY';
            confidence = 0.58;
          } else if (tech.overallSignal === 'BUY' || tech.score >= 15) {
            signal = 'BUY';
            confidence = 0.62;
          } else if (tech.overallSignal === 'STRONG_SELL' || (tech.score <= -20 && tech.deathCross)) {
            signal = 'STRONG_SELL';
            confidence = 0.68;
          } else if (tech.overallSignal === 'SELL' || tech.score <= -10) {
            signal = 'SELL';
            confidence = 0.58;
          }
        }
        return {
          stock_code: w.stock_code,
          composite_score: compositeScore,
          fundamental_score: 50,
          technical_score: technicalScore,
          sentiment_score:
            geminiResult?.market_sentiment === 'bullish' ? 65 : geminiResult?.market_sentiment === 'bearish' ? 35 : 50,
          confidence,
          reasoning: `[기술적폴백] ${reasoning}`,
          signal,
          target_price: analysis?.resistance_level ?? undefined,
          stop_loss_price: analysis?.support_level ?? undefined,
        };
      });
    }

    // 6. DB에 스코어 캐싱 (병렬 upsert — DB는 각 row 독립적)
    const today = getKSTNow().toISOString().split('T')[0]; // KST 기준 — UTC 아님 (새벽 07:30 실행 시 UTC prev-day 방지)
    const geminiSummaryByCode = new Map((geminiResult?.stocks ?? []).map((s) => [s.stock_code, s.analysis]));

    // 폴백(Flash / 기술적) 시 오늘 이미 스코어가 있는 종목은 덮어쓰지 않음
    // 07:30 정식 Gemini 점수 → 12:00/14:00 폴백이 덮어쓰는 버그 방지
    let existingTodayCodes = new Set<string>();
    if (scoringSource !== 'gemini' && !isMemoryMode()) {
      try {
        const { rows } = await getPool().query(`SELECT stock_code FROM ai_scores WHERE score_date = $1`, [today]);
        existingTodayCodes = new Set(rows.map((r: Record<string, unknown>) => String(r.stock_code)));
        if (existingTodayCodes.size > 0) {
          logger.info(
            `⚙️ ${scoringSource === 'technical' ? '기술적' : 'Flash'} 폴백: 오늘 기존 점수 ${existingTodayCodes.size}개 보존 (덮어쓰기 생략)`,
            { component: 'TRACK_A' },
          );
        }
      } catch {
        /* 조회 실패 시 전체 upsert 진행 */
      }
    }

    await Promise.all(
      scores
        .filter((s) => scoringSource === 'gemini' || !existingTodayCodes.has(s.stock_code))
        .map((score) =>
          upsertAIScore({
            stock_code: score.stock_code,
            score_date: today,
            gemini_summary: geminiSummaryByCode.get(score.stock_code) ?? null,
            composite_score: score.composite_score,
            fundamental_score: score.fundamental_score,
            technical_score: score.technical_score,
            sentiment_score: score.sentiment_score,
            confidence: score.confidence,
            reasoning: score.reasoning,
            signal: score.signal,
            target_price: score.target_price ?? null,
            stop_loss_price: score.stop_loss_price ?? null,
          }),
        ),
    );

    // 6-1. 발굴 종목 중 고점수 자동 active 등록
    // AI 정상: score≥70 + confidence≥0.60 / AI 실패(기술 폴백): score≥75만으로 활성화
    if (discoveryList.length > 0 && !isMemoryMode()) {
      const discoverySet = new Set(discoveryList.map((d) => normalizeStockCode(d.stock_code)));
      const aiWorking = scores.some((s) => (s.confidence ?? 0) >= 0.3);
      const topDiscovery = scores.filter((s) => {
        if (!discoverySet.has(s.stock_code)) return false;
        if (aiWorking) return s.composite_score >= 70 && (s.confidence ?? 0) >= 0.6;
        return s.composite_score >= 75; // AI 실패 시 기술 점수만으로 판단
      });
      if (topDiscovery.length > 0) {
        await Promise.allSettled(
          topDiscovery.map((s) =>
            getPool().query(
              `UPDATE watchlist SET is_active = true, stock_name = COALESCE(NULLIF(stock_name, stock_code), $2), source = 'AUTO'
             WHERE stock_code = $1`,
              [s.stock_code, allStocksMap.get(s.stock_code)?.stock_name ?? s.stock_code],
            ),
          ),
        );
        logger.info(
          `🌟 발굴 종목 ${topDiscovery.length}개 자동 활성화: ${topDiscovery.map((s) => `${s.stock_code}(${s.composite_score}점)`).join(', ')}`,
          { component: 'TRACK_A' },
        );
        await logSystem(
          'INFO',
          'TRACK_A',
          `발굴 종목 자동 활성화: ${topDiscovery.map((s) => s.stock_code).join(', ')}`,
        );
      }
    }

    // 7. Redis에도 캐싱 (Track B에서 ms 단위 조회용)
    const aiScoresForCache = scores.map((score) => ({
      id: '',
      stock_code: score.stock_code,
      score_date: today,
      gemini_summary: null,
      composite_score: score.composite_score,
      fundamental_score: score.fundamental_score,
      technical_score: score.technical_score,
      sentiment_score: score.sentiment_score,
      confidence: score.confidence,
      reasoning: score.reasoning,
      signal: score.signal,
      target_price: score.target_price ?? null,
      stop_loss_price: score.stop_loss_price ?? null,
      created_at: new Date().toISOString(),
    }));
    await cacheScores(aiScoresForCache);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const buyCount = scores.filter((s) => s.composite_score >= 65).length;

    await logSystem(
      'INFO',
      'TRACK_A',
      `파이프라인 완료 (${elapsed}초): ${scores.length}개 스코어링, ${buyCount}개 매수 후보`,
    );
    logger.info(`✅ Track A 완료 (${elapsed}초): 스코어 ${scores.length}개, 매수후보 ${buyCount}개`, {
      component: 'TRACK_A',
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logSystem('ERROR', 'TRACK_A', `파이프라인 실패: ${msg}`);
    logger.error(`❌ Track A 실패: ${msg}`, { component: 'TRACK_A' });
    throw error;
  }
}
