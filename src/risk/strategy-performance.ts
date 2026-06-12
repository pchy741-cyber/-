/**
 * 전략별 성과 추적 — 전략 모드별 승률·수익률·MDD 분석
 *
 * transaction_chains + orders 테이블에서 CLOSED 체인을 쿼리하여
 * 전략별 독립 성과를 계산. Paper/Live 분리.
 */

import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

export interface StrategyPerformance {
  mode: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0-1
  avgWinPct: number; // 평균 수익 %
  avgLossPct: number; // 평균 손실 % (양수)
  totalPnlKrw: number; // 확정 PnL 합계 (KRW)
  totalPnlPct: number; // 가중 평균 PnL %
  maxDrawdownPct: number; // 연속 손실 기반 최대 드로다운
  profitFactor: number; // 총이익 / 총손실
  avgHoldingDays: number;
  bestTrade: { stockCode: string; pnlPct: number } | null;
  worstTrade: { stockCode: string; pnlPct: number } | null;
  lastUpdated: string;
}

interface ClosedChainRow {
  stock_code: string;
  strategy_mode: string;
  avg_buy_price: string;
  total_invested: string;
  realized_pnl: string;
  opened_at: string;
  closed_at: string;
  sell_price: string | null;
}

/**
 * 특정 전략 모드의 성과 조회
 */
export async function getStrategyPerformance(
  mode: string,
  days: number = 30,
  isPaper: boolean = true,
): Promise<StrategyPerformance> {
  const { rows } = await getPool().query<ClosedChainRow>(
    `
    SELECT tc.stock_code, tc.strategy_mode, tc.avg_buy_price, tc.total_invested,
           tc.realized_pnl, tc.opened_at, tc.closed_at,
           (SELECT o.filled_price FROM orders o
            WHERE o.chain_id = tc.id AND o.side = 'SELL' AND o.status = 'FILLED'
            ORDER BY o.created_at DESC LIMIT 1) as sell_price
    FROM transaction_chains tc
    WHERE tc.status = 'CLOSED'
      AND tc.strategy_mode = $1
      AND tc.closed_at >= NOW() - ($2 * INTERVAL '1 day')
      AND tc.is_paper = $3
    ORDER BY tc.closed_at DESC
  `,
    [mode, days, isPaper],
  );

  return computePerformance(mode, rows);
}

/**
 * 전체 전략 모드별 성과 비교
 */
export async function getAllStrategyPerformances(
  days: number = 30,
  isPaper: boolean = true,
): Promise<StrategyPerformance[]> {
  const { rows } = await getPool().query<ClosedChainRow>(
    `
    SELECT tc.stock_code, tc.strategy_mode, tc.avg_buy_price, tc.total_invested,
           tc.realized_pnl, tc.opened_at, tc.closed_at,
           (SELECT o.filled_price FROM orders o
            WHERE o.chain_id = tc.id AND o.side = 'SELL' AND o.status = 'FILLED'
            ORDER BY o.created_at DESC LIMIT 1) as sell_price
    FROM transaction_chains tc
    WHERE tc.status = 'CLOSED'
      AND tc.closed_at >= NOW() - ($1 * INTERVAL '1 day')
      AND tc.is_paper = $2
    ORDER BY tc.strategy_mode, tc.closed_at DESC
  `,
    [days, isPaper],
  );

  // 전략별 그룹핑
  const groups = new Map<string, ClosedChainRow[]>();
  for (const row of rows) {
    const mode = row.strategy_mode;
    if (!groups.has(mode)) groups.set(mode, []);
    groups.get(mode)!.push(row);
  }

  const results: StrategyPerformance[] = [];
  for (const [mode, modeRows] of groups) {
    results.push(computePerformance(mode, modeRows));
  }

  // 승률 높은 순 정렬
  results.sort((a, b) => b.winRate - a.winRate);
  return results;
}

function computePerformance(mode: string, rows: ClosedChainRow[]): StrategyPerformance {
  const now = new Date().toISOString();

  if (rows.length === 0) {
    return {
      mode,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      totalPnlKrw: 0,
      totalPnlPct: 0,
      maxDrawdownPct: 0,
      profitFactor: 0,
      avgHoldingDays: 0,
      bestTrade: null,
      worstTrade: null,
      lastUpdated: now,
    };
  }

  let wins = 0,
    losses = 0;
  let totalWinPct = 0,
    totalLossPct = 0;
  let grossProfit = 0,
    grossLoss = 0;
  let totalPnlKrw = 0;
  let totalHoldingMs = 0;
  let bestTrade: { stockCode: string; pnlPct: number } | null = null;
  let worstTrade: { stockCode: string; pnlPct: number } | null = null;

  const pnlSequence: number[] = [];

  for (const row of rows) {
    const buyPrice = Number(row.avg_buy_price);
    const sellPrice = Number(row.sell_price ?? buyPrice);
    const invested = Number(row.total_invested);
    const realizedPnl = Number(row.realized_pnl);

    const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
    const pnlKrw = realizedPnl || (invested > 0 ? invested * (pnlPct / 100) : 0);

    totalPnlKrw += pnlKrw;
    pnlSequence.push(pnlPct);

    if (pnlPct > 0) {
      wins++;
      totalWinPct += pnlPct;
      grossProfit += Math.abs(pnlKrw);
    } else {
      losses++;
      totalLossPct += Math.abs(pnlPct);
      grossLoss += Math.abs(pnlKrw);
    }

    if (!bestTrade || pnlPct > bestTrade.pnlPct) {
      bestTrade = { stockCode: row.stock_code, pnlPct };
    }
    if (!worstTrade || pnlPct < worstTrade.pnlPct) {
      worstTrade = { stockCode: row.stock_code, pnlPct };
    }

    // 보유기간
    if (row.opened_at && row.closed_at) {
      totalHoldingMs += new Date(row.closed_at).getTime() - new Date(row.opened_at).getTime();
    }
  }

  const total = wins + losses;
  const winRate = total > 0 ? wins / total : 0;
  const avgWinPct = wins > 0 ? totalWinPct / wins : 0;
  const avgLossPct = losses > 0 ? totalLossPct / losses : 0;
  const totalPnlPct = total > 0 ? pnlSequence.reduce((s, p) => s + p, 0) / total : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgHoldingDays = total > 0 ? totalHoldingMs / total / (24 * 60 * 60_000) : 0;

  // 연속 손실 기반 최대 드로다운
  let maxDD = 0;
  let currentDD = 0;
  for (const pnl of pnlSequence) {
    if (pnl < 0) {
      currentDD += pnl;
      maxDD = Math.min(maxDD, currentDD);
    } else {
      currentDD = 0;
    }
  }

  return {
    mode,
    totalTrades: total,
    wins,
    losses,
    winRate,
    avgWinPct,
    avgLossPct,
    totalPnlKrw: Math.round(totalPnlKrw),
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgHoldingDays: Math.round(avgHoldingDays * 10) / 10,
    bestTrade,
    worstTrade,
    lastUpdated: now,
  };
}

/**
 * 전체 전략 성과 요약 로그
 */
export async function logStrategyPerformanceSummary(days: number = 30, isPaper: boolean = true): Promise<void> {
  try {
    const perfs = await getAllStrategyPerformances(days, isPaper);
    if (perfs.length === 0) {
      logger.info(`📊 전략 성과: ${days}일간 CLOSED 거래 없음 (${isPaper ? 'paper' : 'live'})`, {
        component: 'STRATEGY_PERF',
      });
      return;
    }

    const modeLabel = isPaper ? 'PAPER' : 'LIVE';
    logger.info(`📊 ═══ 전략별 성과 (${modeLabel}, ${days}일) ═══`, { component: 'STRATEGY_PERF' });
    for (const p of perfs) {
      logger.info(
        `  ${p.mode}: ${p.totalTrades}건 승률${(p.winRate * 100).toFixed(0)}% ` +
          `평균+${p.avgWinPct.toFixed(1)}%/-${p.avgLossPct.toFixed(1)}% ` +
          `PF=${p.profitFactor.toFixed(2)} MDD=${p.maxDrawdownPct.toFixed(1)}% ` +
          `PnL=${(p.totalPnlKrw / 10000).toFixed(0)}만원 보유${p.avgHoldingDays.toFixed(1)}일`,
        { component: 'STRATEGY_PERF' },
      );
    }
  } catch (e) {
    logger.warn(`전략 성과 로그 실패: ${e}`, { component: 'STRATEGY_PERF' });
  }
}
