/**
 * 기준자본(Seed Capital) — 손실한도 계산의 기준점
 *
 * Live: KIS API 실계좌 순자산에서 자동 동기화 → DB 저장
 *   KR      → portfolio_allocation_config.seed_capital
 *   OVERSEAS → system_state key 'seed_capital_overseas'
 *   고정 상수 없음 — KIS+DB 모두 실패 시 0원 (매수 차단)
 *
 * Paper: 환경변수 기반 고정 시드 (PAPER_INITIAL_CAPITAL_KRW, PAPER_OVERSEAS_SEED_KRW)
 */

import { getCtxIsPaper } from '../config/context.js';
import { PAPER_INITIAL_CAPITAL } from './paper-balance.js';
import { logger } from '../utils/logger.js';

// 폴백: KIS API + DB 둘 다 실패 시에만 사용 (정상 운용 시 사용되지 않음)
const FALLBACK_SEED_KR = 0; // 0 = KIS 동기화 실패 시 매수 차단 (임의 금액 사용 안 함)
const FALLBACK_SEED_OVERSEAS = 0;

// 캐시 (live 전용 — paper는 고정 상수 반환)
// TTL 1시간: 외부 입출금/DB 변경 반영 (이전: 서버 재시작까지 영구 캐시)
let cachedKrLive: number | null = null;
let cachedOverseasLive: number | null = null;
let cachedKrLiveAt = 0;
let cachedOverseasLiveAt = 0;
const SEED_CACHE_TTL_MS = 60 * 60_000; // 1시간

export async function getSeedCapitalKr(): Promise<number> {
  if (getCtxIsPaper()) {
    return PAPER_INITIAL_CAPITAL;
  }

  if (cachedKrLive !== null && Date.now() - cachedKrLiveAt < SEED_CACHE_TTL_MS) return cachedKrLive;

  // 1순위: DB에 저장된 seed_capital
  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      'SELECT seed_capital FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1',
    );
    if (rows[0] && Number(rows[0].seed_capital) > 0) {
      cachedKrLive = Number(rows[0].seed_capital);
      cachedKrLiveAt = Date.now();
      return cachedKrLive;
    }
  } catch {}

  // 2순위: KIS API에서 실제 순자산 동기화 (임의 상수 사용 안 함)
  try {
    const { getAccountBalance } = await import('../kis/account.js');
    const balance = await getAccountBalance(true); // forceLive
    const netAsset = balance.netAsset;
    if (netAsset > 0) {
      cachedKrLive = netAsset;
      cachedKrLiveAt = Date.now();
      logger.info(`💰 시드자본 KIS 동기화: ₩${netAsset.toLocaleString()} (DB 미설정 → 실계좌 순자산)`, { component: 'RISK' });
      // DB에도 저장 (다음 부팅 시 즉시 사용)
      try {
        const { getPool } = await import('../db/client.js');
        await getPool().query('UPDATE portfolio_allocation_config SET seed_capital = $1 WHERE is_paper = false', [netAsset]);
      } catch {}
      return cachedKrLive;
    }
  } catch {}

  // 3순위: 폴백 (0 = 매수 차단 — 임의 금액 절대 사용 안 함)
  cachedKrLive = FALLBACK_SEED_KR;
  logger.warn('⚠️ 시드자본 조회 실패: KIS+DB 모두 실패 → 0원 (매수 차단)', { component: 'RISK' });
  return cachedKrLive;
}

export async function getSeedCapitalOverseas(): Promise<number> {
  if (getCtxIsPaper()) {
    try {
      const { getPaperSeedKrw } = await import('../scheduler/overseas/state.js');
      const { fetchExchangeRate } = await import('../automation/macro-data.js');
      const rate = await fetchExchangeRate();
      return rate > 0 ? getPaperSeedKrw() / rate : FALLBACK_SEED_OVERSEAS;
    } catch {
      return FALLBACK_SEED_OVERSEAS;
    }
  }

  if (cachedOverseasLive !== null && Date.now() - cachedOverseasLiveAt < SEED_CACHE_TTL_MS) return cachedOverseasLive;

  // 1순위: DB system_state
  try {
    const { getPool } = await import('../db/client.js');
    const key = 'seed_capital_overseas';
    const { rows } = await getPool().query('SELECT value FROM system_state WHERE key = $1', [key]);
    if (rows[0] && Number(rows[0].value) > 0) {
      cachedOverseasLive = Number(rows[0].value);
      cachedOverseasLiveAt = Date.now();
      return cachedOverseasLive;
    }
  } catch {}

  // 2순위: KIS 해외 잔고에서 동기화 (cash + holdings value)
  try {
    const { getCash, getHoldings } = await import('../scheduler/overseas/state.js');
    const { fetchExchangeRate } = await import('../automation/macro-data.js');
    const rate = await fetchExchangeRate();
    const cash = await getCash(false, rate);
    const holdings = await getHoldings(false);
    let holdingsValue = 0;
    for (const [, h] of holdings) holdingsValue += h.qty * h.avgPrice;
    const totalUsd = cash + holdingsValue;
    if (totalUsd > 0) {
      cachedOverseasLive = totalUsd;
      logger.info(`💰 해외 시드자본 동기화: $${totalUsd.toFixed(0)} (DB 미설정 → 실계좌)`, { component: 'RISK' });
      return cachedOverseasLive;
    }
  } catch {}

  cachedOverseasLive = FALLBACK_SEED_OVERSEAS;
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
    cachedKrLiveAt = Date.now();
  } else {
    const key = 'seed_capital_overseas';
    await getPool().query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, String(amount)],
    );
    cachedOverseasLive = amount;
    cachedOverseasLiveAt = Date.now();
  }

  const label = market === 'KR' ? '국내' : '해외';
  const unit = market === 'KR' ? '원' : 'USD';
  logger.info(`💰 기준자본 설정 [${label}]: ${amount.toLocaleString()}${unit}`, { component: 'RISK' });
}

export function getSeedCapitalStatus() {
  const paper = getCtxIsPaper();
  return {
    kr: paper ? PAPER_INITIAL_CAPITAL : (cachedKrLive ?? 0),
    overseas: cachedOverseasLive ?? 0, // Paper 해외는 async에서만 정확 (환율 필요)
  };
}

// ── 일일 손실한도 ──
// Live: 총자산의 25% (CEO 지시 2026-06-12)
// Paper: 총자산의 80% (킬스위치와 통일 — 사실상 무제한 실험)
// 순수 함수: DB 쿼리 없음, caller가 투자금을 전달한다.

export const DAILY_LOSS_PCT_LIVE = 25;
export const DAILY_LOSS_PCT_PAPER = 80;

// ── 주간 손실한도 ──
// Live: 총자산의 50%
// Paper: 총자산의 95% (사실상 무제한)
export const WEEKLY_LOSS_PCT_LIVE = 50;
export const WEEKLY_LOSS_PCT_PAPER = 95;

export interface DailyLossLimit {
  basis: number; // 총자산 (caller가 전달: 현금+투자 합계)
  pct: number; // Live 25% / Paper 80%
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
export const OVERSEAS_LOSS_TIERS_PAPER = { warnPct: 60, blockPct: 75, killPct: 80 } as const;

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
