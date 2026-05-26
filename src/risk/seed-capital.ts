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

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const PAPER_SEED_KR = 10_000_000;       // 모의 국내 1천만원
const PAPER_SEED_OVERSEAS = 10_000;      // 모의 해외 $10K
const DEFAULT_SEED_KR = 10_000_000;
const DEFAULT_SEED_OVERSEAS = 10_000;

// Live 전용 캐시 — paper 모드는 상수 직접 반환하므로 캐시 불필요
let cachedKrLive: number | null = null;
let cachedOverseasLive: number | null = null;

export async function getSeedCapitalKr(): Promise<number> {
  if (config.isPaper) return PAPER_SEED_KR;

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
  if (config.isPaper) return PAPER_SEED_OVERSEAS;

  if (cachedOverseasLive !== null) return cachedOverseasLive;

  try {
    const { getPool } = await import('../db/client.js');
    const key = 'seed_capital_overseas';
    const { rows } = await getPool().query(
      'SELECT value FROM system_state WHERE key = $1',
      [key],
    );
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

  if (config.isPaper) {
    // Paper seed capital은 상수로 고정 — DB 쓰기 불필요
    logger.info(
      `💰 [모의] 기준자본 고정 [${market === 'KR' ? '국내' : '해외'}]: ${market === 'KR' ? `${PAPER_SEED_KR.toLocaleString()}원` : `$${PAPER_SEED_OVERSEAS.toLocaleString()}`}`,
      { component: 'RISK' },
    );
    return;
  }

  const { getPool } = await import('../db/client.js');

  if (market === 'KR') {
    await getPool().query(
      'UPDATE portfolio_allocation_config SET seed_capital = $1 WHERE is_paper = false',
      [amount],
    );
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
  return {
    kr: config.isPaper ? PAPER_SEED_KR : (cachedKrLive ?? DEFAULT_SEED_KR),
    overseas: config.isPaper ? PAPER_SEED_OVERSEAS : (cachedOverseasLive ?? DEFAULT_SEED_OVERSEAS),
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
    `💰 기준자본 로드: 국내 ${(cachedKrLive ?? DEFAULT_SEED_KR).toLocaleString()}원 / 해외 $${(cachedOverseasLive ?? DEFAULT_SEED_OVERSEAS).toLocaleString()}`,
    { component: 'RISK' },
  );
}
