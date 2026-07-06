/**
 * Paper 현금 계산 — scheduler/overseas/state.ts에서 추출
 * API 라우트에서도 import 가능한 공유 레이어
 */
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { FALLBACK_FX_RATE, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

/** 통합증거금: Paper 시드 (KRW) — 환율 환산 후 USD로 거래 */
export const PAPER_OVERSEAS_SEED_KRW = Number(process.env.PAPER_OVERSEAS_SEED_KRW) || 30_000_000;

/** FX rate sanity range */
const FX_RATE_MIN = 1000;
const FX_RATE_MAX = 2500;

let _lastPaperCash: number | null = null;

/**
 * Paper 해외 시드 (KRW) — 고정값 반환
 * v21: us_pct 기반 동적 계산 제거 — 국내(60M)+해외(30M) 별도 풀 원칙
 * (이전: (60M+30M)×us_pct=63M → 국내 60M과 이중계상, 분모 불일치 49% 유발)
 */
export async function getEffectivePaperSeedKrw(): Promise<number> {
  return PAPER_OVERSEAS_SEED_KRW;
}

/**
 * Paper 현금을 orders 테이블에서 결정론적 계산 (통합증거금)
 */
export async function computePaperCash(fxRate?: number): Promise<number> {
  try {
    let rate = fxRate ?? (await fetchExchangeRate());
    if (!Number.isFinite(rate) || rate < FX_RATE_MIN || rate > FX_RATE_MAX) {
      logger.warn(`⚠️ FX rate 이상치 감지: ${rate} → ${FALLBACK_FX_RATE} 폴백`, { component: 'OVERSEAS' });
      rate = FALLBACK_FX_RATE;
    }
    const seedKrw = await getEffectivePaperSeedKrw();
    const seedUsd = seedKrw / rate;
    const { rows } = await getPool().query(`
      SELECT
        COALESCE(SUM(CASE WHEN side = 'BUY'
          THEN filled_price::numeric * filled_quantity::numeric * ${1 + OVERSEAS_FEE_PCT}
          ELSE 0 END), 0) AS total_buy,
        COALESCE(SUM(CASE WHEN side = 'SELL'
          THEN filled_price::numeric * filled_quantity::numeric * ${1 - OVERSEAS_FEE_PCT}
          ELSE 0 END), 0) AS total_sell
      FROM orders
      WHERE trading_mode = 'paper' AND is_paper = true AND status = 'FILLED' AND trigger_source = 'OVERSEAS'
    `);
    const totalBuyRaw = Number(rows[0]?.total_buy ?? 0);
    const totalSellRaw = Number(rows[0]?.total_sell ?? 0);
    const totalBuy = Number.isFinite(totalBuyRaw) ? totalBuyRaw : 0;
    const totalSell = Number.isFinite(totalSellRaw) ? totalSellRaw : 0;
    const computed = Math.max(0, seedUsd - totalBuy + totalSell);
    _lastPaperCash = computed;
    return computed;
  } catch (e) {
    logger.warn(`Paper 현금 조회 실패 (폴백 사용): ${(e as Error).message}`, { component: 'OVERSEAS' });
    if (_lastPaperCash !== null) return _lastPaperCash;
    const rate = fxRate ?? FALLBACK_FX_RATE;
    return PAPER_OVERSEAS_SEED_KRW / rate;
  }
}

/** 통합증거금 KRW 시드 반환 (표시용) */
export function getPaperSeedKrw(): number {
  return PAPER_OVERSEAS_SEED_KRW;
}
