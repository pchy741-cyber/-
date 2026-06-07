/**
 * 📈 전략 최적화기 (TP/SL 그리드 서치)
 *
 * 매일 19:30 실행 — 각 전략 모드별로 백테스트 엔진을 활용하여
 * 최적 TP/SL 파라미터를 탐색.
 *
 * 토큰 비용: $0 (DB + 결정론적 백테스트만 사용)
 */

import { STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { getPool } from '../db/client.js';
import { getDailyChart } from '../kis/market.js';
import { runBacktest, type BacktestConfig, type BacktestResult } from '../backtest/engine.js';
import { getStrategyPerformance } from '../risk/strategy-performance.js';
import { logger } from '../utils/logger.js';

const COMP = 'OPTIMIZER';

// 최적화 대상 전략 (DIVIDEND: 매수 안 함, EOD_BETTING: 별도 체계)
const TARGET_MODES: StrategyMode[] = ['SWING', 'DEFENSE', 'SCALPING', 'SNIPER', 'BOTTOM_FISHING', 'BREAKOUT'];

// 그리드 서치 범위
const TP_STEPS = [-1.0, -0.5, 0, 0.5, 1.0]; // 현재값 기준 ±1%
const SL_STEPS = [-0.5, -0.25, 0, 0.25, 0.5]; // 현재값 기준 ±0.5%

// 백테스트 대상 종목 (대형주 대표)
const BENCHMARK_CODES = ['005930', '000660', '035420', '005380', '051910']; // 삼성전자, SK하이닉스, NAVER, 현대차, LG화학

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
}

/**
 * 전략 최적화기 메인 — 매일 19:30 실행
 */
export async function runStrategyOptimizer(): Promise<OptimizerResult[]> {
  const pool = getPool();
  const results: OptimizerResult[] = [];

  logger.info('📈 ═══ 전략 최적화기 시작 ═══', { component: COMP });

  // 벤치마크 종목 차트 데이터 사전 로드 (90일)
  const chartMap = new Map<string, Awaited<ReturnType<typeof getDailyChart>>>();
  for (const code of BENCHMARK_CODES) {
    try {
      const candles = await getDailyChart(code, 120);
      if (candles.length >= 60) chartMap.set(code, candles);
    } catch (e) {
      logger.warn(`📈 차트 로드 실패 ${code}: ${e}`, { component: COMP });
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

      // 그리드 서치: TP × SL 조합별 백테스트
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

          // 각 벤치마크 종목에 대해 백테스트
          let totalSharpe = 0;
          let totalPF = 0;
          let totalWR = 0;
          let validCount = 0;

          for (const [code, candles] of chartMap) {
            const config: BacktestConfig = {
              mode,
              initialCapital: 10_000_000,
              maxPositionPct: 25,
            };

            // TP/SL 오버라이드를 위해 STRATEGY_PARAMS를 임시 변경
            const origTp = params.takeProfitPct;
            const origSl = params.stopLossPct;
            (params as any).takeProfitPct = testTp;
            (params as any).stopLossPct = testSl;

            try {
              const result = runBacktest(candles, code, config);
              if (result.totalTrades >= 3) {
                totalSharpe += result.sharpeRatio;
                totalPF += result.profitFactor;
                totalWR += result.winRate;
                validCount++;
              }
            } catch (btErr) {
              logger.warn(`📈 백테스트 실패 ${mode}/${code}: ${btErr}`, { component: COMP });
            } finally {
              // 반드시 복원 — 미복원 시 전체 트레이딩 파라미터 오염
              (params as any).takeProfitPct = origTp;
              (params as any).stopLossPct = origSl;
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

      const improved = bestSharpe > currentSharpe * 1.05; // 5% 이상 개선 시만 적용
      const applied = improved && paperPerf.totalTrades >= 10; // 10건 이상 거래 데이터 있을 때만

      // Paper strategy_config에 최적 값 기록
      if (applied) {
        await pool.query(
          `UPDATE strategy_config SET take_profit_pct = $1, stop_loss_pct = $2, updated_at = NOW()
           WHERE is_active = true AND is_paper = true AND mode = $3`,
          [bestTp, bestSl, mode],
        ).catch(() => {});

        logger.info(
          `  🎯 ${mode}: TP ${currentTp}→${bestTp.toFixed(1)}% SL ${currentSl}→${bestSl.toFixed(1)}% (Sharpe ${currentSharpe.toFixed(2)}→${bestSharpe.toFixed(2)})`,
          { component: COMP },
        );
      } else {
        logger.info(
          `  ✅ ${mode}: 현재값 유지 TP=${currentTp}% SL=${currentSl}% (Sharpe=${currentSharpe.toFixed(2)}, best=${bestSharpe.toFixed(2)})`,
          { component: COMP },
        );
      }

      // 결과 DB 기록
      await pool.query(
        `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [
          `optimizer_${mode}`,
          JSON.stringify({
            currentTp, currentSl, bestTp, bestSl,
            currentSharpe, bestSharpe, bestPF, bestWinRate,
            improved, applied, paperTrades: paperPerf.totalTrades,
            runAt: new Date().toISOString(),
          }),
        ],
      ).catch(() => {});

      results.push({
        mode, currentTp, currentSl, bestTp, bestSl,
        bestSharpe, bestPF, bestWinRate, currentSharpe,
        improved, applied,
      });
    } catch (e) {
      logger.warn(`📈 ${mode} 최적화 실패: ${e}`, { component: COMP });
    }
  }

  // 요약 텔레그램 알림 (적용된 건만)
  const appliedResults = results.filter(r => r.applied);
  if (appliedResults.length > 0) {
    try {
      const { sendTelegramMessage } = await import('../notifications/telegram.js');
      const lines = appliedResults.map(r =>
        `• ${r.mode}: TP ${r.currentTp}→${r.bestTp.toFixed(1)}% SL ${r.currentSl}→${r.bestSl.toFixed(1)}% (Sharpe +${((r.bestSharpe - r.currentSharpe) / Math.abs(r.currentSharpe || 1) * 100).toFixed(0)}%)`,
      );
      await sendTelegramMessage(
        `📈 *전략 최적화 완료*\n\n${lines.join('\n')}\n\n적용: Paper only`,
      );
    } catch (e) {
      logger.warn(`📈 텔레그램 알림 실패: ${e}`, { component: COMP });
    }
  }

  logger.info(`📈 ═══ 전략 최적화 완료: ${results.length}전략, ${appliedResults.length}건 적용 ═══`, { component: COMP });
  return results;
}
