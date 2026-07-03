/**
 * 해외 매매 상태 업데이트 — state.ts에서 분리
 */
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { cacheSet } from '../../cache/memory.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool, withTransaction } from '../../db/client.js';
import { modePrefix } from './utils.js';
import { cashKey, markTradeExecuted } from './state-cash.js';

/**
 * 트랜잭션 원자 업데이트 — holdings (+ live cash) 단일 TX
 * Paper: cash는 computed (orders 기반) → 저장 불필요
 * Live: newCash(USD)를 KRW로 변환 후 저장 (통합증거금 기준)
 */
export async function updateTradeState(p: {
  code: string;
  exchange: string;
  qty: number;
  avgPrice: number;
  newCash: number;
  isPaper?: boolean;
  fxRate?: number;
  tpPct?: number;
  slPct?: number;
}): Promise<void> {
  const paper = p.isPaper ?? getCtxIsPaper();
  markTradeExecuted(); // reconcileCashWithKIS 쿨다운 시작
  await withTransaction(async (client) => {
    if (p.qty <= 0) {
      await client.query('DELETE FROM overseas_holdings WHERE exchange=$1 AND stock_code=$2 AND is_paper=$3', [
        p.exchange,
        p.code,
        paper,
      ]);
    } else {
      await client.query(
        `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper, tp_pct, sl_pct)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7) ON CONFLICT (exchange,stock_code,is_paper) DO UPDATE SET quantity=$3, avg_price=$4,
           tp_pct = COALESCE($6, overseas_holdings.tp_pct),
           sl_pct = COALESCE($7, overseas_holdings.sl_pct)`,
        [p.code, p.exchange, p.qty, p.avgPrice, paper, p.tpPct ?? null, p.slPct ?? null],
      );
    }
    if (paper) {
      // v16.2.3: Paper도 현금 즉시 저장 (기존: 미저장 → 매도 후 반영 지연, 대시보드 금액 왜곡)
      const cashUsd = Math.max(0, p.newCash);
      await client.query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
        [cashKey(true), cashUsd.toFixed(2)],
      );
    } else {
      // Live: USD → KRW 변환 후 저장 (통합증거금)
      // Round to whole KRW to prevent FX round-trip drift (KRW→USD→KRW repeated conversion with rounding)
      const fxRate = p.fxRate ?? (await fetchExchangeRate());
      const cashKrw = Math.round(Math.max(0, p.newCash * fxRate));
      const key = cashKey(false);
      await client.query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, cashKrw.toString()],
      );
    }
  });
  // 매매 후 대시보드/잔고 캐시 즉시 무효화 (크로스오염 방지)
  const mode = paper ? 'paper' : 'live';
  // Invalidate dashboard/holdings/balance caches by setting null with 0 TTL
  cacheSet<null>(`overseas:dashboard:${mode}`, null, 0);
  cacheSet<null>(`overseas:holdings:${mode}`, null, 0);
  cacheSet<null>(`overseas:balance:${mode}`, null, 0);
}

/**
 * 포지션 청산 시 관련 overseas_state 키 일괄 삭제
 * 모든 매도 경로(sell-logic, concentration-cap, rotation, turtle, kis-sync, vision-scalp)에서
 * 이 함수 하나만 호출하면 dead 키 잔류를 방지할 수 있다.
 */
export async function cleanupPositionState(code: string, isPaper?: boolean): Promise<void> {
  const pfx = modePrefix(isPaper);
  const keys = [
    `${pfx}maxprice_${code}`,
    `${pfx}partial_tp_stage_${code}`,
    `${pfx}dynamic_tpsl_${code}`,
    `${pfx}scale_in_${code}`,
    `${pfx}turtle_trail_${code}`,
    `${pfx}sync_sell_pending_${code}`,
  ];
  await getPool()
    .query(`DELETE FROM overseas_state WHERE key = ANY($1)`, [keys])
    .catch(() => {});
  // concentration_code가 이 종목을 가리키면 제거
  await getPool()
    .query(`DELETE FROM overseas_state WHERE key = $1 AND value = $2`, [`${pfx}concentration_code`, code])
    .catch(() => {});
}
