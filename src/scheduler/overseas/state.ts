/**
 * DB 기반 보유종목·현금·트레일링 상태 관리
 * 서버 재시작해도 유지되는 영속 상태
 *
 * 통합증거금 모드:
 *   - Live: KIS API가 원화 기반 주문가능금액 반환 (별도 USD 풀 불필요)
 *   - Paper: orders 테이블에서 결정론적 계산 (상태 오염 불가능)
 */
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool, withTransaction } from '../../db/client.js';
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { cacheSet } from '../../cache/memory.js';
import { logger } from '../../utils/logger.js';
import { modePrefix } from './utils.js';

const PAPER_OVERSEAS_SEED = 10000; // Paper 해외 시드 $10K (기존 주문 이력 기준 복원)

/** paper/live 별 현금 키 */
export function cashKey(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'cash_paper' : 'cash';
}

/**
 * Paper 현금을 orders 테이블에서 결정론적 계산
 * cash = SEED - Σ(매수비용+수수료) + Σ(매도수익-수수료)
 * → overseas_state 오염/리셋과 무관하게 항상 정확
 */
export async function computePaperCash(): Promise<number> {
  try {
    const { rows } = await getPool().query(`
      SELECT
        COALESCE(SUM(CASE WHEN side = 'BUY'
          THEN filled_price::numeric * filled_quantity::numeric * ${1 + OVERSEAS_FEE_PCT}
          ELSE 0 END), 0) AS total_buy,
        COALESCE(SUM(CASE WHEN side = 'SELL'
          THEN filled_price::numeric * filled_quantity::numeric * ${1 - OVERSEAS_FEE_PCT}
          ELSE 0 END), 0) AS total_sell
      FROM orders
      WHERE trading_mode = 'paper' AND status = 'FILLED' AND trigger_source = 'OVERSEAS'
    `);
    const totalBuy = Number(rows[0]?.total_buy ?? 0);
    const totalSell = Number(rows[0]?.total_sell ?? 0);
    return Math.max(0, PAPER_OVERSEAS_SEED - totalBuy + totalSell);
  } catch {
    return PAPER_OVERSEAS_SEED; // DB 실패 시 시드값 폴백
  }
}

export async function ensureOverseasTable(): Promise<void> {
  // DDL은 migrations/011에서 관리. 여기서는 잘못 설정된 초기자본만 보정.
  try {
    // PK (exchange, stock_code, is_paper) → migration 035에서 관리
    // 기존 unique constraint 잔여물 정리만 수행
    await getPool().query(`
      DO $$ BEGIN
        BEGIN ALTER TABLE overseas_holdings DROP CONSTRAINT IF EXISTS overseas_holdings_exchange_stock_code_key; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN DROP INDEX IF EXISTS overseas_holdings_exchange_stock_code_key; EXCEPTION WHEN OTHERS THEN NULL; END;
      END $$;
    `).catch(() => {});

    // ── 1회성 데이터 마이그레이션: cash + holdings 오염 복구 (트랜잭션 원자성) ──
    try {
      const { rows: migCheck } = await getPool().query(
        "SELECT value FROM overseas_state WHERE key = '_integrity_v2'");
      if (migCheck.length === 0) {
        await withTransaction(async (tx) => {
          const { rows: liveBuys } = await tx.query(
            "SELECT COUNT(*) as cnt FROM orders WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED'");
          const hasLiveBuys = Number(liveBuys[0]?.cnt ?? 0) > 0;

          if (!hasLiveBuys) {
            const { rows: stateRows } = await tx.query(
              "SELECT key, value FROM overseas_state WHERE key IN ('cash', 'cash_paper')");
            const stateMap = new Map(stateRows.map((r: { key: string; value: string }) => [r.key, r.value]));
            const liveCashVal = Number(stateMap.get('cash') ?? 0);

            if (liveCashVal > 0 && !stateMap.has('cash_paper')) {
              await tx.query(
                `INSERT INTO overseas_state (key, value) VALUES ('cash_paper', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
                [liveCashVal.toString()]);
              logger.info(`🔧 cash → cash_paper 이전: $${liveCashVal}`, { component: 'OVERSEAS' });
            }
            await tx.query(
              `INSERT INTO overseas_state (key, value) VALUES ('cash', '0') ON CONFLICT (key) DO UPDATE SET value = '0'`);

            await tx.query("DELETE FROM overseas_holdings WHERE quantity <= 0");
            await tx.query(`
              UPDATE overseas_holdings op SET
                quantity = op.quantity + ol.quantity,
                avg_price = CASE WHEN (op.quantity + ol.quantity) > 0
                  THEN (op.avg_price * op.quantity + ol.avg_price * ol.quantity) / (op.quantity + ol.quantity)
                  ELSE op.avg_price END
              FROM overseas_holdings ol
              WHERE op.exchange = ol.exchange AND op.stock_code = ol.stock_code
                AND op.is_paper = true AND ol.is_paper = false
            `);
            await tx.query(`
              DELETE FROM overseas_holdings ol
              WHERE ol.is_paper = false
                AND EXISTS (SELECT 1 FROM overseas_holdings op WHERE op.exchange = ol.exchange AND op.stock_code = ol.stock_code AND op.is_paper = true)
            `);
            await tx.query("UPDATE overseas_holdings SET is_paper = true WHERE is_paper = false");

            await tx.query(`
              UPDATE orders SET trading_mode = 'paper'
              WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live'
                AND (kis_order_no LIKE 'VSP%' OR kis_order_no LIKE 'CLN%' OR kis_order_no LIKE 'POS%')
            `);

            logger.info(`🔧 해외 데이터 정합성 복구 완료 (live 해외매수 이력 없음 → 전체 paper 처리)`, { component: 'OVERSEAS' });
          }

          await tx.query(
            `INSERT INTO overseas_state (key, value) VALUES ('_integrity_v2', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
            [new Date().toISOString()]);
        });
      }
    } catch (e) {
      logger.warn(`해외 정합성 마이그레이션 실패 (다음 사이클 재시도): ${(e as Error).message}`, { component: 'OVERSEAS' });
    }

    // ══════════════════════════════════════════════════
    // Live 해외 현금: 통합증거금 — KIS API에서 실제 주문가능금액 조회
    // 매매 이력 유무와 무관하게 항상 KIS 기준 동기화
    // ══════════════════════════════════════════════════
    const liveKey = cashKey(false); // 'cash'
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, '0') ON CONFLICT (key) DO NOTHING`, [liveKey]);

    // ══════════════════════════════════════════════════
    // Paper 해외 현금: computed 방식 (orders 테이블 기반 결정론적 계산)
    // overseas_state['cash_paper']는 캐시 역할만 — 실제 값은 항상 computePaperCash()
    // ══════════════════════════════════════════════════
    const paperKey = cashKey(true);
    const computed = await computePaperCash();
    const { rows: pkRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = $1", [paperKey]);
    if (pkRows.length === 0) {
      await getPool().query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [paperKey, computed.toFixed(2)]);
      logger.info(`💰 Paper 해외 현금 초기화: $${computed.toFixed(2)} (computed)`, { component: 'OVERSEAS' });
    } else {
      const stored = Number(pkRows[0].value);
      const diff = Math.abs(computed - stored);
      if (diff > 10 || stored < 0 || !Number.isFinite(stored)) {
        await getPool().query(
          `UPDATE overseas_state SET value = $1 WHERE key = $2`,
          [computed.toFixed(2), paperKey]);
        logger.warn(
          `🔧 Paper 현금 보정: $${stored.toFixed(2)} → $${computed.toFixed(2)} (orders 기반 계산)`,
          { component: 'OVERSEAS' });
      }
    }
  } catch (e) {
    logger.error(`ensureOverseasTable 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

export async function getHoldings(isPaper?: boolean): Promise<Map<string, { qty: number; avgPrice: number; boughtAt: string; exchange: string; tpPct: number | null; slPct: number | null }>> {
  const paper = isPaper ?? getCtxIsPaper();
  const map = new Map();
  try {
    const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1', [paper]);
    for (const r of rows) {
      map.set(r.stock_code, {
        qty: Number(r.quantity), avgPrice: Number(r.avg_price), boughtAt: r.bought_at, exchange: r.exchange,
        tpPct: r.tp_pct != null ? Number(r.tp_pct) : null,
        slPct: r.sl_pct != null ? Number(r.sl_pct) : null,
      });
    }
  } catch { /* table might not exist yet */ }
  return map;
}

export async function setHolding(code: string, exchange: string, qty: number, avgPrice: number, isPaper?: boolean, opts?: { tpPct?: number; slPct?: number }): Promise<void> {
  const paper = isPaper ?? getCtxIsPaper();
  if (qty <= 0) {
    await getPool().query('DELETE FROM overseas_holdings WHERE exchange = $1 AND stock_code = $2 AND is_paper = $3', [exchange, code, paper]);
  } else {
    await getPool().query(
      `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper, tp_pct, sl_pct)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)
       ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE SET quantity = $3, avg_price = $4,
         tp_pct = COALESCE($6, overseas_holdings.tp_pct),
         sl_pct = COALESCE($7, overseas_holdings.sl_pct)`,
      [code, exchange, qty, avgPrice, paper, opts?.tpPct ?? null, opts?.slPct ?? null],
    );
  }
}

/** 보유종목 TP/SL % 수동 조절 (대시보드 UI에서 클릭 조절) */
export async function updateHoldingTpSl(code: string, tpPct: number | null, slPct: number | null, isPaper?: boolean): Promise<void> {
  const paper = isPaper ?? getCtxIsPaper();
  await getPool().query(
    `UPDATE overseas_holdings SET tp_pct = $1, sl_pct = $2 WHERE stock_code = $3 AND is_paper = $4 AND quantity > 0`,
    [tpPct, slPct, code, paper],
  );
}

/**
 * 현금 조회 — USD 반환 (트레이딩 로직용)
 * - Paper: orders 기반 결정론적 계산 (USD)
 * - Live: DB에 KRW 저장 → 현재 환율로 USD 변환 반환
 */
export async function getCash(isPaper?: boolean): Promise<number> {
  const paper = isPaper ?? getCtxIsPaper();
  if (paper) {
    return computePaperCash();
  }
  // Live: DB에 KRW 저장 → USD로 변환
  const krw = await getCashKrw();
  if (krw <= 0) return 0;
  const fxRate = await fetchExchangeRate();
  return fxRate > 0 ? krw / fxRate : 0;
}

/**
 * Live 현금 KRW 직접 조회 (디스플레이/리포트용)
 * overseas_state['cash']에 원화 금액 저장
 */
export async function getCashKrw(): Promise<number> {
  try {
    const { rows } = await getPool().query("SELECT value FROM overseas_state WHERE key = $1", [cashKey(false)]);
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch { return 0; }
}

/** Live 현금 설정 — KRW 단위로 저장 (reconcileCashWithKIS에서 호출) */
export async function setCash(amountKrw: number, isPaper?: boolean): Promise<void> {
  const paper = isPaper ?? getCtxIsPaper();
  if (paper) return; // Paper: computed from orders, no need to store
  const safe = Math.max(0, amountKrw);
  const key = cashKey(false);
  await getPool().query(
    `INSERT INTO overseas_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, safe.toString()],
  );
}

/**
 * 트랜잭션 원자 업데이트 — holdings (+ live cash) 단일 TX
 * Paper: cash는 computed (orders 기반) → 저장 불필요
 * Live: newCash(USD)를 KRW로 변환 후 저장 (통합증거금 기준)
 */
export async function updateTradeState(p: {
  code: string; exchange: string; qty: number; avgPrice: number;
  newCash: number; isPaper?: boolean; fxRate?: number; tpPct?: number; slPct?: number;
}): Promise<void> {
  const paper = p.isPaper ?? getCtxIsPaper();
  await withTransaction(async (client) => {
    if (p.qty <= 0) {
      await client.query('DELETE FROM overseas_holdings WHERE exchange=$1 AND stock_code=$2 AND is_paper=$3', [p.exchange, p.code, paper]);
    } else {
      await client.query(
        `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper, tp_pct, sl_pct)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7) ON CONFLICT (exchange,stock_code,is_paper) DO UPDATE SET quantity=$3, avg_price=$4,
           tp_pct = COALESCE($6, overseas_holdings.tp_pct),
           sl_pct = COALESCE($7, overseas_holdings.sl_pct)`,
        [p.code, p.exchange, p.qty, p.avgPrice, paper, p.tpPct ?? null, p.slPct ?? null]);
    }
    if (!paper) {
      // Live: USD → KRW 변환 후 저장 (통합증거금)
      const fxRate = p.fxRate ?? await fetchExchangeRate();
      const cashKrw = Math.max(0, p.newCash * fxRate);
      const key = cashKey(false);
      await client.query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, cashKrw.toString()]);
    }
  });
  // 매매 후 대시보드/잔고 캐시 즉시 무효화 (크로스오염 방지)
  const mode = paper ? 'paper' : 'live';
  cacheSet(`overseas:dashboard:${mode}`, null as any, 0);
  cacheSet(`overseas:holdings:${mode}`, null as any, 0);
  cacheSet(`overseas:balance:${mode}`, null as any, 0);
}

// ── 트레일링 스탑용 최고가 추적 (paper/live 분리) ──
export async function getMaxPrice(code: string, isPaper?: boolean): Promise<number> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = $1",
      [`${modePrefix(isPaper)}maxprice_${code}`],
    );
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch { return 0; }
}

export async function setMaxPrice(code: string, price: number, isPaper?: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [`${modePrefix(isPaper)}maxprice_${code}`, price.toString()],
  ).catch(() => {});
}

export async function clearMaxPrice(code: string, isPaper?: boolean): Promise<void> {
  await getPool().query(
    "DELETE FROM overseas_state WHERE key = $1",
    [`${modePrefix(isPaper)}maxprice_${code}`],
  ).catch(() => {});
}

/** 동적 TP/SL 저장 — 매매 엔진이 계산한 실시간 값을 대시보드에 동기화 */
export async function saveDynamicTpSl(code: string, tpPct: number, slPct: number, isPaper?: boolean): Promise<void> {
  const pfx = modePrefix(isPaper);
  const val = JSON.stringify({ tp: tpPct, sl: slPct, at: Date.now() });
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [`${pfx}dynamic_tpsl_${code}`, val],
  ).catch(() => {});
}

/** 동적 TP/SL 조회 — 대시보드에서 사용 */
export async function getDynamicTpSl(codes: string[], isPaper?: boolean): Promise<Map<string, { tp: number; sl: number }>> {
  const pfx = modePrefix(isPaper);
  const keys = codes.map(c => `${pfx}dynamic_tpsl_${c}`);
  const map = new Map<string, { tp: number; sl: number }>();
  if (keys.length === 0) return map;
  try {
    const { rows } = await getPool().query(
      'SELECT key, value FROM overseas_state WHERE key = ANY($1)', [keys],
    );
    for (const r of rows) {
      const code = String(r.key).replace(`${pfx}dynamic_tpsl_`, '');
      try {
        const v = JSON.parse(r.value);
        map.set(code, { tp: Number(v.tp), sl: Number(v.sl) });
      } catch { /* skip invalid */ }
    }
  } catch { /* DB 실패 시 빈 맵 */ }
  return map;
}

/** 동적 TP/SL 삭제 (포지션 청산 시) */
export async function clearDynamicTpSl(code: string, isPaper?: boolean): Promise<void> {
  await getPool().query(
    "DELETE FROM overseas_state WHERE key = $1",
    [`${modePrefix(isPaper)}dynamic_tpsl_${code}`],
  ).catch(() => {});
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
    `sync_sell_pending_${code}`,
  ];
  await getPool().query(
    `DELETE FROM overseas_state WHERE key = ANY($1)`,
    [keys],
  ).catch(() => {});
  // concentration_code가 이 종목을 가리키면 제거
  await getPool().query(
    `DELETE FROM overseas_state WHERE key = $1 AND value = $2`,
    [`${pfx}concentration_code`, code],
  ).catch(() => {});
}
