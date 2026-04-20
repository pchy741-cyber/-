import { GoogleGenerativeAI } from '@google/generative-ai';
import { cacheScores } from '../../cache/redis.js';
import { getActiveStrategy, getActiveWatchlist, getPool, getRecentSources, isMemoryMode, logSystem, upsertAIScore } from '../../db/client.js';
import { type DailyCandle, getDailyChart, getVolumeRankingStocks, getChangeRankingStocks, getBatchPrices } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { type ScoringResult } from '../../db/models.js';
import { runGeminiAnalysis } from './gemini.js';
import { runGeminiScoring } from './gemini-scorer.js';
import { getStockAccuracyContext } from '../../automation/self-learning.js';

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
    const watchlistCodes = new Set(watchlist.map((w) => w.stock_code));
    const [volumeTop, changeTop] = await Promise.allSettled([
      getVolumeRankingStocks('J', 50),
      getChangeRankingStocks(30),
    ]);
    const discoveryStocks = [
      ...(volumeTop.status === 'fulfilled' ? volumeTop.value : []),
      ...(changeTop.status === 'fulfilled' ? changeTop.value : []),
    ].filter((s) => !watchlistCodes.has(s.stock_code));
    // 중복 제거
    const discoveryMap = new Map(discoveryStocks.map((s) => [s.stock_code, s]));
    const discoveryList = [...discoveryMap.values()].slice(0, 50);

    // 발굴 종목을 watchlist에 inactive로 미리 등록 (ai_scores FK 제약 충족용)
    // Track B는 is_active=false 종목을 무시하므로 실제 매매 영향 없음
    if (discoveryList.length > 0 && !isMemoryMode()) {
      await Promise.allSettled(discoveryList.map((s) =>
        getPool().query(
          `INSERT INTO watchlist (stock_code, stock_name, is_active)
           VALUES ($1, $2, false)
           ON CONFLICT (stock_code) DO NOTHING`,
          [s.stock_code, s.stock_name || s.stock_code],
        )
      ));
      logger.info(`발굴 종목 ${discoveryList.length}개 watchlist 임시 등록 (inactive)`, { component: 'TRACK_A' });
    }

    const allStocks = [
      ...watchlist.map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
      ...discoveryList,
    ];
    logger.info(`감시 종목: ${watchlist.length}개 + 발굴 후보: ${discoveryList.length}개 = 합계 ${allStocks.length}개`, { component: 'TRACK_A' });

    // 2. CEO 전략 설정 로드
    const strategy = await getActiveStrategy();
    const mode = strategy?.mode ?? 'SWING';
    // NotebookLM 소스 파싱 (JSON 배열 또는 레거시 텍스트)
    let notebookPrompt = '';
    const rawNb = strategy?.notebooklm_prompt?.trim() || '';
    if (rawNb) {
      try {
        const sources = JSON.parse(rawNb) as Array<{ id?: string; title?: string; content?: string; created_at?: string }>;
        if (Array.isArray(sources) && sources.length > 0) {
          notebookPrompt = sources
            .map((s) => `### ${s.title || '소스'}\n${s.content || ''}`)
            .join('\n\n');
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
      const results = await Promise.allSettled(batch.map((w) => getDailyChart(w.stock_code, 60)));
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

    // 3-b. 종목별 배당수익률 일괄 조회 (현재가 API의 dvr 필드)
    const dividendData = new Map<string, number>();
    try {
      const priceMap = await getBatchPrices(allStocks.map((s) => s.stock_code));
      for (const [code, price] of priceMap.entries()) {
        if (price.dividendYield > 0) dividendData.set(code, price.dividendYield);
      }
      logger.info(`배당수익률 조회: ${dividendData.size}개 종목`, { component: 'TRACK_A' });
    } catch (err) {
      logger.warn(`배당수익률 조회 실패 (스킵): ${err}`, { component: 'TRACK_A' });
    }

    // 4. CEO 참고소스 로드 (market_sources 테이블 → Gemini 서론 주입)
    const dbSources = await getRecentSources(10);
    let combinedSources = additionalSources ?? '';
    if (dbSources.length > 0) {
      const sourcesText = dbSources.map((s) => {
        const typeLabel = s.source_type === 'youtube' ? '[YouTube]' : s.source_type === 'research' ? '[리서치]' : s.source_type === 'news' ? '[뉴스]' : '[기사]';
        return `${typeLabel} ${s.title}: ${s.url}${s.memo ? ` (메모: ${s.memo})` : ''}`;
      }).join('\n');
      combinedSources = combinedSources ? `${combinedSources}\n\n## CEO 등록 참고소스\n${sourcesText}` : `## CEO 등록 참고소스\n${sourcesText}`;
      logger.info(`참고소스 ${dbSources.length}건 Gemini에 주입`, { component: 'TRACK_A' });
    }

    // 4-b. 종목별 실거래 정확도 컨텍스트 주입 (score_accuracy 기반)
    try {
      const accuracyCtx = await getStockAccuracyContext(allStocks.map((s) => s.stock_code));
      if (accuracyCtx) {
        combinedSources = combinedSources ? `${combinedSources}\n${accuracyCtx}` : accuracyCtx;
        logger.info('실거래 정확도 컨텍스트 스코어링에 주입', { component: 'TRACK_A' });
      }
    } catch { /* 실패해도 스코어링 계속 */ }

    // 5. 3단 폴백: Gemini+GPT → Gemini+Claude → Gemini+기술적 → Claude 단독
    let scores: ScoringResult[] = [];
    let geminiResult: Awaited<ReturnType<typeof runGeminiAnalysis>> | null = null;

    // Step 5-1: Gemini 분석
    try {
      geminiResult = await runGeminiAnalysis({
        mode,
        watchlist: allStocks,
        chartData,
        dividendData: dividendData.size > 0 ? dividendData : undefined,
        additionalSources: combinedSources || undefined,
        customPrompt: customGeminiPrompt ?? undefined,
      });
    } catch (geminiErr) {
      logger.warn(`⚠️ Gemini 실패: ${geminiErr}`, { component: 'TRACK_A' });
    }

    // Step 5-2: Gemini 스코어링 (1순위 — 무료)
    if (geminiResult) {
      try {
        scores = await runGeminiScoring({
          mode,
          geminiAnalysis: geminiResult,
          customPrompt: customGptPrompt ?? undefined,
        });
      } catch (geminiScoreErr) {
        logger.warn(`⚠️ Gemini 스코어링 실패: ${geminiScoreErr}`, { component: 'TRACK_A' });
      }
    }

    // Step 5-3: Gemini 스코어링 실패 → Gemini Flash 통합 분석 (2순위 폴백)
    if (scores.length === 0) {
      try {
        scores = await runClaudeAnalysis(mode, allStocks, chartData, strategy);
      } catch (flashErr) {
        logger.warn(`⚠️ Gemini Flash 폴백 실패: ${flashErr}`, { component: 'TRACK_A' });
      }
    }

    // Step 5-4: 모두 실패 → 기술적 지표로 스코어 생성
    if (scores.length === 0) {
      logger.info('⚙️ AI 모두 실패 → 기술적 지표 기반 스코어 생성', { component: 'TRACK_A' });
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

        if (candles.length >= 30) {
          const tech = analyzeTechnicals(candles);
          if (tech) {
            compositeScore = Math.max(0, Math.min(100, 50 + tech.score));
            technicalScore = compositeScore;
          }
        }

        // 폴백 스코어: 신뢰도 0.4로 고정, 시그널은 항상 HOLD
        // → Track B hasBuyCandidates 필터(confidence >= 0.6)에서 걸러짐
        // → 기술적 폴백이 자체 지표로 직접 판단하므로 이 점수로 BUY 유입 방지
        return {
          stock_code: w.stock_code,
          composite_score: compositeScore,
          fundamental_score: 50,
          technical_score: technicalScore,
          sentiment_score: geminiResult?.market_sentiment === 'bullish' ? 65 : geminiResult?.market_sentiment === 'bearish' ? 35 : 50,
          confidence: 0.4,
          reasoning: `[폴백] ${reasoning}`,
          signal: 'HOLD' as const,
          target_price: analysis?.resistance_level ?? undefined,
          stop_loss_price: analysis?.support_level ?? undefined,
        };
      });
    }

    // 6. DB에 스코어 캐싱 (병렬 upsert — DB는 각 row 독립적)
    const today = new Date().toISOString().split('T')[0];
    await Promise.all(scores.map((score) =>
      upsertAIScore({
        stock_code: score.stock_code,
        score_date: today,
        gemini_summary: geminiResult?.stocks?.find((s) => s.stock_code === score.stock_code)?.analysis ?? null,
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
    ));

    // 6-1. 발굴 종목 중 고점수(≥70) + 고신뢰도(≥0.7) 자동 active 등록
    if (discoveryList.length > 0 && !isMemoryMode()) {
      const discoverySet = new Set(discoveryList.map((d) => d.stock_code));
      const topDiscovery = scores.filter(
        (s) => discoverySet.has(s.stock_code) && s.composite_score >= 58 && (s.confidence ?? 0) >= 0.58,
      );
      if (topDiscovery.length > 0) {
        await Promise.allSettled(topDiscovery.map((s) =>
          getPool().query(
            `UPDATE watchlist SET is_active = true, stock_name = COALESCE(NULLIF(stock_name, stock_code), $2), source = 'AUTO'
             WHERE stock_code = $1`,
            [s.stock_code, (s as any).stock_name ?? s.stock_code],
          )
        ));
        logger.info(
          `🌟 발굴 종목 ${topDiscovery.length}개 자동 활성화: ${topDiscovery.map((s) => `${s.stock_code}(${s.composite_score}점)`).join(', ')}`,
          { component: 'TRACK_A' },
        );
        await logSystem('INFO', 'TRACK_A', `발굴 종목 자동 활성화: ${topDiscovery.map((s) => s.stock_code).join(', ')}`);
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

/**
 * Gemini Flash 통합 분석+스코어링 (Gemini 스코어링 실패 시 폴백 — 무료 티어)
 */
async function runClaudeAnalysis(
  mode: string,
  watchlist: Array<{ stock_code: string; stock_name: string }>,
  chartData: Map<string, DailyCandle[]>,
  strategy: any,
): Promise<ScoringResult[]> {
  const key = config.ai.geminiKey || process.env.GEMINI_API_KEY;
  if (!key || key.startsWith('your_') || key.length < 10) {
    logger.warn('Gemini API 키 미설정 — Track A 폴백 분석 스킵', { component: 'TRACK_A' });
    return [];
  }
  const genAI = new GoogleGenerativeAI(key);

  const chartSummary = watchlist.map((stock) => {
    const candles = chartData.get(stock.stock_code) ?? [];
    if (candles.length === 0) return `${stock.stock_name}(${stock.stock_code}): 차트 데이터 없음`;
    const latest = candles[0];
    const high52w = Math.max(...candles.map((c) => c.high));
    const dropPct = latest ? (((latest.close - high52w) / high52w) * 100).toFixed(1) : 'N/A';
    return `${stock.stock_name}(${stock.stock_code}):
  종가: ${latest?.close}, 52주고가: ${high52w}, 고점대비: ${dropPct}%
  5일거래량: ${candles.slice(0, 5).map((c) => c.volume).join(',')}
  5일종가: ${candles.slice(0, 5).map((c) => c.close).join(',')}
  20일종가: ${candles.slice(0, 20).map((c) => c.close).join(',')}`;
  }).join('\n\n');

  const ceoPrompt = strategy?.gemini_prompt || strategy?.gpt_prompt || '';

  logger.info(`Gemini Flash 통합 분석 시작 (${watchlist.length}개 종목, 모드: ${mode})`, { component: 'TRACK_A' });

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.2,
    },
  }, { apiVersion: 'v1beta' });

  const prompt = `당신은 주식 분석+스코어링 전문가입니다. 아래 차트 데이터를 분석하여 종목별 점수를 매겨주세요.

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

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini Flash 응답에서 JSON을 찾을 수 없습니다');

  const parsed = JSON.parse(jsonMatch[0]) as { scores: ScoringResult[] };
  logger.info(`Gemini Flash 통합 분석 완료: ${parsed.scores.length}개 스코어`, { component: 'TRACK_A' });
  return parsed.scores;
}
