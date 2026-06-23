/**
 * 📈 전략 최적화기 (TP/SL 그리드 서치)
 *
 * 매일 19:30 실행 — 각 전략 모드별로 백테스트 엔진을 활용하여
 * 최적 TP/SL 파라미터를 탐색.
 *
 * v10.11.3: 데이터 스누핑 방지 대폭 강화
 *   - Train(60%)/Test(40%) 시간순 분리 (동일 데이터 사용 금지)
 *   - Walk-Forward WFE >= 0.5 필수 (OOS 검증 통과 시만 적용)
 *   - -Infinity currentSharpe 가드 (빈 데이터→아무거나 적용 방지)
 *   - 벤치마크 차트 병렬 로드 (Promise.all)
 *
 * 토큰 비용: $0 (DB + 결정론적 백테스트만 사용)
 */

import { type BacktestConfig, runBacktest, runWalkForward } from '../backtest/engine.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { getPool } from '../db/client.js';
import { getDailyChart } from '../kis/market.js';
import { getStrategyPerformance } from '../risk/strategy-performance.js';
import { logger } from '../utils/logger.js';

const COMP = 'OPTIMIZER';

// 최적화 대상 전략 (DIVIDEND: 매수 안 함, EOD_BETTING: 별도 체계)
const TARGET_MODES: StrategyMode[] = ['SWING', 'DEFENSE', 'SNIPER', 'BOTTOM_FISHING', 'BREAKOUT'];

// 그리드 서치 범위
const TP_STEPS = [-1.0, -0.5, 0, 0.5, 1.0]; // 현재값 기준 ±1%
const SL_STEPS = [-0.5, -0.25, 0, 0.25, 0.5]; // 현재값 기준 ±0.5%

// 백테스트 대상 종목 (대형주 대표)
const BENCHMARK_CODES = ['005930', '000660', '035420', '005380', '051910']; // 삼성전자, SK하이닉스, NAVER, 현대차, LG화학

/** Train/Test 분리 비율 — 시간순 앞 60% = train, 뒤 40% = test */
const TRAIN_RATIO = 0.6;
/** Walk-Forward 최소 효율 — OOS 성과가 IS의 50% 이상이어야 적용 */
const MIN_WFE = 0.5;

interface OptimizerResult {
  mode: StrategyMode;
  currentTp: number;
  currentSl: number;
  bestTp: number;
  bestSl: number;
  bestSharpe: number;
  bestPF: number;
  bestWinRate: number;
  currentSharpe: number;
  improved: boolean;
  applied: boolean;
  wfeValidated?: boolean;
}

/**
 * 전략 최적화기 메인 — 매일 19:30 실행
 */
export async function runStrategyOptimizer(): Promise<OptimizerResult[]> {
  const pool = getPool();
  const results: OptimizerResult[] = [];

  logger.info('📈 ═══ 전략 최적화기 시작 ═══', { component: COMP });

  // 벤치마크 종목 차트 데이터 병렬 로드 (120일)
  const chartMap = new Map<string, Awaited<ReturnType<typeof getDailyChart>>>();
  const chartLoadResults = await Promise.allSettled(
    BENCHMARK_CODES.map(async (code) => {
      const candles = await getDailyChart(code, 120);
      return { code, candles };
    }),
  );
  for (const r of chartLoadResults) {
    if (r.status === 'fulfilled' && r.value.candles.length >= 60) {
      chartMap.set(r.value.code, r.value.candles);
    } else if (r.status === 'rejected') {
      logger.warn(`📈 차트 로드 실패: ${r.reason}`, { component: COMP });
    }
  }

  if (chartMap.size === 0) {
    logger.warn('📈 차트 데이터 없음 — 최적화 중단', { component: COMP });
    return [];
  }

  for (const mode of TARGET_MODES) {
    try {
      const params = STRATEGY_PARAMS[mode];
      if (!params) continue;

      const currentTp = params.takeProfitPct;
      const currentSl = params.stopLossPct;

      // Paper 성과 조회 (30일)
      const paperPerf = await getStrategyPerformance(mode, 30, true);

      // ═══ Train/Test 시간순 분리 ═══
      // 각 벤치마크 차트를 시간순으로 앞 60% = train, 뒤 40% = test
      // Train에서 최적 파라미터 탐색 → Test에서 검증 (데이터 스누핑 방지)
      type ChartData = Awaited<ReturnType<typeof getDailyChart>>;
      const trainChartMap = new Map<string, ChartData>();
      const testChartMap = new Map<string, ChartData>();
      for (const [code, fullCandles] of chartMap) {
        const sorted = [...fullCandles].sort((a, b) => a.date.localeCompare(b.date));
        const splitIdx = Math.floor(sorted.length * TRAIN_RATIO);
        if (splitIdx < 40 || sorted.length - splitIdx < 20) continue; // 최소 train 40봉, test 20봉
        trainChartMap.set(code, sorted.slice(0, splitIdx));
        testChartMap.set(code, sorted.slice(splitIdx));
      }

      if (trainChartMap.size === 0) {
        logger.info(`  ⚠️ ${mode}: train 데이터 부족 — 스킵`, { component: COMP });
        continue;
      }

      // 그리드 서치: TP × SL 조합별 백테스트 (Train 데이터만 사용)
      let bestSharpe = -Infinity;
      let bestTp: number = currentTp;
      let bestSl: number = currentSl;
      let bestPF = 0;
      let bestWinRate = 0;
      let currentSharpe = -Infinity;

      for (const tpDelta of TP_STEPS) {
        for (const slDelta of SL_STEPS) {
          const testTp = Math.max(0.5, currentTp + tpDelta);
          const testSl = Math.min(-0.3, currentSl + slDelta); // SL은 음수

          // 각 벤치마크 종목에 대해 Train 백테스트
          let totalSharpe = 0;
          let totalPF = 0;
          let totalWR = 0;
          let validCount = 0;

          for (const [code, trainCandles] of trainChartMap) {
            const config: BacktestConfig = {
              mode,
              initialCapital: 100_000_000,
              maxPositionPct: 25,
            };

            const testConfig: BacktestConfig = {
              ...config,
              overrideTp: testTp,
              overrideSl: testSl,
            };

            try {
              const result = runBacktest(trainCandles, code, testConfig);
              if (result.totalTrades >= 3) {
                totalSharpe += result.sharpeRatio;
                totalPF += result.profitFactor;
                totalWR += result.winRate;
                validCount++;
              }
            } catch (btErr) {
              logger.warn(`📈 백테스트 실패 ${mode}/${code}: ${btErr}`, { component: COMP });
            }
          }

          if (validCount === 0) continue;
          const avgSharpe = totalSharpe / validCount;
          const avgPF = totalPF / validCount;
          const avgWR = totalWR / validCount;

          // 현재값 기준 Sharpe 기록
          if (tpDelta === 0 && slDelta === 0) {
            currentSharpe = avgSharpe;
          }

          if (avgSharpe > bestSharpe) {
            bestSharpe = avgSharpe;
            bestTp = testTp;
            bestSl = testSl;
            bestPF = avgPF;
            bestWinRate = avgWR;
          }
        }
      }

      // ═══ -Infinity 가드: 현재 파라미터로 유효 거래가 없으면 적용 금지 ═══
      if (!Number.isFinite(currentSharpe)) {
        logger.info(
          `  ⚠️ ${mode}: 현재 파라미터 유효거래 0건 (currentSharpe=N/A) → 변경 보류`,
          { component: COMP },
        );
        results.push({
          mode, currentTp, currentSl, bestTp, bestSl,
          bestSharpe: Number.isFinite(bestSharpe) ? bestSharpe : 0,
          bestPF, bestWinRate, currentSharpe: 0, improved: false, applied: false,
        });
        continue;
      }

      const improved = bestSharpe > currentSharpe * 1.05; // 5% 이상 개선 시만 적용
      let applied = improved && paperPerf.totalTrades >= 10; // 10건 이상 거래 데이터 있을 때만
      let wfeValidated = false;

      // ═══ OOS 검증: Test 데이터에서 best 파라미터 성과 확인 ═══
      if (applied) {
        let oosValid = true;
        let oosSharpeSum = 0;
        let oosValidCount = 0;

        for (const [code, testCandles] of testChartMap) {
          try {
            const oosResult = runBacktest(testCandles, code, {
              mode,
              initialCapital: 100_000_000,
              maxPositionPct: 25,
              overrideTp: bestTp,
              overrideSl: bestSl,
            });
            if (oosResult.totalTrades >= 2) {
              oosSharpeSum += oosResult.sharpeRatio;
              oosValidCount++;
            }
          } catch { /* skip */ }
        }

        if (oosValidCount > 0) {
          const avgOosSharpe = oosSharpeSum / oosValidCount;
          // OOS Sharpe가 Train Sharpe의 50% 미만 = 과적합
          if (avgOosSharpe < bestSharpe * MIN_WFE) {
            logger.info(
              `  ⚠️ ${mode}: OOS 검증 실패 (Train Sharpe=${bestSharpe.toFixed(2)}, OOS Sharpe=${avgOosSharpe.toFixed(2)}, WFE=${(avgOosSharpe / bestSharpe).toFixed(2)} < ${MIN_WFE}) → 적용 보류`,
              { component: COMP },
            );
            oosValid = false;
          } else {
            wfeValidated = true;
            logger.info(
              `  ✅ ${mode}: OOS 검증 통과 (WFE=${(avgOosSharpe / bestSharpe).toFixed(2)})`,
              { component: COMP },
            );
          }
        } else {
          // OOS에서 유효 거래 없으면 적용 보류
          oosValid = false;
          logger.info(`  ⚠️ ${mode}: OOS 유효거래 0건 → 적용 보류`, { component: COMP });
        }

        if (!oosValid) applied = false;
      }

      // ═══ Walk-Forward 최종 검증 (전체 데이터) ═══
      if (applied) {
        // 적용 직전 — 전체 데이터로 Walk-Forward 검증 (추가 안전장치)
        for (const [code, fullCandles] of chartMap) {
          const wfResult = runWalkForward(fullCandles, code, {
            mode,
            initialCapital: 100_000_000,
            maxPositionPct: 25,
            overrideTp: bestTp,
            overrideSl: bestSl,
          });
          if (wfResult.isOverfit) {
            logger.info(
              `  ⚠️ ${mode}/${code}: Walk-Forward 과적합 감지 (WFE=${wfResult.walkForwardEfficiency}) → 적용 보류`,
              { component: COMP },
            );
            applied = false;
            break;
          }
        }
      }

      // Paper strategy_config에 최적 값 기록
      if (applied) {
        await pool
          .query(
            `UPDATE strategy_config SET take_profit_pct = $1, stop_loss_pct = $2, updated_at = NOW()
           WHERE is_active = true AND is_paper = true AND mode = $3`,
            [bestTp, bestSl, mode],
          )
          .catch(() => {});

        logger.info(
          `  🎯 ${mode}: TP ${currentTp}→${bestTp.toFixed(1)}% SL ${currentSl}→${bestSl.toFixed(1)}% (Sharpe ${currentSharpe.toFixed(2)}→${bestSharpe.toFixed(2)}, OOS+WF 검증 통과)`,
          { component: COMP },
        );
      } else {
        logger.info(
          `  ✅ ${mode}: 현재값 유지 TP=${currentTp}% SL=${currentSl}% (Sharpe=${currentSharpe.toFixed(2)}, best=${bestSharpe.toFixed(2)})`,
          { component: COMP },
        );
      }

      // 결과 DB 기록
      await pool
        .query(
          `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [
            `optimizer_${mode}`,
            JSON.stringify({
              currentTp,
              currentSl,
              bestTp,
              bestSl,
              currentSharpe,
              bestSharpe,
              bestPF,
              bestWinRate,
              improved,
              applied,
              wfeValidated,
              paperTrades: paperPerf.totalTrades,
              runAt: new Date().toISOString(),
            }),
          ],
        )
        .catch(() => {});

      results.push({
        mode,
        currentTp,
        currentSl,
        bestTp,
        bestSl,
        bestSharpe,
        bestPF,
        bestWinRate,
        currentSharpe,
        improved,
        applied,
        wfeValidated,
      });
    } catch (e) {
      logger.warn(`📈 ${mode} 최적화 실패: ${e}`, { component: COMP });
    }
  }

  // 요약 텔레그램 알림 (적용된 건만)
  const appliedResults = results.filter((r) => r.applied);
  if (appliedResults.length > 0) {
    try {
      const { sendTelegramMessage } = await import('../notifications/telegram.js');
      const lines = appliedResults.map(
        (r) =>
          `• ${r.mode}: TP ${r.currentTp}→${r.bestTp.toFixed(1)}% SL ${r.currentSl}→${r.bestSl.toFixed(1)}% (Sharpe +${(((r.bestSharpe - r.currentSharpe) / Math.abs(r.currentSharpe || 1)) * 100).toFixed(0)}%, WFE✓)`,
      );
      await sendTelegramMessage(`📈 *전략 최적화 완료*\n\n${lines.join('\n')}\n\n적용: Paper only (OOS+WF 검증 통과)`).catch(() => {});
    } catch (e) {
      logger.warn(`📈 텔레그램 알림 실패: ${e}`, { component: COMP });
    }
  }

  logger.info(`📈 ═══ 전략 최적화 완료: ${results.length}전략, ${appliedResults.length}건 적용 ═══`, {
    component: COMP,
  });
  return results;
}
