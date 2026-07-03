/**
 * 해외 보유종목 관리 — state.ts에서 분리
 */
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { FALLBACK_FX_RATE } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool, withTransaction } from '../../db/client.js';
import { computePaperCash, getEffectivePaperSeedKrw, PAPER_OVERSEAS_SEED_KRW } from '../../shared/overseas/paper-cash.js';
import { logger } from '../../utils/logger.js';
import { cashKey } from './state-cash.js';

const FX_RATE_MIN = 1000;
const FX_RATE_MAX = 2500;

export async function ensureOverseasTable(): Promise<void> {
  try {
    await getPool()
      .query(`
      DO $$ BEGIN
        BEGIN ALTER TABLE overseas_holdings DROP CONSTRAINT IF EXISTS overseas_holdings_exchange_stock_code_key; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN DROP INDEX IF EXISTS overseas_holdings_exchange_stock_code_key; EXCEPTION WHEN OTHERS THEN NULL; END;
      END $$;
    `)
      .catch(() => {});

    try {
      const { rows: migCheck } = await getPool().query("SELECT value FROM overseas_state WHERE key = '_integrity_v2'");
      if (migCheck.length === 0) {
        await withTransaction(async (tx) => {
          const { rows: liveBuys } = await tx.query(
            "SELECT COUNT(*) as cnt FROM orders WHERE trigger_source = 'OVERSEAS' AND is_paper = false AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED'",
          );
          const hasLiveBuys = Number(liveBuys[0]?.cnt ?? 0) > 0;

          if (!hasLiveBuys) {
            const { rows: stateRows } = await tx.query(
              "SELECT key, value FROM overseas_state WHERE key IN ('cash', 'cash_paper')",
            );
            const stateMap = new Map(stateRows.map((r: { key: string; value: string }) => [r.key, r.value]));
            const liveCashVal = Number(stateMap.get('cash') ?? 0);

            if (liveCashVal > 0 && !stateMap.has('cash_paper')) {
              await tx.query(
                `INSERT INTO overseas_state (key, value) VALUES ('cash_paper', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
                [liveCashVal.toString()],
              );
              logger.info(`🔧 cash → cash_paper 이전: $${liveCashVal}`, { component: 'OVERSEAS' });
            }
            await tx.query(
              `INSERT INTO overseas_state (key, value) VALUES ('cash', '0') ON CONFLICT (key) DO UPDATE SET value = '0'`,
            );

            await tx.query('DELETE FROM overseas_holdings WHERE quantity <= 0 AND is_paper = false');
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
            await tx.query('UPDATE overseas_holdings SET is_paper = true WHERE is_paper = false');

            await tx.query(`
              UPDATE orders SET trading_mode = 'paper'
              WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live'
                AND (kis_order_no LIKE 'VSP%' OR kis_order_no LIKE 'CLN%' OR kis_order_no LIKE 'POS%')
            `);

            logger.info(`🔧 해외 데이터 정합성 복구 완료 (live 해외매수 이력 없음 → 전체 paper 처리)`, {
              component: 'OVERSEAS',
            });
          }

          await tx.query(
            `INSERT INTO overseas_state (key, value) VALUES ('_integrity_v2', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
            [new Date().toISOString()],
          );
        });
      }
    } catch (e) {
      logger.warn(`해외 정합성 마이그레이션 실패 (다음 사이클 재시도): ${(e as Error).message}`, {
        component: 'OVERSEAS',
      });
    }

    try {
      const { rows: seedMig } = await getPool().query("SELECT value FROM overseas_state WHERE key = '_seed_unified_v1'");
      if (seedMig.length === 0) {
        const migratedAt = new Date().toISOString();
        let archivedCount = 0;
        await withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO overseas_state (key, value) VALUES ('_seed_unified_v1', $1) ON CONFLICT (key) DO NOTHING`,
            [JSON.stringify({ migratedAt, ordersArchived: 0, seedKrw: PAPER_OVERSEAS_SEED_KRW })],
          );
          const result = await tx.query(
            `UPDATE orders SET trading_mode = 'p_arch'
             WHERE trading_mode = 'paper' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'`,
          );
          archivedCount = result.rowCount ?? 0;
          await tx.query(`DELETE FROM overseas_holdings WHERE is_paper = true`);
          await tx.query(
            `UPDATE overseas_state SET value = $1 WHERE key = '_seed_unified_v1'`,
            [JSON.stringify({ migratedAt, ordersArchived: archivedCount, seedKrw: PAPER_OVERSEAS_SEED_KRW })],
          );
        });
        logger.info(
          `🔄 통합증거금 전환: ${archivedCount}건 paper 주문 아카이브 → ₩${(PAPER_OVERSEAS_SEED_KRW / 10000).toFixed(0)}만 클린스타트`,
          { component: 'OVERSEAS' },
        );
      }
    } catch (e) {
      logger.warn(`통합증거금 전환 마이그레이션 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
    }

    const liveKey = cashKey(false);
    await getPool().query(`INSERT INTO overseas_state (key, value) VALUES ($1, '0') ON CONFLICT (key) DO NOTHING`, [
      liveKey,
    ]);

    const paperKey = cashKey(true);
    let fxRate = await fetchExchangeRate();
    if (!Number.isFinite(fxRate) || fxRate < FX_RATE_MIN || fxRate > FX_RATE_MAX) {
      logger.warn(`⚠️ ensureOverseasTable: FX rate 이상치 ${fxRate} → ${FALLBACK_FX_RATE} 폴백`, { component: 'OVERSEAS' });
      fxRate = FALLBACK_FX_RATE;
    }
    const computed = await computePaperCash(fxRate);
    const seedKrw = await getEffectivePaperSeedKrw();
    const { rows: pkRows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [paperKey]);
    if (pkRows.length === 0) {
      await getPool().query(`INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [
        paperKey,
        computed.toFixed(2),
      ]);
      logger.info(
        `💰 Paper 통합증거금 초기화: ₩${(seedKrw / 10000).toFixed(0)}만 → $${computed.toFixed(2)} (환율 ${fxRate.toFixed(0)})`,
        { component: 'OVERSEAS' },
      );
    } else {
      const stored = Number(pkRows[0].value);
      const diff = Math.abs(computed - stored);
      if (diff > 10 || stored < 0 || !Number.isFinite(stored)) {
        await getPool().query(`UPDATE overseas_state SET value = $1 WHERE key = $2`, [computed.toFixed(2), paperKey]);
        logger.warn(
          `🔧 Paper 현금 보정: $${stored.toFixed(2)} → $${computed.toFixed(2)} (통합증거금 ₩${(seedKrw / 10000).toFixed(0)}만 / 환율 ${fxRate.toFixed(0)})`,
          { component: 'OVERSEAS' },
        );
      }
    }
  } catch (e) {
    logger.error(`ensureOverseasTable 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

export async function getHoldings(isPaper?: boolean): Promise<
  Map<
    string,
    {
      qty: number;
      avgPrice: number;
      boughtAt: string;
      exchange: string;
      tpPct: number | null;
      slPct: number | null;
      bucket: string;
      averagingCount: number;
    }
  >
> {
  const paper = isPaper ?? getCtxIsPaper();
  const map = new Map();
  try {
    const { rows } = await getPool().query(
      `SELECT stock_code, quantity, avg_price, bought_at, exchange, tp_pct, sl_pct, strategy_bucket, averaging_count
       FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1`,
      [paper],
    );
    for (const r of rows) {
      const qty = Number(r.quantity);
      const avgPrice = Number(r.avg_price);
      if (!Number.isFinite(qty) || !Number.isFinite(avgPrice)) continue;
      map.set(r.stock_code, {
        qty,
        avgPrice,
        boughtAt: r.bought_at,
        exchange: r.exchange,
        tpPct: r.tp_pct != null ? Number(r.tp_pct) : null,
        slPct: r.sl_pct != null ? Number(r.sl_pct) : null,
        bucket: r.strategy_bucket ?? 'SWING',
        averagingCount: Number(r.averaging_count) || 0,
      });
    }
  } catch (e) {
    logger.warn(`getHoldings 조회 실패 (테이블 미존재 가능): ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
  return map;
}

export async function setHolding(
  code: string,
  exchange: string,
  qty: number,
  avgPrice: number,
  isPaper?: boolean,
  opts?: { tpPct?: number; slPct?: number; bucket?: string },
): Promise<void> {
  const paper = isPaper ?? getCtxIsPaper();
  if (qty <= 0) {
    await getPool().query('DELETE FROM overseas_holdings WHERE exchange = $1 AND stock_code = $2 AND is_paper = $3', [
      exchange,
      code,
      paper,
    ]);
  } else {
    await getPool().query(
      `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at, is_paper, tp_pct, sl_pct, strategy_bucket)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8)
       ON CONFLICT (exchange, stock_code, is_paper) DO UPDATE SET quantity = $3, avg_price = $4,
         tp_pct = COALESCE($6, overseas_holdings.tp_pct),
         sl_pct = COALESCE($7, overseas_holdings.sl_pct),
         strategy_bucket = COALESCE($8, overseas_holdings.strategy_bucket)`,
      [code, exchange, qty, avgPrice, paper, opts?.tpPct ?? null, opts?.slPct ?? null, opts?.bucket ?? null],
    );
  }
}

export async function updateHoldingTpSl(
  code: string,
  tpPct: number | null,
  slPct: number | null,
  isPaper?: boolean,
  exchange?: string,
): Promise<void> {
  const paper = isPaper ?? getCtxIsPaper();
  if (exchange) {
    await getPool().query(
      `UPDATE overseas_holdings SET tp_pct = $1, sl_pct = $2 WHERE stock_code = $3 AND exchange = $4 AND is_paper = $5 AND quantity > 0`,
      [tpPct, slPct, code, exchange, paper],
    );
  } else {
    await getPool().query(
      `UPDATE overseas_holdings SET tp_pct = $1, sl_pct = $2 WHERE stock_code = $3 AND is_paper = $4 AND quantity > 0`,
      [tpPct, slPct, code, paper],
    );
  }
}
