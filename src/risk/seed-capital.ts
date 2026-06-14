/**
 * 기준자본(Seed Capital) — 손실한도 계산의 고정 기준점
 *
 * 왜 필요한가:
 *   "당일 시작 포트폴리오" 기준으로 손실한도를 계산하면,
 *   잃을수록 기준이 줄어들어 한도도 줄어든다.
 *   CEO가 투입한 원금(1천만원, $10K 등)을 기준으로 고정해야
 *   "내 돈 X원 중 Y% 이상 잃지 않는다"가 직관적으로 성립한다.
 *
 * DB 저장:
 *   KR      → portfolio_allocation_config.seed_capital (기본 10,000,000원, live 행만)
 *   OVERSEAS → system_state key 'seed_capital_overseas' / 'seed_capital_overseas_paper'
 *
 * Paper/Live 분리:
 *   Paper 모드는 항상 상수 반환 (DB 읽기/쓰기 없음, 캐시 오염 없음)
 *   Live 모드는 별도 캐시(cachedKrLive, cachedOverseasLive) 사용
 */

import { getCtxIsPaper } from '../config/context.js';
import { PAPER_INITIAL_CAPITAL } from './paper-balance.js';
import { logger } from '../utils/logger.js';

const DEFAULT_SEED_KR = 10_000_000;
const DEFAULT_SEED_OVERSEAS = 10_000;

// 캐시 (live 전용 — paper는 고정 상수 반환)
let cachedKrLive: number | null = null;
let cachedOverseasLive: number | null = null;

export async function getSeedCapitalKr(): Promise<number> {
  if (getCtxIsPaper()) {
    // Paper 시드자본 = 고정 초기자본 (투입원금 — 수익률 분모)
    // ⚠️ 이전 버그: 동적 잔고(cash+eval) 반환 → seed가 현재가와 같아서 수익률 ≈ 0%
    return PAPER_INITIAL_CAPITAL;
  }

  if (cachedKrLive !== null) return cachedKrLive;

  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      'SELECT seed_capital FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1',
    );
    if (rows[0] && Number(rows[0].seed_capital) > 0) {
      cachedKrLive = Number(rows[0].seed_capital);
      return cachedKrLive;
    }
  } catch {}

  cachedKrLive = DEFAULT_SEED_KR;
  return cachedKrLive;
}

export async function getSeedCapitalOverseas(): Promise<number> {
  if (getCtxIsPaper()) {
    // Paper 해외 시드: PAPER_OVERSEAS_SEED_KRW(₩30M)를 환율 환산 → USD
    // ⚠️ 이전 버그: DEFAULT_SEED_OVERSEAS($10K) 반환 → 실제 시드(₩30M ≈ $21.7K)와 불일치
    try {
      const { getPaperSeedKrw } = await import('../scheduler/overseas/state.js');
      const { fetchExchangeRate } = await import('../automation/macro-data.js');
      const rate = await fetchExchangeRate();
      return rate > 0 ? getPaperSeedKrw() / rate : DEFAULT_SEED_OVERSEAS;
    } catch {
      return DEFAULT_SEED_OVERSEAS;
    }
  }

  if (cachedOverseasLive !== null) return cachedOverseasLive;

  try {
    const { getPool } = await import('../db/client.js');
    const key = 'seed_capital_overseas';
    const { rows } = await getPool().query('SELECT value FROM system_state WHERE key = $1', [key]);
    if (rows[0] && Number(rows[0].value) > 0) {
      cachedOverseasLive = Number(rows[0].value);
      return cachedOverseasLive;
    }
  } catch {}

  cachedOverseasLive = DEFAULT_SEED_OVERSEAS;
  return cachedOverseasLive;
}

export async function setSeedCapital(market: 'KR' | 'OVERSEAS', amount: number): Promise<void> {
  if (amount <= 0) return;

  if (getCtxIsPaper()) {
    // Paper 시드자본은 고정 상수 (KR=PAPER_INITIAL_CAPITAL, 해외=PAPER_OVERSEAS_SEED_KRW) — 런타임 변경 불가
    logger.info(`💰 [모의] 시드자본은 고정입니다 (국내 ${PAPER_INITIAL_CAPITAL.toLocaleString()}원)`, { component: 'RISK' });
    return;
  }

  const { getPool } = await import('../db/client.js');

  if (market === 'KR') {
    await getPool().query('UPDATE portfolio_allocation_config SET seed_capital = $1 WHERE is_paper = false', [amount]);
    cachedKrLive = amount;
  } else {
    const key = 'seed_capital_overseas';
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, String(amount)],
    );
    cachedOverseasLive = amount;
  }

  const label = market === 'KR' ? '국내' : '해외';
  const unit = market === 'KR' ? '원' : 'USD';
  logger.info(`💰 기준자본 설정 [${label}]: ${amount.toLocaleString()}${unit}`, { component: 'RISK' });
}

export function getSeedCapitalStatus() {
  const paper = getCtxIsPaper();
  return {
    kr: paper ? PAPER_INITIAL_CAPITAL : (cachedKrLive ?? DEFAULT_SEED_KR),
    overseas: cachedOverseasLive ?? DEFAULT_SEED_OVERSEAS, // Paper 해외는 async에서만 정확 (환율 필요)
  };
}

// ── 일일 손실한도 ──
// Live: 총자산의 2.5% (월간 MDD 8%의 1/3 — 3연속 최대손실 시 MDD 도달)
// Paper: 총자산의 30% (실험 자유도 확보)
// 순수 함수: DB 쿼리 없음, caller가 투자금을 전달한다.

export const DAILY_LOSS_PCT_LIVE = 25;
export const DAILY_LOSS_PCT_PAPER = 80;

// ── 주간 손실한도 ──
// Live: 총자산의 5% (일일 2.5% × 2일 연속 최대손실 수준)
// Paper: 총자산의 60% (실험 자유도)
export const WEEKLY_LOSS_PCT_LIVE = 50;
export const WEEKLY_LOSS_PCT_PAPER = 95;

export interface DailyLossLimit {
  basis: number; // 총자산 (caller가 전달: 현금+투자 합계)
  pct: number; // Live 2.5% / Paper 30%
  limitAmount: number; // basis × pct%
}

/** 총자산의 N% = 손실한도. caller가 총자산(현금+투자) 전달. */
export function calcDailyLossLimit(totalPortfolio: number, isPaper?: boolean): DailyLossLimit {
  const pct = isPaper ? DAILY_LOSS_PCT_PAPER : DAILY_LOSS_PCT_LIVE;
  const limitAmount = Math.round((totalPortfolio * pct) / 100);
  return { basis: totalPortfolio, pct, limitAmount };
}

/** 해외 손실 단계 (%) — Paper/Live 분리 (국내 일일 손실한도와 정합성 유지) */
export const OVERSEAS_LOSS_TIERS_LIVE = { warnPct: 3, blockPct: 5, killPct: 8 } as const;
export const OVERSEAS_LOSS_TIERS_PAPER = { warnPct: 15, blockPct: 25, killPct: 40 } as const;

/** Paper/Live 자동 분기 접근자 */
export function getOverseasLossTiers(isPaper?: boolean) {
  const paper = isPaper ?? getCtxIsPaper();
  return paper ? OVERSEAS_LOSS_TIERS_PAPER : OVERSEAS_LOSS_TIERS_LIVE;
}

/** 서버 시작 시 DB에서 기준자본 로드 */
export async function initSeedCapital(): Promise<void> {
  const [krVal, overseasVal] = await Promise.all([getSeedCapitalKr(), getSeedCapitalOverseas()]);
  logger.info(
    `💰 기준자본 로드: 국내 ${krVal.toLocaleString()}원 / 해외 $${Math.round(overseasVal).toLocaleString()}`,
    { component: 'RISK' },
  );
}
