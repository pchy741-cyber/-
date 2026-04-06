import Anthropic from '@anthropic-ai/sdk';
import { cacheScores } from '../../cache/redis.js';
import { getActiveStrategy, getActiveWatchlist, getRecentSources, logSystem, upsertAIScore } from '../../db/client.js';
import { type DailyCandle, getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { type ScoringResult } from '../../db/models.js';
import { runGeminiAnalysis } from './gemini.js';
import { runGPTScoring } from './scorer.js';

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
    // 1. 감시 목록 로드
    const watchlist = await getActiveWatchlist();
    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_A' });
      return;
    }
    logger.info(`감시 종목: ${watchlist.length}개`, { component: 'TRACK_A' });

    // 2. CEO 전략 설정 로드
    const strategy = await getActiveStrategy();
    const mode = strategy?.mode ?? 'SWING';
    const customGeminiPrompt = strategy?.gemini_prompt;
    const customGptPrompt = strategy?.gpt_prompt;

    // 3. 종목별 차트 데이터 수집 (병렬, 5개씩 배치)
    const chartData = new Map<string, DailyCandle[]>();
    const batchSize = 5;

    for (let i = 0; i < watchlist.length; i += batchSize) {
      const batch = watchlist.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map((stock) => getDailyChart(stock.stock_code, 60)));

      results.forEach((result, idx) => {
        const stockCode = batch[idx].stock_code;
        if (result.status === 'fulfilled') {
          chartData.set(stockCode, result.value);
        } else {
          logger.warn(`차트 수집 실패: ${stockCode} - ${result.reason}`, {
            component: 'TRACK_A',
          });
          chartData.set(stockCode, []);
        }
      });

      // KIS rate limit 대응
      if (i + batchSize < watchlist.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
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

    // 5. Claude 통합 분석+스코어링 (Gemini/GPT 실패 시 폴백)
    let scores: ScoringResult[];
    let geminiResult: Awaited<ReturnType<typeof runGeminiAnalysis>> | null = null;
    try {
      // Gemini → GPT 순차 시도
      geminiResult = await runGeminiAnalysis({
        mode,
        watchlist: watchlist.map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
        chartData,
        additionalSources: combinedSources || undefined,
        customPrompt: customGeminiPrompt ?? undefined,
      });
      scores = await runGPTScoring({
        mode,
        geminiAnalysis: geminiResult,
        customPrompt: customGptPrompt ?? undefined,
      });
    } catch (aiErr) {
      logger.warn(`⚠️ Gemini/GPT 실패 → Claude 통합 모드: ${aiErr}`, { component: 'TRACK_A' });
      scores = await runClaudeAnalysis(mode, watchlist, chartData, strategy);
    }

    // 6. DB에 스코어 캐싱
    const today = new Date().toISOString().split('T')[0];
    for (const score of scores) {
      await upsertAIScore({
        stock_code: score.stock_code,
        score_date: today,
        gemini_summary: geminiResult?.stocks.find((s) => s.stock_code === score.stock_code)?.analysis ?? null,
        composite_score: score.composite_score,
        fundamental_score: score.fundamental_score,
        technical_score: score.technical_score,
        sentiment_score: score.sentiment_score,
        confidence: score.confidence,
        reasoning: score.reasoning,
        signal: score.signal,
        target_price: score.target_price ?? null,
        stop_loss_price: score.stop_loss_price ?? null,
      });
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
    const buyCount = scores.filter((s) => s.composite_score >= 75).length;

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
 * Claude 통합 분석+스코어링 (Gemini/GPT 실패 시 폴백)
 */
async function runClaudeAnalysis(
  mode: string,
  watchlist: Array<{ stock_code: string; stock_name: string }>,
  chartData: Map<string, DailyCandle[]>,
  strategy: any,
): Promise<ScoringResult[]> {
  if (!config.ai.anthropicKey || config.ai.anthropicKey.startsWith('your_')) {
    logger.warn('Anthropic API 키 미설정 — Track A Claude 분석 스킵', { component: 'TRACK_A' });
    return [];
  }
  const anthropic = new Anthropic({ apiKey: config.ai.anthropicKey });

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

  logger.info(`Claude 통합 분석 시작 (${watchlist.length}개 종목, 모드: ${mode})`, { component: 'TRACK_A' });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `당신은 주식 분석+스코어링 전문가입니다. 아래 차트 데이터를 분석하여 종목별 점수를 매겨주세요.

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
{"scores":[{"stock_code":"코드","stock_name":"이름","composite_score":0,"fundamental_score":0,"technical_score":0,"sentiment_score":0,"confidence":0.0,"signal":"STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL|NO_DATA","target_price":0,"stop_loss_price":0,"reasoning":"근거"}]}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude 응답에서 JSON을 찾을 수 없습니다');

  const parsed = JSON.parse(jsonMatch[0]) as { scores: ScoringResult[] };
  logger.info(`Claude 통합 분석 완료: ${parsed.scores.length}개 스코어`, { component: 'TRACK_A' });
  return parsed.scores;
}
