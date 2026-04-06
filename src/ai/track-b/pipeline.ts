import { analyzeTechnicals } from '../../analysis/indicators.js';
import { getLearnedInsightsForPrompt } from '../../automation/self-learning.js';
import type { StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, logSystem } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getAccountBalance } from '../../kis/account.js';
import { getBatchPrices, getDailyChart, isMarketOpen } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { buildTrackBContext } from './context.js';
import { runClaudeExecution } from './executor.js';
import { technicalFallbackDecisions } from './technical-fallback.js';

/**
 * Track B 전체 파이프라인
 * 장중 5~15분 간격 실행
 *
 * 흐름:
 * 1. 장 열림 확인
 * 2. DB에서 캐싱된 스코어 + 열린 체인 로드
 * 3. KIS에서 실시간 시세 수집
 * 4. Claude에 컨텍스트 전달 → 매매 판단
 * 5. 판단 결과를 TradeExecutor로 전달 (HOLD 제외)
 */
export async function runTrackBPipeline(): Promise<TradeDecision[]> {
  const startTime = Date.now();
  logger.info('🔄 Track B 파이프라인 시작', { component: 'TRACK_B' });

  try {
    // 1. 장 열림 확인
    if (!isMarketOpen()) {
      logger.info('장이 닫혀있어 Track B 스킵', { component: 'TRACK_B' });
      return [];
    }

    // 2. 데이터 로드 (병렬)
    const [watchlist, openChains, strategy, balanceRaw, reservedWithdraw] = await Promise.all([
      getActiveWatchlist(),
      getOpenChains(),
      getActiveStrategy(),
      getAccountBalance(),
      import('../../automation/profit-withdraw.js').then(m => m.getTotalReserved()).catch(() => 0),
    ]);
    const balance = { ...balanceRaw, reservedWithdraw } as any;

    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_B' });
      return [];
    }

    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

    // 3. 캐싱된 스코어 로드 (Redis 우선 → DB fallback)
    const stockCodes = watchlist.map((w) => w.stock_code);
    const { getCachedScores } = await import('../../cache/redis.js');
    let scores = await getCachedScores(stockCodes);
    if (scores.length === 0) {
      scores = await getLatestScores(stockCodes);
    }

    if (scores.length === 0) {
      logger.warn('오늘의 AI 스코어가 없습니다 (Track A 미실행?)', { component: 'TRACK_B' });
    }

    // 4. 실시간 시세 수집 (열린 체인의 종목 포함)
    const chainStockCodes = openChains.map((c) => c.stock_code);
    const allStockCodes = [...new Set([...stockCodes, ...chainStockCodes])];
    const livePrices = await getBatchPrices(allStockCodes);

    // 5. 전 종목 차트 데이터 수집 (기술적 지표용)
    const chartData = new Map<string, import('../../kis/market.js').DailyCandle[]>();
    const allCodesForChart = [...new Set([...stockCodes, ...openChains.map((c) => c.stock_code)])];
    const chartBatchSize = 5;
    for (let i = 0; i < allCodesForChart.length; i += chartBatchSize) {
      const batch = allCodesForChart.slice(i, i + chartBatchSize);
      const results = await Promise.allSettled(batch.map((code) => getDailyChart(code, 65)));
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value.length >= 30) {
          chartData.set(batch[idx], result.value);
        }
      });
      if (i + chartBatchSize < allCodesForChart.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // 6. AI 키 유무에 따라 분기
    const hasAIKey = config.ai.anthropicKey && !config.ai.anthropicKey.startsWith('your_');

    let decisions: TradeDecision[];

    if (hasAIKey) {
      // ── AI 모드: Claude 매매 판단 ──
      const technicalsSummary: string[] = [];
      const topStocks = scores.slice(0, 5).map((s) => s.stock_code);
      for (const code of topStocks) {
        const candles = chartData.get(code);
        if (candles) {
          const result = analyzeTechnicals(candles);
          if (result) {
            technicalsSummary.push(
              `${code}: RSI=${result.rsi14.toFixed(0)} MACD=${result.macdCrossover} 볼린저=${result.bollingerPosition} 종합=${result.overallSignal}(${result.score}점)` +
                (result.goldenCross ? ' ⭐골든크로스' : '') +
                (result.deathCross ? ' ⚠️데드크로스' : ''),
            );
          }
        }
      }

      const learnedInsights = await getLearnedInsightsForPrompt().catch(() => '');

      let context = await buildTrackBContext({
        mode,
        scores,
        livePrices,
        openChains,
        balance,
      });

      if (technicalsSummary.length > 0) {
        context += `\n\n## 기술적 지표 분석\n${technicalsSummary.join('\n')}`;
      }
      if (learnedInsights) {
        context += `\n${learnedInsights}`;
      }

      decisions = await runClaudeExecution({
        mode,
        context,
        customPrompt: strategy?.claude_prompt ?? undefined,
      });
    } else {
      // ── 기술적 지표 모드: AI 없이 자동매매 ──
      logger.info('🔧 AI 키 미설정 → 기술적 지표 기반 자동매매 모드', { component: 'TRACK_B' });
      decisions = technicalFallbackDecisions({
        mode,
        watchlist: watchlist.map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
        livePrices,
        chartData,
        openChains,
        orderableCash: balance.orderableCash,
        maxPositionKrw: config.risk.maxPositionKrw,
      });
    }

    // 7. HOLD 제외한 액션만 필터
    const actionable = decisions.filter((d) => d.action !== 'HOLD');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await logSystem(
      'INFO',
      'TRACK_B',
      `파이프라인 완료 (${elapsed}초): ${decisions.length}개 판단, ${actionable.length}개 실행 대기`,
    );

    logger.info(`✅ Track B 완료 (${elapsed}초): 총 ${decisions.length}개 판단, ${actionable.length}개 액션`, {
      component: 'TRACK_B',
    });

    return actionable;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logSystem('ERROR', 'TRACK_B', `파이프라인 실패: ${msg}`);
    logger.error(`❌ Track B 실패: ${msg}`, { component: 'TRACK_B' });
    return []; // 실패 시 안전하게 아무것도 안 함
  }
}
