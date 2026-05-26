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
 *   KR      → portfolio_allocation_config.seed_capital (기본 10,000,000원)
 *   OVERSEAS → system_state key 'seed_capital_overseas' / 'seed_capital_overseas_paper'
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const PAPER_SEED_KR = 10_000_000;       // 모의 국내 1천만원
const PAPER_SEED_OVERSEAS = 10_000;      // 모의 해외 $10K
const DEFAULT_SEED_KR = 10_000_000;
const DEFAULT_SEED_OVERSEAS = 10_000;

let cachedKr: number | null = null;
let cachedOverseas: number | null = null;

export async function getSeedCapitalKr(): Promise<number> {
  if (cachedKr !== null) return cachedKr;

  if (config.isPaper) {
    cachedKr = PAPER_SEED_KR;
    return cachedKr;
  }

  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      'SELECT seed_capital FROM portfolio_allocation_config ORDER BY id DESC LIMIT 1',
    );
    if (rows[0] && Number(rows[0].seed_capital) > 0) {
      cachedKr = Number(rows[0].seed_capital);
      return cachedKr;
    }
  } catch {}

  cachedKr = DEFAULT_SEED_KR;
  return cachedKr;
}

export async function getSeedCapitalOverseas(): Promise<number> {
  if (cachedOverseas !== null) return cachedOverseas;

  if (config.isPaper) {
    cachedOverseas = PAPER_SEED_OVERSEAS;
    return cachedOverseas;
  }

  try {
    const { getPool } = await import('../db/client.js');
    const key = 'seed_capital_overseas';
    const { rows } = await getPool().query(
      'SELECT value FROM system_state WHERE key = $1',
      [key],
    );
    if (rows[0] && Number(rows[0].value) > 0) {
      cachedOverseas = Number(rows[0].value);
      return cachedOverseas;
    }
  } catch {}

  cachedOverseas = DEFAULT_SEED_OVERSEAS;
  return cachedOverseas;
}

export async function setSeedCapital(market: 'KR' | 'OVERSEAS', amount: number): Promise<void> {
  if (amount <= 0) return;
  const { getPool } = await import('../db/client.js');

  if (market === 'KR') {
    await getPool().query(
      'UPDATE portfolio_allocation_config SET seed_capital = $1',
      [amount],
    );
    cachedKr = amount;
  } else {
    const key = 'seed_capital_overseas';
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, String(amount)],
    );
    cachedOverseas = amount;
  }

  const label = market === 'KR' ? '국내' : '해외';
  const unit = market === 'KR' ? '원' : 'USD';
  logger.info(`💰 기준자본 설정 [${label}]: ${amount.toLocaleString()}${unit}`, { component: 'RISK' });
}

export function getSeedCapitalStatus() {
  return {
    kr: cachedKr ?? DEFAULT_SEED_KR,
    overseas: cachedOverseas ?? DEFAULT_SEED_OVERSEAS,
  };
}

// ── 일일 손실한도 ──
// 투자금(종목에 들어간 돈)의 30%
// 순수 함수: DB 쿼리 없음, caller가 투자금을 전달한다.

export const DAILY_LOSS_PCT = 30;

export interface DailyLossLimit {
  basis: number;       // 총자산 (caller가 전달: 현금+투자 합계)
  pct: number;         // 30%
  limitAmount: number; // basis × 30%
}

/** 총자산의 30% = 손실한도. caller가 총자산(현금+투자) 전달. */
export function calcDailyLossLimit(totalPortfolio: number): DailyLossLimit {
  const limitAmount = Math.round(totalPortfolio * DAILY_LOSS_PCT / 100);
  return { basis: totalPortfolio, pct: DAILY_LOSS_PCT, limitAmount };
}

/** 해외 손실 단계 (%) */
export const OVERSEAS_LOSS_TIERS = { warnPct: 10, blockPct: 20, killPct: 30 } as const;

/** 서버 시작 시 DB에서 기준자본 로드 */
export async function initSeedCapital(): Promise<void> {
  await Promise.all([getSeedCapitalKr(), getSeedCapitalOverseas()]);
  logger.info(
    `💰 기준자본 로드: 국내 ${(cachedKr ?? DEFAULT_SEED_KR).toLocaleString()}원 / 해외 $${(cachedOverseas ?? DEFAULT_SEED_OVERSEAS).toLocaleString()}`,
    { component: 'RISK' },
  );
}
