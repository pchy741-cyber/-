import { runBullBearDebate } from '../../ai/debate/bull-bear.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';
import type { StrategyMode } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { config } from '../../config/index.js';
import {
  getActiveStrategy,
  getLatestScores,
  getOpenChains,
  getRecentLossStocks,
  getTodayRepeatStopCodes,
} from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getCurrentPrice, getDailyChart } from '../../kis/market.js';
import { isKillSwitchActiveForMode } from '../../risk/kill-switch.js';
import { tradeExecutor } from '../../trading/executor.js';
import { logger } from '../../utils/logger.js';
import { getAccountBalance } from '../../kis/account.js';
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
  if (isKillSwitchActiveForMode('KR', getCtxIsPaper())) return;

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

    // 당일 손절 이력 + 7일 이내 손절 종목 → 스나이퍼 재진입 차단
    const [todayStopCodes, recentLossCodes, openChains] = await Promise.all([
      getTodayRepeatStopCodes(1), // 당일 1회 이상 손절이면 스나이퍼도 차단
      getRecentLossStocks(7),
      getOpenChains(getCtxIsPaper()),
    ]);
    const lossBlocked = new Set([...todayStopCodes, ...recentLossCodes]);
    if (lossBlocked.size > 0) {
      logger.warn(`🚫 스나이퍼 손절이력 차단: ${[...lossBlocked].join(', ')}`, { component: 'SNIPER' });
    }

    // 이미 추가매수 한도를 소진한 종목 → 스나이퍼 재진입 차단
    const avgMaxedCodes = new Set<string>();
    for (const chain of openChains) {
      if (chain.current_averaging_count >= chain.max_averaging_count) {
        avgMaxedCodes.add(chain.stock_code);
      }
    }
    if (avgMaxedCodes.size > 0) {
      logger.info(`🚫 스나이퍼 추가매수 한도 소진: ${[...avgMaxedCodes].join(', ')}`, { component: 'SNIPER' });
    }

    // 중복 종목 제거 (가장 높은 confidence 우선) + 손절 차단 적용
    const bestPerStock = new Map<string, SniperSignal>();
    for (const signal of allSignals) {
      if (lossBlocked.has(signal.stockCode)) {
        logger.info(`🚫 스나이퍼 차단(손절이력): ${signal.stockCode}`, { component: 'SNIPER' });
        continue;
      }
      if (avgMaxedCodes.has(signal.stockCode)) {
        logger.info(`🚫 스나이퍼 차단(추가매수 한도 소진): ${signal.stockCode}`, { component: 'SNIPER' });
        continue;
      }
      const existing = bestPerStock.get(signal.stockCode);
      if (!existing || signal.confidence > existing.confidence) {
        bestPerStock.set(signal.stockCode, signal);
      }
    }

    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;

    // 총자산 기반 동적 포지션 사이징 (paper/live 자동 분리)
    let sniperMaxPositionKrw = config.risk.maxPositionKrw;
    try {
      const balance = await getAccountBalance();
      const totalAssets = balance.netAsset > 0 ? balance.netAsset : balance.orderableCash + balance.totalEvalAmount;
      if (totalAssets > 0) {
        // Track B와 동일 기준: 총자산 20% (paper/live 총자산이 다르므로 자동 분리)
        sniperMaxPositionKrw = Math.min(Math.round(totalAssets * 0.2), config.risk.maxPositionKrw);
      }
    } catch (err) {
      logger.debug(`스나이퍼 잔고 조회 실패 (기존 한도 사용): ${err}`, { component: 'SNIPER' });
    }
    logger.info(`🎯 스나이퍼 포지션 한도: ${sniperMaxPositionKrw.toLocaleString()}원 (${getCtxIsPaper() ? '연습' : '실전'})`, { component: 'SNIPER' });

    // 시그널 → 매매 결정 변환
    const decisions: TradeDecision[] = [];

    for (const [stockCode, signal] of bestPerStock) {
      try {
        const price = await getCurrentPrice(stockCode);

        // 🐂🐻 Bull-Bear 토론으로 스나이퍼 시그널 검증 (고액이므로 신중하게)
        let debateVerdict: string | undefined;
        let debateSource = 'DEBATE';
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

          // DEBATE AI가 전부 실패(분析 실패)했으면 Track A 스코어로 폴백
          const debateFailed = debate.bullArguments[0] === '분析 실패' && debate.bearArguments[0] === '분析 실패';
          if (debateFailed && scores[0]) {
            const score = scores[0].composite_score ?? 0;
            debateVerdict = score >= 85 ? 'STRONG_BUY' : score >= 75 ? 'BUY' : 'HOLD';
            debateSource = `TRACK_A_FALLBACK(${score}점)`;
            logger.warn(`🏛️ DEBATE AI 실패 → Track A 폴백: ${stockCode} 스코어 ${score}점 → ${debateVerdict}`, {
              component: 'SNIPER',
            });
          } else {
            debateVerdict = debate.finalVerdict;
          }

          logger.info(
            `🏛️ 토론 결과: ${stockCode} → ${debateVerdict} [${debateSource}] (Bull ${debate.bullScore} vs Bear ${debate.bearScore})`,
            { component: 'SNIPER' },
          );
        } catch (debateErr) {
          logger.error(`AI 토론 실패 (${stockCode}), 스나이퍼 시그널 강도로 판단: ${debateErr}`, {
            component: 'SNIPER',
          });
          // 예외 발생 시: 시그널 신뢰도가 충분히 높으면 통과 (자사주 매입 등 강력한 공시)
          debateVerdict = signal.confidence >= 0.85 ? 'BUY' : undefined;
          debateSource = 'SIGNAL_CONFIDENCE_FALLBACK';
        }

        // 토론 결과가 매수 반대/보류이면 스나이퍼 시그널 무시
        if (!debateVerdict || debateVerdict === 'SELL' || debateVerdict === 'STRONG_SELL' || debateVerdict === 'HOLD') {
          logger.warn(`🏛️ AI 토론에서 기각/보류: ${stockCode} (${debateVerdict ?? 'N/A'}) → 매수 안 함`, {
            component: 'SNIPER',
          });
          continue;
        }

        // 승률 기반 포지션 사이징 × 스나이퍼 배수 (총자산 비례 — paper/live 자동 분리)
        const sizing = await calcPositionSize(sniperMaxPositionKrw);
        const sniperBudget = Math.min(
          Math.round(sizing.adjustedBudget * signal.budgetMultiplier),
          sniperMaxPositionKrw,
        );

        const quantity = calcSplitQuantity(sniperBudget, price.currentPrice, 3, 0);
        if (quantity <= 0) continue;

        decisions.push({
          action: 'BUY',
          stock_code: stockCode,
          quantity,
          price_type: 'MARKET',
          reasoning: `[SNIPER ${signal.type}] ${signal.reasoning} | 토론: ${debateVerdict} [${debateSource}] (신뢰도 ${(signal.confidence * 100).toFixed(0)}%, 배수 x${signal.budgetMultiplier})`,
          confidence: signal.confidence,
        });

        logger.info(`🎯 스나이퍼 매수 결정: ${signal.stockName} x${quantity} @${price.currentPrice} (${signal.type})`, {
          component: 'SNIPER',
        });
      } catch (err) {
        logger.warn(`스나이퍼 가격 조회 실패 (${stockCode}): ${err}`, { component: 'SNIPER' });
      }
    }

    // 매매 실행
    if (decisions.length > 0) {
      await tradeExecutor.processDecisions(decisions, mode, 'SNIPER');
      logger.info(`🎯 스나이퍼 실행 완료: ${decisions.length}건`, { component: 'SNIPER' });
    }
  } catch (error) {
    logger.error(`스나이퍼 스캔 실패: ${error}`, { component: 'SNIPER' });
  }
}
