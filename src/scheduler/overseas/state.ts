/**
 * DB 기반 보유종목·현금·트레일링 상태 관리
 * 서버 재시작해도 유지되는 영속 상태
 *
 * 통합증거금 모드:
 *   - Live: KIS API가 원화 기반 주문가능금액 반환 (별도 USD 풀 불필요)
 *   - Paper: orders 테이블에서 결정론적 계산 (상태 오염 불가능)
 */

import { fetchExchangeRate } from '../../automation/macro-data.js';
import { cacheGet, cacheSet } from '../../cache/memory.js';
import { FALLBACK_FX_RATE, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool, withTransaction } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { modePrefix } from './utils.js';

/** 통합증거금: Paper 시드 (KRW) — 환율 환산 후 USD로 거래 */
const PAPER_OVERSEAS_SEED_KRW = Number(process.env.PAPER_OVERSEAS_SEED_KRW) || 30_000_000;

/** FX rate sanity range — values outside this range indicate API error or parse failure */
const FX_RATE_MIN = 1000;
const FX_RATE_MAX = 2500;

/** paper/live 별 현금 키 */
export function cashKey(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'cash_paper' : 'cash';
}

/**
 * Paper 현금을 orders 테이블에서 결정론적 계산 (통합증거금)
 * seedUsd = PAPER_OVERSEAS_SEED_KRW / 환율
 * cash = seedUsd - Σ(매수비용+수수료) + Σ(매도수익-수수료)
 * → overseas_state 오염/리셋과 무관하게 항상 정확
 * → 환율 변동에 따라 USD 시드가 자연 조정 (실제 통합증거금과 동일)
 */
let _lastPaperCash: number | null = null; // DB 실패 시 마지막 정상값 반환용
let _lastTradeAt = 0; // 마지막 매매 시점 (ms) — reconcile 쿨다운용

/** 매매 발생 기록 — reconcileCashWithKIS 쿨다운 트리거 */
export function markTradeExecuted(): void {
  _lastTradeAt = Date.now();
}
/** 마지막 매매 후 경과 시간(ms) */
export function getTimeSinceLastTrade(): number {
  return Date.now() - _lastTradeAt;
}

export async function computePaperCash(fxRate?: number): Promise<number> {
  try {
    let rate = fxRate ?? (await fetchExchangeRate());
    // FX rate 범위 체크 — 비정상 값(API 오류/파싱 실패) 방어
    if (!Number.isFinite(rate) || rate < FX_RATE_MIN || rate > FX_RATE_MAX) {
      logger.warn(`⚠️ FX rate 이상치 감지: ${rate} → ${FALLBACK_FX_RATE} 폴백`, { component: 'OVERSEAS' });
      rate = FALLBACK_FX_RATE;
    }
    const seedUsd = PAPER_OVERSEAS_SEED_KRW / rate;
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
    _lastPaperCash = computed; // 성공 시 캐시
    return computed;
  } catch (e) {
    // DB 실패 시: 마지막 정상값 반환 (없으면 시드 폴백)
    // 이전에는 항상 full seed를 반환 → 매수 후 현금 증가 버그 유발
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

export async function ensureOverseasTable(): Promise<void> {
  // DDL은 migrations/011에서 관리. 여기서는 잘못 설정된 초기자본만 보정.
  try {
    // PK (exchange, stock_code, is_paper) → migration 035에서 관리
    // 기존 unique constraint 잔여물 정리만 수행
    await getPool()
      .query(`
      DO $$ BEGIN
        BEGIN ALTER TABLE overseas_holdings DROP CONSTRAINT IF EXISTS overseas_holdings_exchange_stock_code_key; EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN DROP INDEX IF EXISTS overseas_holdings_exchange_stock_code_key; EXCEPTION WHEN OTHERS THEN NULL; END;
      END $$;
    `)
      .catch(() => {});

    // ── 1회성 데이터 마이그레이션: cash + holdings 오염 복구 (트랜잭션 원자성) ──
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

    // ── 1회성: 통합증거금 전환 — 기존 paper 주문 아카이브 ──
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

    // ══════════════════════════════════════════════════
    // Live 해외 현금: 통합증거금 — KIS API에서 실제 주문가능금액 조회
    // 매매 이력 유무와 무관하게 항상 KIS 기준 동기화
    // ══════════════════════════════════════════════════
    const liveKey = cashKey(false); // 'cash'
    await getPool().query(`INSERT INTO overseas_state (key, value) VALUES ($1, '0') ON CONFLICT (key) DO NOTHING`, [
      liveKey,
    ]);

    // ══════════════════════════════════════════════════
    // Paper 해외 현금: computed 방식 (orders 테이블 기반 결정론적 계산)
    // overseas_state['cash_paper']는 캐시 역할만 — 실제 값은 항상 computePaperCash()
    // 통합증거금: KRW → 환율 환산 USD
    // ══════════════════════════════════════════════════
    const paperKey = cashKey(true);
    let fxRate = await fetchExchangeRate();
    // FX rate 범위 체크 (ensureOverseasTable 내부)
    if (!Number.isFinite(fxRate) || fxRate < FX_RATE_MIN || fxRate > FX_RATE_MAX) {
      logger.warn(`⚠️ ensureOverseasTable: FX rate 이상치 ${fxRate} → ${FALLBACK_FX_RATE} 폴백`, { component: 'OVERSEAS' });
      fxRate = FALLBACK_FX_RATE;
    }
    const computed = await computePaperCash(fxRate);
    const { rows: pkRows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [paperKey]);
    if (pkRows.length === 0) {
      await getPool().query(`INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [
        paperKey,
        computed.toFixed(2),
      ]);
      logger.info(
        `💰 Paper 통합증거금 초기화: ₩${(PAPER_OVERSEAS_SEED_KRW / 10000).toFixed(0)}만 → $${computed.toFixed(2)} (환율 ${fxRate.toFixed(0)})`,
        { component: 'OVERSEAS' },
      );
    } else {
      const stored = Number(pkRows[0].value);
      const diff = Math.abs(computed - stored);
      if (diff > 10 || stored < 0 || !Number.isFinite(stored)) {
        await getPool().query(`UPDATE overseas_state SET value = $1 WHERE key = $2`, [computed.toFixed(2), paperKey]);
        logger.warn(
          `🔧 Paper 현금 보정: $${stored.toFixed(2)} → $${computed.toFixed(2)} (통합증거금 ₩${(PAPER_OVERSEAS_SEED_KRW / 10000).toFixed(0)}만 / 환율 ${fxRate.toFixed(0)})`,
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
      // Skip rows with non-finite numeric values (NaN/Infinity from DB parse)
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

/** 보유종목 TP/SL % 수동 조절 (대시보드 UI에서 클릭 조절) */
export async function updateHoldingTpSl(
  code: string,
  tpPct: number | null,
  slPct: number | null,
  isPaper?: boolean,
): Promise<void> {
  const paper = isPaper ?? getCtxIsPaper();
  await getPool().query(
    `UPDATE overseas_holdings SET tp_pct = $1, sl_pct = $2 WHERE stock_code = $3 AND is_paper = $4 AND quantity > 0`,
    [tpPct, slPct, code, paper],
  );
}

/**
 * 현금 조회 — USD 반환 (트레이딩 로직용)
 * - Paper: orders 기반 결정론적 계산 (USD)
 * - Live: DB에 KRW 저장 → 환율로 USD 변환 반환
 * @param fxRate 동일 사이클 내 일관된 환율 전달 (미전달 시 자체 조회)
 */
export async function getCash(isPaper?: boolean, fxRate?: number): Promise<number> {
  const paper = isPaper ?? getCtxIsPaper();
  if (paper) {
    return computePaperCash(fxRate);
  }
  // Live: DB에 KRW 저장 → USD로 변환
  const krw = await getCashKrw();
  if (krw <= 0) return 0;
  const rate = fxRate ?? (await fetchExchangeRate());
  return rate > 0 ? krw / rate : 0;
}

/**
 * Live 현금 KRW 직접 조회 (디스플레이/리포트용)
 * overseas_state['cash']에 원화 금액 저장
 */
export async function getCashKrw(): Promise<number> {
  try {
    const { rows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [cashKey(false)]);
    if (rows.length === 0) return 0;
    const val = Number(rows[0].value);
    return Number.isFinite(val) ? val : 0;
  } catch (e) {
    logger.warn(`Live 현금(KRW) 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
    return 0;
  }
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
    if (!paper) {
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

// ── 트레일링 스탑용 최고가 추적 (paper/live 분리, 메모리 캐시 적용) ──
export async function getMaxPrice(code: string, isPaper?: boolean): Promise<number> {
  const cacheKey = `ov_maxprice:${modePrefix(isPaper)}${code}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached != null) return cached;
  try {
    const { rows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [
      `${modePrefix(isPaper)}maxprice_${code}`,
    ]);
    const raw = rows.length > 0 ? Number(rows[0].value) : 0;
    const val = Number.isFinite(raw) ? raw : 0;
    if (val > 0) cacheSet(cacheKey, val, 300); // 5min TTL
    return val;
  } catch (e) {
    logger.warn(`getMaxPrice 조회 실패 (${code}): ${(e as Error).message}`, { component: 'OVERSEAS' });
    return 0;
  }
}

export async function setMaxPrice(code: string, price: number, isPaper?: boolean): Promise<void> {
  const cacheKey = `ov_maxprice:${modePrefix(isPaper)}${code}`;
  cacheSet(cacheKey, price, 300); // 캐시 즉시 갱신
  await getPool()
    .query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`${modePrefix(isPaper)}maxprice_${code}`, price.toString()],
    )
    .catch(() => {});
}

export async function clearMaxPrice(code: string, isPaper?: boolean): Promise<void> {
  await getPool()
    .query('DELETE FROM overseas_state WHERE key = $1', [`${modePrefix(isPaper)}maxprice_${code}`])
    .catch(() => {});
}

// ── Paper 해외 자금 자동 리필 (자율학습 모드) ──────────────────────────
const OVERSEAS_REFILL_THRESHOLD = 0.15; // 시드 대비 15% 미만이면 리필
let lastOverseasRefillCheck = 0;

/**
 * Paper 해외 자금 고갈 시 자동 리필 (통합증거금 기준)
 * - 남은 현금 < 시드 15% + 보유종목 0건 → 리필 트리거
 * - 기존 overseas paper 주문을 아카이브
 * @returns true if refill happened
 */
export async function checkAndRefillOverseasPaper(): Promise<boolean> {
  const now = Date.now();
  if (now - lastOverseasRefillCheck < 5 * 60 * 1000) return false; // 30분→5분 (교착 감지 가속)
  lastOverseasRefillCheck = now;

  try {
    const fxRate = await fetchExchangeRate();
    const seedUsd = PAPER_OVERSEAS_SEED_KRW / (fxRate > 0 ? fxRate : FALLBACK_FX_RATE);
    const cash = await computePaperCash(fxRate);
    const cashRatio = cash / seedUsd;
    const holdings = await getHoldings(true);
    const hasPositions = [...holdings.values()].some((h) => h.qty > 0);

    if (cashRatio >= OVERSEAS_REFILL_THRESHOLD || hasPositions) return false;

    // v10.8.4 안전장치: 최근 1시간 내 매매가 있었으면 리필 차단 (현금 계산 일시 오류 방지)
    const { rows: recentTrades } = await getPool().query(
      `SELECT COUNT(*) AS cnt FROM orders
       WHERE trading_mode = 'paper' AND is_paper = true AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
       AND created_at > NOW() - INTERVAL '1 hour'`,
    );
    if (Number(recentTrades[0]?.cnt ?? 0) > 0) {
      logger.info('🔒 Paper 리필 차단: 최근 1시간 내 매매 존재 → 현금 재계산 대기', { component: 'OVERSEAS' });
      return false;
    }

    const pool = getPool();
    // 세대 번호
    const { rows: genRows } = await pool.query(
      `SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(value, '[^0-9]', '', 'g'), '') AS int)), 0) + 1 as next_gen
       FROM overseas_state WHERE key LIKE 'paper_us_gen_%'`,
    );
    const gen = genRows[0]?.next_gen ?? 1;

    // 기존 overseas paper 주문 아카이브 (varchar(10) 제한 → 'p_arch' 사용)
    const { rowCount } = await pool.query(
      `UPDATE orders SET trading_mode = 'p_arch'
       WHERE trading_mode = 'paper' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'`,
    );

    // overseas_holdings paper 삭제
    await pool.query(`DELETE FROM overseas_holdings WHERE is_paper = true`);

    // cash_paper 리셋 (환율 기준 USD)
    await pool.query(
      `INSERT INTO overseas_state (key, value) VALUES ('cash_paper', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [seedUsd.toFixed(2)],
    );

    // 세대 기록
    await pool.query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [
        `paper_us_gen_${gen}`,
        JSON.stringify({
          archivedAt: new Date().toISOString(),
          ordersArchived: rowCount,
          finalCashUsd: cash,
          seedKrw: PAPER_OVERSEAS_SEED_KRW,
          fxRate,
          seedUsd,
        }),
      ],
    );

    logger.info(
      `🔄 [PAPER-REFILL] 통합증거금 리필 (세대 #${gen}): $${cash.toFixed(0)} → $${seedUsd.toFixed(0)} (₩${(PAPER_OVERSEAS_SEED_KRW / 10000).toFixed(0)}만 / 환율 ${fxRate.toFixed(0)}) — ${rowCount}건 아카이브`,
      { component: 'OVERSEAS' },
    );
    return true;
  } catch (e) {
    logger.warn(`해외 Paper 리필 체크 실패: ${e}`, { component: 'OVERSEAS' });
    return false;
  }
}

/** 동적 TP/SL 저장 — 매매 엔진이 계산한 실시간 값을 대시보드에 동기화 */
export async function saveDynamicTpSl(code: string, tpPct: number, slPct: number, isPaper?: boolean): Promise<void> {
  const pfx = modePrefix(isPaper);
  const val = JSON.stringify({ tp: tpPct, sl: slPct, at: Date.now() });
  await getPool()
    .query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`${pfx}dynamic_tpsl_${code}`, val],
    )
    .catch(() => {});
}

/** 동적 TP/SL 조회 — 대시보드에서 사용 */
export async function getDynamicTpSl(
  codes: string[],
  isPaper?: boolean,
): Promise<Map<string, { tp: number; sl: number }>> {
  const pfx = modePrefix(isPaper);
  const keys = codes.map((c) => `${pfx}dynamic_tpsl_${c}`);
  const map = new Map<string, { tp: number; sl: number }>();
  if (keys.length === 0) return map;
  try {
    const { rows } = await getPool().query('SELECT key, value FROM overseas_state WHERE key = ANY($1)', [keys]);
    for (const r of rows) {
      const code = String(r.key).replace(`${pfx}dynamic_tpsl_`, '');
      try {
        const v = JSON.parse(r.value);
        const tp = Number(v.tp);
        const sl = Number(v.sl);
        if (Number.isFinite(tp) && Number.isFinite(sl)) {
          map.set(code, { tp, sl });
        }
      } catch {
        /* skip invalid JSON — non-critical */
      }
    }
  } catch (e) {
    logger.warn(`동적 TP/SL 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
  return map;
}

/** 동적 TP/SL 삭제 (포지션 청산 시) */
export async function clearDynamicTpSl(code: string, isPaper?: boolean): Promise<void> {
  await getPool()
    .query('DELETE FROM overseas_state WHERE key = $1', [`${modePrefix(isPaper)}dynamic_tpsl_${code}`])
    .catch(() => {});
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

/**
 * 황금비율 버킷별 투자 비중 계산
 * v10.8: 시장가 기준 (원가 기준 → 포트폴리오 비중 왜곡 방지)
 * currentPrices 맵이 있으면 시장가 사용, 없으면 avgPrice 폴백
 */
export function getBucketWeight(
  holdings: Map<string, { qty: number; avgPrice: number; bucket: string }>,
  portfolioValue: number,
  bucket: string,
  currentPrices?: Map<string, number>,
): number {
  if (portfolioValue <= 0) return 0;
  let bucketValue = 0;
  for (const [code, h] of holdings) {
    if (h.bucket === bucket) {
      const price = currentPrices?.get(code) ?? h.avgPrice;
      bucketValue += h.qty * price;
    }
  }
  return bucketValue / portfolioValue;
}

/**
 * 진입 전략 기반 버킷 자동 분류
 * - Premarket Dip / Vision Scalp 진입 → TACTICAL
 * - Momentum / BigMover / 추세확인 → SWING
 * - 우량주(BLUE_CHIP) + 장기시그널 → CORE
 */
export function classifyBucket(entrySource: string, isBlueChip = false): string {
  if (entrySource === 'DIP_BUY' || entrySource === 'SCALP') return 'TACTICAL';
  if (isBlueChip && (entrySource === 'TECHNICAL' || entrySource === 'OVERSOLD')) return 'CORE';
  return 'SWING';
}
