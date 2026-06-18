/**
 * 전략 스플릿 테스트 러너 — A/B 파라미터 분할 테스트 및 성과 추적
 *
 * 활성 스플릿의 paper 성과를 strategy_splits 테이블에 업데이트
 * min_trades 도달 시 winner 결정 및 자동 완료
 */

import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

export interface StrategySplit {
  id: number;
  name: string;
  strategy_mode: string;
  status: string;
  variant_a: Record<string, unknown>;
  variant_b: Record<string, unknown>;
  min_trades: number;
  paper_pnl_a: number;
  paper_pnl_b: number;
  trades_a: number;
  trades_b: number;
  win_rate_a: number;
  win_rate_b: number;
  winner: string | null;
}

/** 활성 스플릿의 paper 성과를 DB에 업데이트 */
export async function updateSplitPerformance(): Promise<void> {
  const pool = getPool();

  try {
    // 활성 스플릿 조회
    const { rows: activeSplits } = await pool.query<StrategySplit>(
      `SELECT * FROM strategy_splits WHERE status = 'ACTIVE'`,
    );

    if (activeSplits.length === 0) {
      return;
    }

    for (const split of activeSplits) {
      try {
        // Variant A 성과 (현재 실전 파라미터)
        const { rows: dataA } = await pool.query(
          `
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
            SUM(realized_pnl) as total_pnl,
            AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
            AVG(CASE WHEN realized_pnl <= 0 THEN ABS(realized_pnl) END) as avg_loss
          FROM transaction_chains
          WHERE status = 'CLOSED' AND is_paper = true
            AND strategy_mode = $1
            AND closed_at >= NOW() - INTERVAL '60 days'
            AND (strategy_params ->> 'variant_id' IS NULL OR strategy_params ->> 'variant_id' = 'A')
        `,
          [split.strategy_mode],
        );

        // Variant B 성과 (테스트 파라미터)
        const { rows: dataB } = await pool.query(
          `
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
            SUM(realized_pnl) as total_pnl,
            AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) as avg_win,
            AVG(CASE WHEN realized_pnl <= 0 THEN ABS(realized_pnl) END) as avg_loss
          FROM transaction_chains
          WHERE status = 'CLOSED' AND is_paper = true
            AND strategy_mode = $1
            AND closed_at >= NOW() - INTERVAL '60 days'
            AND strategy_params ->> 'variant_id' = 'B'
        `,
          [split.strategy_mode],
        );

        const rowA = dataA[0];
        const rowB = dataB[0];

        const totalA = Number(rowA.total ?? 0);
        const winsA = Number(rowA.wins ?? 0);
        const pnlA = Number(rowA.total_pnl ?? 0);
        const avgWinA = Number(rowA.avg_win ?? 0);
        const avgLossA = Number(rowA.avg_loss ?? 1);
        const winRateA = totalA > 0 ? winsA / totalA : 0;
        const pfA = avgLossA > 0 ? avgWinA / avgLossA : 0;

        const totalB = Number(rowB.total ?? 0);
        const winsB = Number(rowB.wins ?? 0);
        const pnlB = Number(rowB.total_pnl ?? 0);
        const avgWinB = Number(rowB.avg_win ?? 0);
        const avgLossB = Number(rowB.avg_loss ?? 1);
        const winRateB = totalB > 0 ? winsB / totalB : 0;
        const pfB = avgLossB > 0 ? avgWinB / avgLossB : 0;

        // strategy_splits 업데이트
        await pool.query(
          `
          UPDATE strategy_splits
          SET paper_pnl_a = $2, trades_a = $3, win_rate_a = $4,
              paper_pnl_b = $5, trades_b = $6, win_rate_b = $7
          WHERE id = $1
        `,
          [split.id, pnlA, totalA, winRateA, pnlB, totalB, winRateB],
        );

        logger.info(
          `📊 스플릿 #${split.id} 성과 업데이트: A(${totalA}건, PF${pfA.toFixed(2)}) vs B(${totalB}건, PF${pfB.toFixed(2)})`,
          { component: 'STRATEGY_LAB' },
        );
      } catch (e) {
        logger.warn(`스플릿 #${split.id} 성과 갱신 실패: ${e}`, { component: 'STRATEGY_LAB' });
      }
    }
  } catch (e) {
    logger.warn(`스플릿 성과 업데이트 실패: ${e}`, { component: 'STRATEGY_LAB' });
  }
}

/** 조건 충족 스플릿 자동 완료 처리 */
export async function checkAndCompleteSplits(): Promise<void> {
  const pool = getPool();

  try {
    // 조건 충족 스플릿: min_trades 도달 + 수동 완료 미결정
    const { rows: readySplits } = await pool.query<StrategySplit>(
      `
      SELECT * FROM strategy_splits
      WHERE status = 'ACTIVE'
        AND (trades_a >= min_trades OR trades_b >= min_trades)
      LIMIT 10
    `,
    );

    for (const split of readySplits) {
      try {
        // Winner 결정: 더 높은 PF 또는 더 높은 PnL
        const pnlA = Number(split.paper_pnl_a ?? 0);
        const pnlB = Number(split.paper_pnl_b ?? 0);
        const wrA = Number(split.win_rate_a ?? 0);
        const wrB = Number(split.win_rate_b ?? 0);

        // PF 기반 winner 결정 (더 높은 승률 * PnL)
        const scoreA = wrA * Math.abs(pnlA);
        const scoreB = wrB * Math.abs(pnlB);
        const winner = scoreA >= scoreB ? 'A' : 'B';

        await pool.query(
          `
          UPDATE strategy_splits
          SET status = 'COMPLETED', winner = $2, completed_at = NOW()
          WHERE id = $1
        `,
          [split.id, winner],
        );

        logger.info(
          `✅ 스플릿 #${split.id} 완료: Winner = ${winner} (A: ${scoreA.toFixed(0)}, B: ${scoreB.toFixed(0)})`,
          { component: 'STRATEGY_LAB' },
        );
      } catch (e) {
        logger.warn(`스플릿 #${split.id} 완료 실패: ${e}`, { component: 'STRATEGY_LAB' });
      }
    }
  } catch (e) {
    logger.warn(`스플릿 완료 처리 실패: ${e}`, { component: 'STRATEGY_LAB' });
  }
}
