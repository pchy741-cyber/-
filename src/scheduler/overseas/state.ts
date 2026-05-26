/**
 * DB 기반 보유종목·현금·트레일링 상태 관리
 * 서버 재시작해도 유지되는 영속 상태
 */
import { OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { getPool, withTransaction } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

/** paper/live 별 현금 키 */
export function cashKey(isPaper?: boolean): string {
  return (isPaper ?? config.isPaper) ? 'cash_paper' : 'cash';
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
            const stateMap = new Map(stateRows.map((r: any) => [r.key, r.value]));
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
    } catch { /* 마이그레이션 실패 → 전체 롤백, 다음 실행 시 재시도 */ }

    // ══════════════════════════════════════════════════
    // Live 해외 현금: KIS 실잔고 기준, 해외매매 없으면 $0
    // ══════════════════════════════════════════════════
    const liveKey = cashKey(false); // 'cash'
    const { rows: liveOverseasOrders } = await getPool().query(
      "SELECT COUNT(*) as cnt FROM orders WHERE trading_mode = 'live' AND status = 'FILLED' AND trigger_source = 'OVERSEAS'");
    const liveOverseasCount = Number(liveOverseasOrders[0]?.cnt ?? 0);

    if (liveOverseasCount === 0) {
      // Live 해외매매 0건 → overseas cash/holdings 오염 정리
      const { rows: liveCheck } = await getPool().query("SELECT value FROM overseas_state WHERE key = $1", [liveKey]);
      const liveCash = liveCheck.length > 0 ? Number(liveCheck[0].value) : 0;
      if (liveCash > 0) {
        await getPool().query(
          `INSERT INTO overseas_state (key, value) VALUES ($1, '0') ON CONFLICT (key) DO UPDATE SET value = '0'`, [liveKey]);
        logger.info(`🔧 Live 해외현금 정리: $${liveCash.toFixed(0)} → $0 (해외매매 이력 0건)`, { component: 'OVERSEAS' });
      }
    } else {
      // Live 해외매매 이력 있음 → 키 없으면 $0 생성 (reconcileCashWithKIS가 보정)
      await getPool().query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, '0') ON CONFLICT (key) DO NOTHING`, [liveKey]);
    }

    // ══════════════════════════════════════════════════
    // Paper 해외 현금: $4K 시드 + 실현PnL 기반 정밀 복구
    // ══════════════════════════════════════════════════
    const PAPER_OVERSEAS_SEED = 4000; // Paper 해외 시드 $4K
    const paperKey = cashKey(true); // 'cash_paper'
    const { rows: pkRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = $1", [paperKey]);
    if (pkRows.length === 0) {
      await getPool().query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [paperKey, PAPER_OVERSEAS_SEED.toString()]);
      logger.info(`💰 Paper 해외 시드 초기화: $${PAPER_OVERSEAS_SEED}`, { component: 'OVERSEAS' });
    } else {
      const paperCash = Number(pkRows[0].value);
      // $0 + 보유0 → 미사용 상태 → 시드 재설정
      if (paperCash < 1) {
        const { rows: holdCheck } = await getPool().query(
          "SELECT COUNT(*) as cnt FROM overseas_holdings WHERE is_paper = true AND quantity > 0");
        if (Number(holdCheck[0]?.cnt ?? 0) === 0) {
          await getPool().query(
            `UPDATE overseas_state SET value = $1 WHERE key = $2`,
            [PAPER_OVERSEAS_SEED.toString(), paperKey]);
          logger.info(`💰 Paper 해외 $0 + 보유0 → 시드 재설정: $${PAPER_OVERSEAS_SEED}`, { component: 'OVERSEAS' });
        }
      }
      // cash_paper가 $10,000이고 거래이력이 있으면 → 리셋 버그 → 역산 복구
      if (Math.abs(paperCash - 10000) < 1) {
        const { rows: orderCheck } = await getPool().query(
          "SELECT COUNT(*) as cnt FROM orders WHERE trading_mode = 'paper' AND status = 'FILLED' AND trigger_source = 'OVERSEAS'");
        if (Number(orderCheck[0]?.cnt ?? 0) > 0) {
          // 실현 PnL = SUM((매도가 - 매수평균가) × 수량), 수수료 포함
          const { rows: pnlRows } = await getPool().query(`
            SELECT COALESCE(SUM(
              (filled_price::numeric - avg_buy_price::numeric) * filled_quantity::numeric
            ), 0) AS realized_pnl,
            COALESCE(SUM(
              (filled_price::numeric + avg_buy_price::numeric) * filled_quantity::numeric * ${OVERSEAS_FEE_PCT}
            ), 0) AS total_fees
            FROM orders
            WHERE trading_mode = 'paper' AND status = 'FILLED' AND side = 'SELL'
              AND trigger_source = 'OVERSEAS' AND avg_buy_price > 0 AND filled_price > 0`);

          // 현재 보유종목 원가 (현금에서 이미 빠진 돈)
          const { rows: holdRows } = await getPool().query(`
            SELECT COALESCE(SUM(quantity::numeric * avg_price::numeric), 0) AS cost
            FROM overseas_holdings WHERE is_paper = true AND quantity > 0`);

          const pnl = Number(pnlRows[0]?.realized_pnl ?? 0);
          const fees = Number(pnlRows[0]?.total_fees ?? 0);
          const holdCost = Number(holdRows[0]?.cost ?? 0);
          const corrected = Math.max(0, 10000 + pnl - fees - holdCost);

          if (Math.abs(corrected - 10000) > 1) {
            await getPool().query(
              `UPDATE overseas_state SET value = $1 WHERE key = $2`,
              [corrected.toFixed(2), paperKey]);
            logger.info(
              `🔧 Paper 잔고 복구: $10,000 → $${corrected.toFixed(2)} (PnL $${pnl.toFixed(0)}, 수수료 $${fees.toFixed(0)}, 보유원가 $${holdCost.toFixed(0)})`,
              { component: 'OVERSEAS' });
          }
        }
      }
    }
  } catch { /* 오류 무시 */ }
}

export async function getHoldings(isPaper?: boolean): Promise<Map<string, { qty: number; avgPrice: number; boughtAt: string; exchange: string }>> {
  const paper = isPaper ?? config.isPaper;
  const map = new Map();
  try {
    const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1', [paper]);
    for (const r of rows) {
      map.set(r.stock_code, { qty: Number(r.quantity), avgPrice: Number(r.avg_price), boughtAt: r.bought_at, exchange: r.exchange });
    }
  } catch { /* table might not exist yet */ }
  return map;
}

export async function setHolding(code: string, exchange: string, qty: number, avgPrice: number, isPaper?: boolean): Promise<void> {
  const paper = isPaper ?? config.isPaper;
  if (qty <= 0) {
    await getPool().query('DELETE FROM overseas_holdings WHERE exchange = $1 AND stock_code = $2 AND is_paper = $3', [exchange, code, paper]);
  } else {
    await getPool().query(
      `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE SET quantity = $3, avg_price = $4`,
      [code, exchange, qty, avgPrice, paper],
    );
  }
}

export async function getCash(isPaper?: boolean): Promise<number> {
  try {
    const key = cashKey(isPaper);
    const { rows } = await getPool().query("SELECT value FROM overseas_state WHERE key = $1", [key]);
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch { return 0; }
}

export async function setCash(amount: number, isPaper?: boolean): Promise<void> {
  const safe = Math.max(0, amount);
  const key = cashKey(isPaper);
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, safe.toString()],
  );
}

/**
 * 트랜잭션 원자 업데이트 — holdings + cash를 단일 TX로 묶어 중간 크래시 시 불일치 방지
 */
export async function updateTradeState(p: {
  code: string; exchange: string; qty: number; avgPrice: number;
  newCash: number; isPaper?: boolean;
}): Promise<void> {
  const paper = p.isPaper ?? config.isPaper;
  const key = cashKey(paper);
  await withTransaction(async (client) => {
    if (p.qty <= 0) {
      await client.query('DELETE FROM overseas_holdings WHERE exchange=$1 AND stock_code=$2 AND is_paper=$3', [p.exchange, p.code, paper]);
    } else {
      await client.query(
        `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper)
         VALUES ($1,$2,$3,$4,NOW(),$5) ON CONFLICT (exchange,stock_code,is_paper) DO UPDATE SET quantity=$3, avg_price=$4`,
        [p.code, p.exchange, p.qty, p.avgPrice, paper]);
    }
    const safe = Math.max(0, p.newCash);
    await client.query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, safe.toString()]);
  });
}

// ── 트레일링 스탑용 최고가 추적 ──
export async function getMaxPrice(code: string): Promise<number> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = $1",
      [`maxprice_${code}`],
    );
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch { return 0; }
}

export async function setMaxPrice(code: string, price: number): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [`maxprice_${code}`, price.toString()],
  ).catch(() => {});
}

export async function clearMaxPrice(code: string): Promise<void> {
  await getPool().query(
    "DELETE FROM overseas_state WHERE key = $1",
    [`maxprice_${code}`],
  ).catch(() => {});
}

// 부분 익절 3단계 시스템으로 이전됨 → risk-intelligence.ts 참조
