import { runBullBearDebate } from '../../ai/debate/bull-bear.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';
import type { StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getLatestScores } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getCurrentPrice, getDailyChart } from '../../kis/market.js';
import { isKillSwitchActive } from '../../risk/kill-switch.js';
import { tradeExecutor } from '../../trading/executor.js';
import { logger } from '../../utils/logger.js';
import { calcSplitQuantity } from '../../utils/money.js';
import { calcPositionSize } from '../position-sizer.js';
import { scanDisclosures } from './disclosure-scanner.js';
import type { SniperSignal } from './index.js';
import { scanInstitutionalSurge } from './institutional-surge.js';
import { scanTechnicalPatterns } from './technical-patterns.js';

/**
 * 🎯 스나이퍼 통합 실행기
 *
 * 모든 스나이퍼를 병렬 실행 → 시그널 수집 → 자동 매수 결정
 *
 * 일반 Track B와의 차이:
 * - Track B: AI 스코어 75점+ → 기본 예산 3분할 매수
 * - Sniper: 확정 패턴 감지 → 예산 1.2~1.5배 확대 → 즉시 진입
 */
export async function runSniperScan(): Promise<void> {
  if (isKillSwitchActive()) return;

  try {
    // 모든 스나이퍼 병렬 실행
    const [institutional, technical, disclosure] = await Promise.allSettled([
      scanInstitutionalSurge(),
      scanTechnicalPatterns(),
      scanDisclosures(),
    ]);

    const allSignals: SniperSignal[] = [
      ...(institutional.status === 'fulfilled' ? institutional.value : []),
      ...(technical.status === 'fulfilled' ? technical.value : []),
      ...(disclosure.status === 'fulfilled' ? disclosure.value : []),
    ];

    if (allSignals.length === 0) return;

    // 중복 종목 제거 (가장 높은 confidence 우선)
    const bestPerStock = new Map<string, SniperSignal>();
    for (const signal of allSignals) {
      const existing = bestPerStock.get(signal.stockCode);
      if (!existing || signal.confidence > existing.confidence) {
        bestPerStock.set(signal.stockCode, signal);
      }
    }

    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

    // 시그널 → 매매 결정 변환
    const decisions: TradeDecision[] = [];

    for (const [stockCode, signal] of bestPerStock) {
      try {
        const price = await getCurrentPrice(stockCode);

        // 🐂🐻 Bull-Bear 토론으로 스나이퍼 시그널 검증 (고액이므로 신중하게)
        let debateVerdict: string | undefined;
        try {
          const scores = await getLatestScores([stockCode]);
          const chart = await getDailyChart(stockCode, 65);
          const candles = chart.map((c) => ({
            date: c.date,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));
          const technicals = analyzeTechnicals(candles);

          const debate = await runBullBearDebate({
            stockCode,
            stockName: signal.stockName,
            aiScore: scores[0] ?? null,
            technicals,
            currentPrice: price,
          });

          debateVerdict = debate.finalVerdict;
          logger.info(
            `🏛️ 토론 결과: ${stockCode} → ${debateVerdict} (Bull ${debate.bullScore} vs Bear ${debate.bearScore})`,
            { component: 'SNIPER' },
          );
        } catch (debateErr) {
          logger.error(`AI 토론 실패 (${stockCode}), 안전을 위해 매수 보류: ${debateErr}`, { component: 'SNIPER' });
          continue; // 토론 실패 시 매수하지 않음
        }

        // 토론 결과가 매수 반대/보류이면 스나이퍼 시그널 무시
        if (!debateVerdict || debateVerdict === 'SELL' || debateVerdict === 'STRONG_SELL' || debateVerdict === 'HOLD') {
          logger.warn(`🏛️ AI 토론에서 기각/보류: ${stockCode} (${debateVerdict ?? 'N/A'}) → 매수 안 함`, {
            component: 'SNIPER',
          });
          continue;
        }

        // 승률 기반 포지션 사이징 × 스나이퍼 배수
        const sizing = await calcPositionSize(config.risk.maxPositionKrw);
        const sniperBudget = Math.min(
          Math.round(sizing.adjustedBudget * signal.budgetMultiplier),
          config.risk.maxPositionKrw,
        );

        const quantity = calcSplitQuantity(sniperBudget, price.currentPrice, 3, 0);
        if (quantity <= 0) continue;

        decisions.push({
          action: 'BUY',
          stock_code: stockCode,
          quantity,
          price_type: 'MARKET',
          reasoning: `[SNIPER ${signal.type}] ${signal.reasoning} | 토론: ${debateVerdict} (신뢰도 ${(signal.confidence * 100).toFixed(0)}%, 배수 x${signal.budgetMultiplier})`,
          confidence: signal.confidence,
        });

        logger.info(`🎯 스나이퍼 매수 결정: ${signal.stockName} x${quantity} @${price.currentPrice} (${signal.type})`, {
          component: 'SNIPER',
        });
      } catch {
        logger.warn(`스나이퍼 가격 조회 실패: ${stockCode}`, { component: 'SNIPER' });
      }
    }

    // 매매 실행
    if (decisions.length > 0) {
      await tradeExecutor.processDecisions(decisions, mode);
      logger.info(`🎯 스나이퍼 실행 완료: ${decisions.length}건`, { component: 'SNIPER' });
    }
  } catch (error) {
    logger.error(`스나이퍼 스캔 실패: ${error}`, { component: 'SNIPER' });
  }
}
