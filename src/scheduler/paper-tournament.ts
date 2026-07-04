/**
 * 📊 Paper 전략 토너먼트
 *
 * Paper 모드에서 모든 전략을 동시 실행하여 성과를 비교.
 * 15분 간격 장중 실행 → 전략별 transaction_chains 축적 → 졸업 시스템 연동.
 *
 * 토큰 비용: $0 (DB + 기존 파이프라인만 사용)
 */

import { runTrackBPipeline } from '../ai/track-b/pipeline.js';
import { INVERSE_ETF_CODES } from '../automation/crash-profit.js';
import { getRegimeAllocation } from '../automation/regime-allocator.js';
import type { StrategyMode } from '../config/constants.js';
import { runWithMode } from '../config/context.js';
import { getPool } from '../db/client.js';
import { isMarketOpen } from '../kis/market.js';
import { isKillSwitchActive, reportSuccess } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';

const COMP = 'TOURNAMENT';

// 토너먼트 대상 전략 (EOD_BETTING은 별도 크론, DIVIDEND는 파킹 모드)
const TOURNAMENT_MODES: StrategyMode[] = ['SWING', 'DEFENSE', 'SNIPER', 'BOTTOM_FISHING'];

let _tournamentRunning = false;

/**
 * Paper 전략 토너먼트 메인
 * - 각 모드별로 strategy_config.mode를 임시 변경 → 파이프라인 실행 → 복원
 * - 체제 연동 가중치에 따라 포지션 크기 조절
 */
export async function runPaperTournament(): Promise<void> {
  if (_tournamentRunning) {
    logger.debug('📊 토너먼트 이미 실행 중 — 스킵', { component: COMP });
    return;
  }
  if (!isMarketOpen()) return;

  _tournamentRunning = true;
  const startMs = Date.now();

  try {
    await runWithMode(true, async () => {
      const pool = getPool();

      // 현재 Paper strategy_config 백업
      const { rows: origRows } = await pool.query(
        `SELECT mode FROM strategy_config WHERE is_active = true AND is_paper = true ORDER BY updated_at DESC LIMIT 1`,
      );
      const originalMode = origRows[0]?.mode ?? 'SWING';

      // 체제별 가중치 로드
      const allocation = await getRegimeAllocation();

      let executed = 0;
      for (const mode of TOURNAMENT_MODES) {
        const weight = allocation[mode] ?? 0;
        if (weight <= 0) continue; // 체제에서 비활성 전략은 스킵

        try {
          // strategy_config.mode 임시 변경
          await pool.query(
            `UPDATE strategy_config SET mode = $1, updated_at = NOW() WHERE is_active = true AND is_paper = true`,
            [mode],
          );

          // 파이프라인 실행
          const decisions = await runTrackBPipeline();

          // Kill Switch → 매도만 (예외: 인버스 ETF 매수는 허용)
          const killActive = isKillSwitchActive('KR');
          let filtered = killActive
            ? decisions.filter(
                (d) =>
                  ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action) ||
                  (d.action === 'BUY' && INVERSE_ETF_CODES.has(d.stock_code)),
              )
            : decisions;

          // 체제 가중치 반영: 포지션 수량 스케일링
          if (weight < 100) {
            const scale = weight / 100;
            filtered = filtered.map((d) => {
              if (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') {
                return { ...d, quantity: Math.max(1, Math.floor((d.quantity ?? 1) * scale)) };
              }
              return d;
            });
          }

          if (filtered.length > 0) {
            await tradeExecutor.processDecisions(filtered, mode, 'TOURNAMENT');
            executed += filtered.length;

            // 전략별 일일 성과 기록 (tournament_results)
            const buys = filtered.filter((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN').length;
            const sells = filtered.filter((d) => ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action)).length;
            await pool.query(
              `INSERT INTO tournament_results (strategy_mode, run_date, decisions_count, buys, sells)
               VALUES ($1, CURRENT_DATE, $2, $3, $4)
               ON CONFLICT (strategy_mode, run_date)
               DO UPDATE SET decisions_count = tournament_results.decisions_count + $2,
                             buys = tournament_results.buys + $3,
                             sells = tournament_results.sells + $4`,
              [mode, filtered.length, buys, sells],
            ).catch((e) => logger.warn(`토너먼트 성과 기록 실패: ${e}`, { component: COMP }));
          }
        } catch (e) {
          logger.warn(`📊 ${mode} 토너먼트 실패: ${e}`, { component: COMP });
        }
      }

      // 원래 모드 복원 — 실패 시 전략 모드 오염됨, 반드시 로깅
      try {
        await pool.query(
          `UPDATE strategy_config SET mode = $1, updated_at = NOW() WHERE is_active = true AND is_paper = true`,
          [originalMode],
        );
      } catch (restoreErr) {
        logger.error(`🚨 토너먼트 모드 복원 실패 (현재 모드 오염됨, 원래=${originalMode}): ${restoreErr}`, {
          component: COMP,
        });
      }

      reportSuccess();

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      logger.info(`📊 토너먼트 완료: ${TOURNAMENT_MODES.length}전략 스캔, ${executed}건 실행 (${elapsed}s)`, {
        component: COMP,
      });
    });
  } catch (e) {
    logger.error(`📊 토너먼트 전체 실패: ${e}`, { component: COMP });
  } finally {
    _tournamentRunning = false;
  }
}
