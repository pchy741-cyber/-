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
import { logger } from '../utils/logger.js';

const DEFAULT_SEED_KR = 10_000_000;
const DEFAULT_SEED_OVERSEAS = 10_000;

// 캐시 (paper/live 분리)
let cachedKrLive: number | null = null;
let cachedKrPaper: number | null = null;
let cachedOverseasLive: number | null = null;

export async function getSeedCapitalKr(): Promise<number> {
  if (getCtxIsPaper()) {
    // paper 시드자본 = 실제 모의 계좌 잔고 (고정 상수 제거)
    if (cachedKrPaper !== null) return cachedKrPaper;
    try {
      const { getPaperBalance } = await import('./paper-balance.js');
      const bal = await getPaperBalance();
      const total = bal.totalDeposit + bal.totalEvalAmount;
      if (total > 0) {
        cachedKrPaper = total;
        return cachedKrPaper;
      }
    } catch {}
    cachedKrPaper = DEFAULT_SEED_KR;
    return cachedKrPaper;
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
  // Paper 해외: 기준자본은 고정 상수 (설계 의도 — seed는 투입원금 기준, 변동 없음)
  if (getCtxIsPaper()) return DEFAULT_SEED_OVERSEAS;

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
    // Paper 모드: 실제 계좌잔고가 기준 → 캐시만 업데이트, DB 쓰기 불필요
    if (market === 'KR') cachedKrPaper = amount;
    logger.info(
      `💰 [모의] 기준자본 업데이트 [${market === 'KR' ? '국내' : '해외'}]: ${market === 'KR' ? `${amount.toLocaleString()}원` : `$${amount.toLocaleString()}`}`,
      { component: 'RISK' },
    );
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
    kr: paper ? (cachedKrPaper ?? DEFAULT_SEED_KR) : (cachedKrLive ?? DEFAULT_SEED_KR),
    overseas: paper ? DEFAULT_SEED_OVERSEAS : (cachedOverseasLive ?? DEFAULT_SEED_OVERSEAS),
  };
}

// ── 일일 손실한도 ──
// Live: 총자산의 2.5% (월간 MDD 8%의 1/3 — 3연속 최대손실 시 MDD 도달)
// Paper: 총자산의 30% (실험 자유도 확보)
// 순수 함수: DB 쿼리 없음, caller가 투자금을 전달한다.

export const DAILY_LOSS_PCT_LIVE = 2.5;
export const DAILY_LOSS_PCT_PAPER = 30;

// ── 주간 손실한도 ──
// Live: 총자산의 5% (일일 2.5% × 2일 연속 최대손실 수준)
// Paper: 총자산의 60% (실험 자유도)
export const WEEKLY_LOSS_PCT_LIVE = 5.0;
export const WEEKLY_LOSS_PCT_PAPER = 60;

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

/** 해외 손실 단계 (%) — Live 일일 2.5% / 월간 MDD 8% 정합성 */
export const OVERSEAS_LOSS_TIERS = { warnPct: 3, blockPct: 5, killPct: 8 } as const;

/** 서버 시작 시 DB에서 기준자본 로드 */
export async function initSeedCapital(): Promise<void> {
  await Promise.all([getSeedCapitalKr(), getSeedCapitalOverseas()]);
  const krVal = getCtxIsPaper() ? (cachedKrPaper ?? DEFAULT_SEED_KR) : (cachedKrLive ?? DEFAULT_SEED_KR);
  logger.info(
    `💰 기준자본 로드: 국내 ${krVal.toLocaleString()}원 / 해외 $${(cachedOverseasLive ?? DEFAULT_SEED_OVERSEAS).toLocaleString()}`,
    { component: 'RISK' },
  );
}
