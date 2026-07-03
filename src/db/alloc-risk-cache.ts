import { logger } from '../utils/logger.js';
import { getPool } from './client.js';

export interface AllocRisk {
  positionCapPct: number;
  maxInvestedPct: number;
  cashReservePct: number;
  maxPositions: number;
  maxDailyTrades: number;
  // 섹터별 최대 비중 (%)
  sectorSemiconductor: number;
  sectorBio: number;
  sectorDefense: number;
  sectorFinance: number;
  sectorEtc: number;
}

const DEFAULTS: Record<'live' | 'paper', AllocRisk> = {
  live: { positionCapPct: 25, maxInvestedPct: 88, cashReservePct: 20, maxPositions: 12, maxDailyTrades: 5, sectorSemiconductor: 30, sectorBio: 20, sectorDefense: 25, sectorFinance: 20, sectorEtc: 30 }, // v21: dailyTrades 8→5 (과매매 억제)
  // Paper: Live보다 약간 관대 (데이터 축적 우선, 그러나 Live와 괴리 최소화)
  // 이전: 종목40%/투자97%/포지션20개/섹터50% → Live(25%/88%/12개/20-30%)와 완전 괴리
  paper: { positionCapPct: 30, maxInvestedPct: 92, cashReservePct: 8, maxPositions: 15, maxDailyTrades: 12, sectorSemiconductor: 35, sectorBio: 30, sectorDefense: 30, sectorFinance: 25, sectorEtc: 35 },
};

// ── 레짐 기반 동적 오버라이드 (장 좋으면 적극, 나쁘면 보수) ──
// penalty=0 + boost=true (강세장): 한도 대폭 확대
// penalty=0 (중립): DB 설정값 그대로
// penalty=1 (조정): 축소
// penalty=2 (약세): 대폭 축소
const REGIME_OVERRIDES: Record<string, Partial<AllocRisk>> = {
  bull:    { maxPositions: 12, maxDailyTrades: 6, maxInvestedPct: 95, cashReservePct: 5, positionCapPct: 30 }, // v21: 12→6 (강세장에서도 과매매 억제)
  neutral: {}, // DB 설정값 유지
  correction: { maxPositions: 6, maxDailyTrades: 4, maxInvestedPct: 75, cashReservePct: 25, positionCapPct: 20 },
  bear:    { maxPositions: 4, maxDailyTrades: 3, maxInvestedPct: 60, cashReservePct: 35, positionCapPct: 15 },
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
      `SELECT is_paper, position_cap_pct, max_invested_pct, cash_reserve_pct, max_positions, max_daily_trades,
              sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc
       FROM portfolio_allocation_config ORDER BY id DESC`,
    );
    for (const r of rows) {
      const key = r.is_paper ? 'paper' : 'live';
      const def = DEFAULTS[key];
      cache[key] = {
        positionCapPct: r.position_cap_pct != null ? Number(r.position_cap_pct) : def.positionCapPct,
        maxInvestedPct: r.max_invested_pct != null ? Number(r.max_invested_pct) : def.maxInvestedPct,
        cashReservePct: r.cash_reserve_pct != null ? Number(r.cash_reserve_pct) : def.cashReservePct,
        maxPositions: r.max_positions != null ? Number(r.max_positions) : def.maxPositions,
        maxDailyTrades: r.max_daily_trades != null ? Number(r.max_daily_trades) : def.maxDailyTrades,
        sectorSemiconductor: r.sector_semiconductor != null ? Number(r.sector_semiconductor) : def.sectorSemiconductor,
        sectorBio: r.sector_bio != null ? Number(r.sector_bio) : def.sectorBio,
        sectorDefense: r.sector_defense != null ? Number(r.sector_defense) : def.sectorDefense,
        sectorFinance: r.sector_finance != null ? Number(r.sector_finance) : def.sectorFinance,
        sectorEtc: r.sector_etc != null ? Number(r.sector_etc) : def.sectorEtc,
      };
    }
    lastRefresh = Date.now();
  } catch (e) {
    logger.warn('alloc-risk-cache: DB 조회 실패, 기본값 유지', { component: 'ALLOC_CACHE', err: String(e) });
  }
}

export async function getAllocRisk(isPaper: boolean): Promise<AllocRisk> {
  if (Date.now() - lastRefresh > TTL_MS) await refresh();
  const base = cache[isPaper ? 'paper' : 'live'];

  // Paper 모드: 항상 최대한 적극적 (데이터 수집 우선)
  if (isPaper) return base;

  // Live 모드: KOSPI 레짐 기반 동적 조정
  try {
    const { getLastKnownRegime } = await import('../ai/track-b/market-regime.js');
    const regime = getLastKnownRegime();
    const key = regime.penalty >= 2 ? 'bear' : regime.penalty >= 1 ? 'correction' : regime.boost ? 'bull' : 'neutral';
    const override = REGIME_OVERRIDES[key];
    if (!override || Object.keys(override).length === 0) return base;

    const adjusted = { ...base, ...override };
    if (regime.penalty >= 1) {
      // 약세/조정장: 레짐 오버라이드와 DB 중 더 보수적인(작은) 값 (방어 우선)
      adjusted.maxPositions = Math.min(adjusted.maxPositions, base.maxPositions);
      adjusted.maxDailyTrades = Math.min(adjusted.maxDailyTrades, base.maxDailyTrades);
      adjusted.maxInvestedPct = Math.min(adjusted.maxInvestedPct, base.maxInvestedPct);
    } else {
      // 강세/중립: DB 설정이 더 공격적이면 DB 값 존중 (사용자 의도 우선)
      adjusted.maxPositions = Math.max(adjusted.maxPositions, base.maxPositions);
      adjusted.maxDailyTrades = Math.max(adjusted.maxDailyTrades, base.maxDailyTrades);
    }
    return adjusted;
  } catch {
    return base; // 레짐 조회 실패 시 기본값 유지
  }
}

export function invalidateAllocCache(): void {
  lastRefresh = 0;
}
