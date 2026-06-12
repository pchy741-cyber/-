import { logger } from '../utils/logger.js';
import { getPool } from './client.js';

export interface AllocRisk {
  positionCapPct: number;
  maxInvestedPct: number;
  cashReservePct: number;
  maxPositions: number;
  maxDailyTrades: number;
}

const DEFAULTS: Record<'live' | 'paper', AllocRisk> = {
  live: { positionCapPct: 25, maxInvestedPct: 88, cashReservePct: 20, maxPositions: 8, maxDailyTrades: 3 },
  paper: { positionCapPct: 40, maxInvestedPct: 97, cashReservePct: 3, maxPositions: 20, maxDailyTrades: 20 },
};

const cache: Record<'live' | 'paper', AllocRisk> = {
  live: { ...DEFAULTS.live },
  paper: { ...DEFAULTS.paper },
};
let lastRefresh = 0;
const TTL_MS = 5 * 60 * 1000;

async function refresh(): Promise<void> {
  try {
    const { rows } = await getPool().query(
      `SELECT is_paper, position_cap_pct, max_invested_pct, cash_reserve_pct, max_positions, max_daily_trades
       FROM portfolio_allocation_config ORDER BY id DESC`,
    );
    for (const r of rows) {
      const key = r.is_paper ? 'paper' : 'live';
      const def = DEFAULTS[key];
      cache[key] = {
        positionCapPct: Number(r.position_cap_pct) || def.positionCapPct,
        maxInvestedPct: Number(r.max_invested_pct) || def.maxInvestedPct,
        cashReservePct: Number(r.cash_reserve_pct) ?? def.cashReservePct,
        maxPositions: Number(r.max_positions) || def.maxPositions,
        maxDailyTrades: Number(r.max_daily_trades) || def.maxDailyTrades,
      };
    }
    lastRefresh = Date.now();
  } catch (e) {
    logger.warn('alloc-risk-cache: DB 조회 실패, 기본값 유지', { component: 'ALLOC_CACHE', err: String(e) });
  }
}

export async function getAllocRisk(isPaper: boolean): Promise<AllocRisk> {
  if (Date.now() - lastRefresh > TTL_MS) await refresh();
  return cache[isPaper ? 'paper' : 'live'];
}

export function invalidateAllocCache(): void {
  lastRefresh = 0;
}
