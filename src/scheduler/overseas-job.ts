import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { config } from '../config/index.js';
import { getPool, insertOrder, logSystem, updateOrder } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import {
  cancelOverseasOrder,
  getOverseasBalance,
  getOverseasDailyChart,
  getOverseasPrice,
  placeOverseasOrder,
  placeFractionalOverseasBuy,
  type OverseasPrice,
} from '../kis/overseas.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, reportError, reportSuccess } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';
import { analyzeOverseasWithAI, type OverseasStockInput } from '../ai/overseas/analyzer.js';
import { setOverseasScores } from '../cache/overseas-scores.js';
import {
  getFearGreedIndex,
  getUpcomingEarnings,
  getNewsSentiment,
  interpretMarketSentiment,
  hasEarningsRisk,
} from '../market/external-signals.js';

// 글로벌 감시 목록 — 미국 + 일본 + 대만 (안정 대형주 위주)
const GLOBAL_WATCHLIST = [
  // 🇺🇸 미국 7대 빅테크만 (시총 상위, 유동성 최고)
  { code: 'AAPL',  name: 'Apple',     exchange: 'NASDAQ', region: 'US' },
  { code: 'NVDA',  name: 'NVIDIA',    exchange: 'NASDAQ', region: 'US' },
  { code: 'MSFT',  name: 'Microsoft', exchange: 'NASDAQ', region: 'US' },
  { code: 'GOOGL', name: 'Google',    exchange: 'NASDAQ', region: 'US' },
  { code: 'AMZN',  name: 'Amazon',    exchange: 'NASDAQ', region: 'US' },
  { code: 'TSLA',  name: 'Tesla',     exchange: 'NASDAQ', region: 'US' },
  { code: 'META',  name: 'Meta',      exchange: 'NASDAQ', region: 'US' },
];

// ─── 포지션 한도 (미국/아시아 공통) ───
const MAX_POSITIONS = 5;           // 최대 동시 보유 종목 (집중 투자)
const POSITION_SIZE_USD = 4000;    // 종목당 최대 투자금 (스윙 적극 투자)
const POSITION_PCT = 0.28;         // 또는 가용 현금의 28%

function resolveOverseasStockName(code: string, exchange: string): string {
  return GLOBAL_WATCHLIST.find((s) => s.code === code && s.exchange === exchange)?.name
    ?? GLOBAL_WATCHLIST.find((s) => s.code === code)?.name
    ?? code;
}

// ── DB 기반 보유종목 관리 (서버 재시작해도 유지) ──
async function ensureOverseasTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS overseas_holdings (
      stock_code TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'NASDAQ',
      quantity NUMERIC NOT NULL DEFAULT 0,
      avg_price NUMERIC NOT NULL DEFAULT 0,
      bought_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (exchange, stock_code)
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS overseas_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  // One-time migration: PK 단일(stock_code) → 복합(exchange, stock_code)
  // 동일 코드가 다른 거래소에 존재할 경우 충돌 방지 (예: TSE 7203 vs 다른 거래소 동일 코드)
  const { rows: migRows } = await getPool().query(
    "SELECT value FROM overseas_state WHERE key = 'schema_holdings_v2'"
  ).catch(() => ({ rows: [] as { value: string }[] }));
  if (migRows.length === 0) {
    await getPool().query(`
      DO $$
      BEGIN
        -- 기존 단일 PK 제거 후 복합 PK 추가
        ALTER TABLE overseas_holdings DROP CONSTRAINT IF EXISTS overseas_holdings_pkey;
        BEGIN
          ALTER TABLE overseas_holdings ADD PRIMARY KEY (exchange, stock_code);
        EXCEPTION WHEN others THEN NULL; END;
      END $$;
    `).catch(() => {});
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ('schema_holdings_v2', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    ).catch(() => {});
  }

  // last_price 컬럼 추가 (장 외 시간 시세 영속화용)
  await getPool().query(`ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS last_price NUMERIC DEFAULT 0`).catch(() => {});
  await getPool().query(`ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS last_price_at TIMESTAMPTZ`).catch(() => {});

  // 감시목록 전체 시세 영속화 테이블 (서버 재시작 후에도 마지막 시세 표시용)
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS overseas_prices (
      code TEXT NOT NULL,
      exchange TEXT NOT NULL,
      price NUMERIC NOT NULL DEFAULT 0,
      change_pct NUMERIC NOT NULL DEFAULT 0,
      volume NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (exchange, code)
    )
  `).catch(() => {});

  // 초기자본 수정: 이전 배포에서 $1,000으로 잘못 설정된 경우 $10,000으로 보정
  // (보유 포지션이 없고 현금이 $5,000 미만이면 초기 세팅 오류로 판단)
  try {
    const { rows: cashRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'cash'");
    const currentCash = cashRows.length > 0 ? Number(cashRows[0].value) : null;
    if (currentCash !== null && currentCash < 5000) {
      const { rows: holdingRows } = await getPool().query('SELECT COUNT(*) as cnt FROM overseas_holdings WHERE quantity > 0');
      const holdingCount = Number(holdingRows[0]?.cnt ?? 0);
      if (holdingCount === 0) {
        await getPool().query(
          `INSERT INTO overseas_state (key, value) VALUES ('cash', '10000') ON CONFLICT (key) DO UPDATE SET value = '10000'`
        );
      }
    }
  } catch { /* 오류 무시 */ }
}

async function getHoldings(): Promise<Map<string, { qty: number; avgPrice: number; boughtAt: string; exchange: string }>> {
  const map = new Map();
  try {
    const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
    for (const r of rows) {
      map.set(r.stock_code, { qty: Number(r.quantity), avgPrice: Number(r.avg_price), boughtAt: r.bought_at, exchange: r.exchange });
    }
  } catch { /* table might not exist yet */ }
  return map;
}

async function setHolding(code: string, exchange: string, qty: number, avgPrice: number): Promise<void> {
  if (qty <= 0) {
    await getPool().query('DELETE FROM overseas_holdings WHERE exchange = $1 AND stock_code = $2', [exchange, code]);
  } else {
    await getPool().query(
      `INSERT INTO overseas_holdings (stock_code, exchange, quantity, avg_price, bought_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (exchange, stock_code) DO UPDATE SET quantity = $3, avg_price = $4`,
      [code, exchange, qty, avgPrice],
    );
  }
}

async function getCash(): Promise<number> {
  try {
    const { rows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'cash'");
    return rows.length > 0 ? Number(rows[0].value) : 10000;
  } catch { return 10000; }
}

async function setCash(amount: number): Promise<void> {
  // cap 제거 — 수익 누적 허용 (기존: 초기자본으로 강제 제한 → 수익 소멸 버그)
  const safe = Math.max(0, amount);
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ('cash', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [safe.toString()],
  );
}

/** 트레일링 스탑용 최고가 추적 */
async function getMaxPrice(code: string): Promise<number> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = $1",
      [`maxprice_${code}`],
    );
    return rows.length > 0 ? Number(rows[0].value) : 0;
  } catch { return 0; }
}

async function setMaxPrice(code: string, price: number): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [`maxprice_${code}`, price.toString()],
  ).catch(() => {});
}

async function clearMaxPrice(code: string): Promise<void> {
  await getPool().query(
    "DELETE FROM overseas_state WHERE key = $1",
    [`maxprice_${code}`],
  ).catch(() => {});
}

let isRunning = false;

// ── 현재 열려 있는 시장 판별 (KST 기준) ──
// 크론이 시간 제어를 해주지만, 같은 job이 미국/아시아 시간에 모두 실행되므로
// 해당 시간에 실제로 열린 시장 종목만 필터링해 불필요한 API 호출 방지
function getOpenMarketRegions(): Set<string> {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const mins = h * 60 + m;
  const open = new Set<string>();

  // 🇺🇸 미국 NYSE/NASDAQ
  // 표준시(11~3월): KST 23:30 ~ 익일 06:00 / 서머타임(3~11월): KST 22:30 ~ 익일 05:00
  // 안전 마진으로 22:30~06:30 윈도우 사용 (API가 장 외 시간엔 0 반환 → 자동 필터됨)
  if (mins >= 22 * 60 + 30 || mins <= 6 * 60 + 30) open.add('US');

  // 🇯🇵 일본 TSE: JST = KST (동일 시간대)
  //   오전장: 09:00~11:30 KST, 오후장: 12:30~15:30 KST
  if ((mins >= 9 * 60 && mins <= 11 * 60 + 30) ||
      (mins >= 12 * 60 + 30 && mins <= 15 * 60 + 30)) open.add('JP');

  // 🇹🇼 대만 TWSE: CST(UTC+8) 09:00~13:30 = KST(UTC+9) 10:00~14:30
  if (mins >= 10 * 60 && mins <= 14 * 60 + 30) open.add('TW');

  return open;
}

// ── 세션 캐시 (미국/아시아 별도 관리) ──
// 장 시작 시 전 종목 기술점수 스캔 → 상위 종목만 매 사이클 처리 (API 비용 절감)
interface SessionCache {
  topCodes: string[];
  sessionDate: string;
  techCache: Map<string, { score: number; rsi: number; adx: number; signal: string; trendStrength: string; isMomentum: boolean; dayRangePct: number }>;
}
let usSessionCache: SessionCache | null = null;
let asiaSessionCache: SessionCache | null = null;
const US_TOP_COUNT = 6;
const ASIA_TOP_COUNT = 6;
let sessionStartPortfolioValue: number | null = null;

/** 미국장 세션 캐시 초기화 (runner.ts 23:20 호출) */
export function resetUSSessionCache(): void {
  usSessionCache = null;
  sessionStartPortfolioValue = null;
}

/** 아시아장 세션 캐시 초기화 (runner.ts 08:50 호출) */
export function resetAsiaSessionCache(): void {
  asiaSessionCache = null;
}

/** KST 날짜 문자열 반환 */
function getKSTDateString(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

/** 미국 세션 ID — KST 기준 날짜+야간세션(0~6시는 전날로 묶음) */
function getUSSessionId(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  // 0~6시 → 전날 세션으로 묶기
  if (h < 7) kst.setUTCDate(kst.getUTCDate() - 1);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

interface OverseasExecutionResult {
  submitted: boolean;
  filledQty: number;
  filledPrice: number;
  finalQty: number;
  finalAvgPrice: number;
  orderNo: string;
}

/**
 * 최근 해외 매도 실적 요약 — AI 자기학습용 컨텍스트
 * 최근 20건 SELL 주문에서 win/loss + 평균 PnL 계산
 */
async function getRecentPerfSummary(): Promise<string> {
  try {
    const { rows } = await getPool().query(`
      SELECT ai_reasoning, filled_price, quantity
      FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND side = 'SELL'
        AND status = 'FILLED'
        AND filled_price IS NOT NULL
        AND created_at >= NOW() - INTERVAL '14 days'
      ORDER BY created_at DESC
      LIMIT 20
    `);
    if (rows.length === 0) return '';

    let wins = 0, losses = 0, totalPnlPct = 0, counted = 0;
    for (const r of rows) {
      const match = String(r.ai_reasoning ?? '').match(/\[avgBuy:([\d.]+)\]/);
      if (!match) continue;
      const avgBuy = Number(match[1]);
      const fillPx = Number(r.filled_price);
      if (avgBuy <= 0 || fillPx <= 0) continue;
      const pnlPct = ((fillPx - avgBuy) / avgBuy) * 100;
      if (pnlPct >= 0) wins++; else losses++;
      totalPnlPct += pnlPct;
      counted++;
    }
    if (counted === 0) return '';

    const winRate = ((wins / counted) * 100).toFixed(0);
    const avgPnl = (totalPnlPct / counted).toFixed(2);
    return `최근 ${counted}건 실적: 승률 ${winRate}% (${wins}승 ${losses}패) | 평균 PnL ${Number(avgPnl) >= 0 ? '+' : ''}${avgPnl}%`;
  } catch {
    return '';
  }
}

interface OverseasWinRate { winRate: number; avgPnlPct: number; sampleCount: number; }

async function getOverseasWinRates(codes: string[]): Promise<Map<string, OverseasWinRate>> {
  const map = new Map<string, OverseasWinRate>();
  if (codes.length === 0) return map;
  try {
    const { rows } = await getPool().query(`
      SELECT
        stock_code,
        COUNT(*)::int AS total,
        SUM(CASE WHEN realized_pnl_pct >= 0 THEN 1 ELSE 0 END)::int AS wins,
        AVG(realized_pnl_pct)::float AS avg_pnl
      FROM (
        SELECT
          s.stock_code,
          ((f.filled_price - b.filled_price) / NULLIF(b.filled_price, 0) * 100) AS realized_pnl_pct
        FROM orders s
        JOIN orders b ON b.stock_code = s.stock_code
          AND b.side = 'BUY' AND b.status = 'FILLED'
          AND b.trigger_source = 'OVERSEAS'
          AND b.created_at < s.created_at
          AND b.filled_price IS NOT NULL
        WHERE s.stock_code = ANY($1)
          AND s.side = 'SELL' AND s.status = 'FILLED'
          AND s.trigger_source = 'OVERSEAS'
          AND s.created_at >= NOW() - INTERVAL '90 days'
          AND s.filled_price IS NOT NULL
        ORDER BY b.created_at DESC
      ) sub
      GROUP BY stock_code
      HAVING COUNT(*) >= 2
    `, [codes]);
    for (const r of rows) {
      map.set(String(r.stock_code), {
        winRate: Number(r.wins) / Number(r.total),
        avgPnlPct: Number(r.avg_pnl ?? 0),
        sampleCount: Number(r.total),
      });
    }
  } catch { /* DB 없으면 빈 맵 */ }
  return map;
}

async function getPendingOverseasStocks(): Promise<Set<string>> {
  const pending = new Set<string>();
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT stock_code
       FROM orders
       WHERE trigger_source = 'OVERSEAS'
         AND trading_mode = 'live'
         AND status = 'PENDING'
         AND created_at >= NOW() - INTERVAL '1 day'`,
    );
    for (const row of rows) {
      if (row.stock_code) pending.add(String(row.stock_code));
    }
  } catch (e) {
    logger.warn(`미체결 주문 조회 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
  return pending;
}

/**
 * PENDING 해외주문 재동기화 — 매 사이클 실행
 * - 15분 이상 PENDING: KIS 잔고 기반 체결 여부 확인
 * - 4시간 이상 PENDING: 타임아웃 처리 → CANCELLED
 * 이 함수가 없으면 PENDING 종목이 영구 스킵되어 매매 기회 소실
 */
export async function syncPendingOverseasOrders(): Promise<void> {
  try {
    const { rows } = await getPool().query(`
      SELECT id, stock_code, side, quantity, price,
             EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 AS age_minutes,
             kis_order_no
      FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND trading_mode = 'live'
        AND status = 'PENDING'
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `);
    if (rows.length === 0) return;
    logger.info(`🔄 PENDING 해외주문 재동기화: ${rows.length}건`, { component: 'OVERSEAS' });

    for (const order of rows) {
      const ageMin = Number(order.age_minutes);

      // 4시간(240분) 이상 미체결 → 타임아웃 취소
      if (ageMin >= 240) {
        await updateOrder(order.id, { status: 'CANCELLED', kis_status: 'TIMEOUT' });
        logger.info(`⏰ ${order.stock_code} PENDING 타임아웃 (${ageMin.toFixed(0)}분) → CANCELLED`, { component: 'OVERSEAS' });
        continue;
      }

      // 15분 이상: KIS 잔고로 체결 추정
      if (ageMin >= 15) {
        try {
          const stock = GLOBAL_WATCHLIST.find((s) => s.code === order.stock_code);
          const exchange = stock?.exchange ?? 'NASDAQ';
          const balances = await getOverseasBalance(exchange);
          const position = balances.find((b) => b.stockCode === order.stock_code);
          const currentQty = position?.quantity ?? 0;

          if (order.side === 'BUY' && currentQty > 0) {
            await updateOrder(order.id, {
              filled_quantity: Math.min(Number(order.quantity), currentQty),
              filled_price: position?.avgBuyPrice ?? Number(order.price),
              status: 'FILLED',
              kis_status: 'FILLED',
            });
            logger.info(`✅ ${order.stock_code} BUY PENDING→FILLED (잔고 확인: ${currentQty}주)`, { component: 'OVERSEAS' });
          } else if (order.side === 'SELL' && currentQty === 0) {
            await updateOrder(order.id, {
              filled_quantity: Number(order.quantity),
              filled_price: Number(order.price),
              status: 'FILLED',
              kis_status: 'FILLED',
            });
            logger.info(`✅ ${order.stock_code} SELL PENDING→FILLED (잔고 0 확인)`, { component: 'OVERSEAS' });
          }
        } catch (e) {
          logger.warn(`PENDING 재동기화 실패 (${order.stock_code}): ${(e as Error).message}`, { component: 'OVERSEAS' });
        }
      }
    }
  } catch (e) {
    logger.warn(`PENDING 재동기화 전체 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

async function confirmOverseasFillFromBalance(params: {
  code: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  requestedQty: number;
  previousQty: number;
  previousAvgPrice: number;
  fallbackPrice: number;
}): Promise<Pick<OverseasExecutionResult, 'filledQty' | 'filledPrice' | 'finalQty' | 'finalAvgPrice'>> {
  const { code, exchange, side, requestedQty, previousQty, previousAvgPrice, fallbackPrice } = params;
  const retryDelays = [2000, 4000, 7000];

  for (let i = 0; i < retryDelays.length; i++) {
    await new Promise((r) => setTimeout(r, retryDelays[i]));
    try {
      const balances = await getOverseasBalance(exchange);
      const position = balances.find((b) => b.stockCode === code);
      const currentQty = position?.quantity ?? 0;
      const currentAvg = position?.avgBuyPrice ?? previousAvgPrice;

      if (side === 'BUY' && currentQty > previousQty) {
        const deltaQty = Math.min(requestedQty, currentQty - previousQty);
        let inferredPrice = fallbackPrice;
        if (deltaQty > 0 && currentAvg > 0) {
          if (previousQty > 0) {
            const numer = currentAvg * currentQty - previousAvgPrice * previousQty;
            const avgFromDelta = numer / deltaQty;
            if (Number.isFinite(avgFromDelta) && avgFromDelta > 0) inferredPrice = avgFromDelta;
          } else {
            inferredPrice = currentAvg;
          }
        }
        return {
          filledQty: deltaQty,
          filledPrice: inferredPrice,
          finalQty: currentQty,
          finalAvgPrice: currentAvg,
        };
      }

      if (side === 'SELL' && currentQty < previousQty) {
        const deltaQty = Math.min(requestedQty, previousQty - currentQty);
        return {
          filledQty: deltaQty,
          filledPrice: fallbackPrice,
          finalQty: currentQty,
          finalAvgPrice: currentAvg,
        };
      }
    } catch (e) {
      logger.warn(`해외 체결 확인 실패 (${code}, 시도 ${i + 1}): ${(e as Error).message}`, { component: 'OVERSEAS' });
    }
  }

  return {
    filledQty: 0,
    filledPrice: fallbackPrice,
    finalQty: previousQty,
    finalAvgPrice: previousAvgPrice,
  };
}

/**
 * 미국장 마감 시 모든 PENDING 해외주문 강제 취소
 * syncPendingOverseasOrders()는 4시간 기준이라 마감 직전 주문은 안 잡힘
 * → 이 함수는 나이 제한 없이 전부 취소
 */
export async function cancelAllPendingOverseasOrders(): Promise<void> {
  try {
    const { rows } = await getPool().query(`
      SELECT id, stock_code, exchange, quantity, kis_order_no
      FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND trading_mode = $1
        AND status = 'PENDING'
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `, [config.isPaper ? 'paper' : 'live']);

    if (rows.length === 0) {
      logger.info('🇺🇸 미국장 마감: 취소할 PENDING 주문 없음', { component: 'OVERSEAS' });
      return;
    }

    logger.info(`🇺🇸 미국장 마감: PENDING 주문 ${rows.length}건 강제 취소`, { component: 'OVERSEAS' });
    for (const order of rows) {
      if (!order.kis_order_no) {
        await getPool().query(`UPDATE orders SET status = 'CANCELLED', kis_status = 'MARKET_CLOSED' WHERE id = $1`, [order.id]);
        continue;
      }
      const result = await cancelOverseasOrder({
        stockCode: order.stock_code,
        exchange: order.exchange ?? 'NASDAQ',
        orderNo: order.kis_order_no,
        quantity: Number(order.quantity),
      }).catch(() => ({ success: false, message: 'cancel failed' }));

      await getPool().query(
        `UPDATE orders SET status = 'CANCELLED', kis_status = $1 WHERE id = $2`,
        [result.success ? 'MARKET_CLOSED_CANCEL' : 'CANCEL_FAILED', order.id],
      );
      logger.info(
        `  ${result.success ? '✅' : '⚠️'} ${order.stock_code} 취소 ${result.success ? '성공' : '실패'}: ${result.message}`,
        { component: 'OVERSEAS' },
      );
    }
  } catch (e) {
    logger.error(`미국장 마감 PENDING 취소 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
  }
}

/**
 * 사용자 인사이트 — 대시보드에서 입력, DB에 저장, 매 사이클 AI에 주입
 */
export async function getUserInsights(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = 'user_insights'",
    );
    return rows.length > 0 ? String(rows[0].value) : '';
  } catch { return ''; }
}

export async function setUserInsights(text: string): Promise<void> {
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ('user_insights', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [text],
  );
}

/**
 * 글로벌 주식 자동매매 Job
 * AI(Claude) + 기술적 지표 복합 판단
 * 최대 5종목 동시 보유, 종목당 $1,500 / 20% 중 작은 값
 */
export async function runOverseasJob(): Promise<void> {
  if (isRunning) return;

  if (isKillSwitchActive()) {
    logger.warn('🛑 Kill Switch 활성 — 해외주식 스킵', { component: 'OVERSEAS' });
    return;
  }

  isRunning = true;

  try {
    // ── 시장 시간 필터: 현재 열린 시장 종목만 처리 ──
    const openRegions = getOpenMarketRegions();
    if (openRegions.size === 0) {
      logger.info('🌏 모든 해외 시장 마감 — 스킵', { component: 'OVERSEAS' });
      return;
    }
    const allActiveStocks = GLOBAL_WATCHLIST.filter(s => openRegions.has(s.region));
    const isUSSession = openRegions.has('US');
    const isAsiaSession = openRegions.has('JP') || openRegions.has('TW');
    const regionFlags = isUSSession ? '🇺🇸' : '🌏';

    await ensureOverseasTable();
    // PENDING 주문 재동기화 — 미체결 종목이 영구 스킵되는 버그 방지
    if (!config.isPaper) await syncPendingOverseasOrders();

    const holdings = await getHoldings();
    const pendingOrderStocks = await getPendingOverseasStocks();
    let cash = await getCash();
    const usCodes = GLOBAL_WATCHLIST.filter(s => s.region === 'US').map(s => s.code);

    // ── 세션 캐시: 미국/아시아 별도 관리 ──
    // 신규 세션이면 전 종목 스캔 → 이후 사이클은 보유 + 상위 후보만
    const todayStr = getKSTDateString();
    const usSessionId = getUSSessionId();
    const activeCache = isUSSession ? usSessionCache : asiaSessionCache;
    const sessionId = isUSSession ? usSessionId : todayStr;
    const isNewSession = !activeCache || activeCache.sessionDate !== sessionId;

    if (isNewSession) {
      if (isUSSession) usSessionCache = null;
      else asiaSessionCache = null;
      logger.info(`${regionFlags} 새 세션 시작 — 전 종목 점수 스캔 (${[...openRegions].join('/')})`, { component: 'OVERSEAS' });
    }

    // 기존 세션이면 보유 + 캐시 상위만 조회 (API 비용 절감)
    const currentCache = isUSSession ? usSessionCache : asiaSessionCache;
    let activeStocks = allActiveStocks;
    if (currentCache) {
      const heldCodes = new Set(holdings.keys());
      const targetCodes = new Set([...heldCodes, ...currentCache.topCodes]);
      activeStocks = allActiveStocks.filter(s => targetCodes.has(s.code));
      logger.info(
        `세션 캐시 사용 — ${activeStocks.length}종목 (보유:${heldCodes.size} + 후보:${currentCache.topCodes.length})`,
        { component: 'OVERSEAS' },
      );
    }

    logger.info(`${regionFlags} 해외주식 자동매매 시작 (${activeStocks.length}/${allActiveStocks.length}종목, 시장: ${[...openRegions].join('/')})`, { component: 'OVERSEAS' });

    // ── 1. 시세 + 차트 병렬 수집 (배치 5개씩, rate limit 준수) ──
    const techResults: Array<{
      code: string; name: string; exchange: string;
      price: OverseasPrice; signal: string; score: number;
      rsi: number; adx: number; trendStrength: string;
      dayRangePct: number; // 0=저가, 100=고가 위치
      isMomentum: boolean; // 당일 강한 상승 모멘텀
    }> = [];

    // 배치 처리: 5개씩 병렬 → rate limit 안전
    const BATCH = 5;
    for (let i = 0; i < activeStocks.length; i += BATCH) {
      const batch = activeStocks.slice(i, i + BATCH);
      const latestCache = isUSSession ? usSessionCache : asiaSessionCache;
      const settled = await Promise.allSettled(
        batch.map(async (stock) => {
          const price = await getOverseasPrice(stock.code, stock.exchange);
          // 세션 캐시에 기술점수가 있고 보유종목이 아니면 차트 재호출 생략
          const cached = latestCache?.techCache.get(stock.code);
          const chart = cached ? null : await getOverseasDailyChart(stock.code, stock.exchange, 40);
          return { stock, price, chart, cached };
        })
      );

      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const { stock, price, chart, cached } = result.value;
        if (price.currentPrice <= 0) continue;

        const dayRange = price.dayHigh - price.dayLow;
        const dayRangePct = dayRange > 0
          ? ((price.currentPrice - price.dayLow) / dayRange) * 100
          : 50;
        const isMomentum = price.changePct >= 3 && dayRangePct >= 60;

        let signal: string, score: number, rsi: number, adx: number, trendStrength: string;

        if (cached) {
          // 세션 캐시 재사용 (차트 재분석 불필요)
          ({ signal, score, rsi, adx, trendStrength } = cached);
        } else {
          if (!chart || chart.length < 30) continue;
          const candles: OHLCV[] = chart.map(c => ({
            date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          }));
          const tech = analyzeTechnicals(candles);
          if (!tech) continue;
          signal = tech.overallSignal; score = tech.score;
          rsi = tech.rsi14; adx = tech.adx14; trendStrength = tech.trendStrength;
        }

        // 세션 캐시에 기술점수 저장 (신규 스캔 시)
        if (isNewSession) {
          const cacheTarget = isUSSession ? usSessionCache : asiaSessionCache;
          if (cacheTarget) {
            cacheTarget.techCache.set(stock.code, { score, rsi, adx, signal, trendStrength, isMomentum, dayRangePct });
          }
        }

        techResults.push({
          code: stock.code, name: stock.name, exchange: stock.exchange,
          price, signal, score, rsi, adx, trendStrength, dayRangePct, isMomentum,
        });
        logger.info(
          `  ${stock.code}: $${price.currentPrice} ${price.changePct >= 0 ? '+' : ''}${price.changePct}% | ${signal}(${score}) RSI=${rsi.toFixed(0)} ADX=${adx.toFixed(0)} 일중${dayRangePct.toFixed(0)}%${isMomentum ? ' 🚀모멘텀' : ''}${cached ? ' [캐시]' : ''}`,
          { component: 'OVERSEAS' },
        );
      }

      // 배치 간 300ms 간격 (rate limit)
      if (i + BATCH < activeStocks.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // ── 1-c. 새 세션: 전 종목 스캔 완료 → 상위 종목 캐시 저장 ──
    if (isNewSession && techResults.length > 0) {
      const topCount = isUSSession ? US_TOP_COUNT : ASIA_TOP_COUNT;
      const sorted = [...techResults].sort((a, b) => {
        const sa = a.score + (a.isMomentum ? 30 : 0);
        const sb = b.score + (b.isMomentum ? 30 : 0);
        return sb - sa;
      });
      const topCodes = sorted.slice(0, topCount).map(t => t.code);
      const techCacheMap = new Map<string, { score: number; rsi: number; adx: number; signal: string; trendStrength: string; isMomentum: boolean; dayRangePct: number }>();
      for (const t of techResults) {
        techCacheMap.set(t.code, { score: t.score, rsi: t.rsi, adx: t.adx, signal: t.signal, trendStrength: t.trendStrength, isMomentum: t.isMomentum, dayRangePct: t.dayRangePct });
      }
      const newCache: SessionCache = { topCodes, sessionDate: sessionId, techCache: techCacheMap };
      if (isUSSession) usSessionCache = newCache;
      else asiaSessionCache = newCache;
      logger.info(`${regionFlags} 이번 세션 매수 후보: [${topCodes.join(', ')}] (score 기준 상위 ${topCount})`, { component: 'OVERSEAS' });
    }

    if (techResults.length === 0) {
      logger.warn('해외주식 분석 데이터 없음', { component: 'OVERSEAS' });
      return;
    }

    // ── 1-b. 대시보드용 점수 캐시 갱신 ──
    const regionMap = new Map(GLOBAL_WATCHLIST.map(s => [s.code, s.region as 'US' | 'JP' | 'TW']));
    // 보유종목 last_price DB 영속화 (장 외 시간 시세 표시용)
    for (const [code] of holdings) {
      const t = techResults.find(r => r.code === code);
      if (t && t.price.currentPrice > 0) {
        getPool().query(
          `UPDATE overseas_holdings SET last_price = $1, last_price_at = NOW() WHERE stock_code = $2`,
          [t.price.currentPrice, code],
        ).catch(() => {});
      }
    }

    // 감시목록 전체 시세 DB 영속화 (서버 재시작 후에도 마지막 시세 표시용)
    const priceRows = techResults.filter(t => t.price.currentPrice > 0);
    if (priceRows.length > 0) {
      const vals = priceRows.map((t, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(',');
      const params = priceRows.flatMap(t => [t.code, t.exchange, t.price.currentPrice, t.price.changePct, t.price.volume]);
      getPool().query(
        `INSERT INTO overseas_prices (code, exchange, price, change_pct, volume, updated_at)
         VALUES ${vals}
         ON CONFLICT (exchange, code) DO UPDATE SET
           price = EXCLUDED.price, change_pct = EXCLUDED.change_pct,
           volume = EXCLUDED.volume, updated_at = NOW()`,
        params,
      ).catch(() => {});
    }

    setOverseasScores(techResults.map(t => ({
      code: t.code,
      name: t.name,
      exchange: t.exchange,
      region: regionMap.get(t.code) ?? 'US',
      score: t.score,
      signal: t.signal,
      price: t.price.currentPrice,
      changePct: t.price.changePct,
      rsi: t.rsi,
      cachedAt: Date.now(),
    })));

    // ── 2. AI(Claude) 판단 — 보유종목 전체 + 비보유 중 상위만 ──
    const heldSet = new Set(holdings.keys());
    const allAiInputs: OverseasStockInput[] = techResults.map(t => {
      const holding = holdings.get(t.code);
      const pnlPct = holding
        ? ((t.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100
        : undefined;
      return {
        code: t.code, name: t.name, exchange: t.exchange,
        currentPrice: t.price.currentPrice, changePct: t.price.changePct,
        rsi: t.rsi, adx: t.adx, score: t.score,
        signal: t.signal, trendStrength: t.trendStrength,
        isHolding: !!holding,
        holdingPnlPct: pnlPct,
        dayRangePct: t.dayRangePct,
        isMomentum: t.isMomentum,
      };
    });

    // 세션 캐시 있을 때: 비보유 종목 중 상위 후보만 AI에 전달 (API 비용 절감)
    const latestSessionCache = isUSSession ? usSessionCache : asiaSessionCache;
    let aiInputs = allAiInputs;
    if (latestSessionCache) {
      const topSet = new Set(latestSessionCache.topCodes);
      aiInputs = allAiInputs.filter(s => heldSet.has(s.code) || topSet.has(s.code));
      if (aiInputs.length < allAiInputs.length) {
        logger.info(`🤖 AI 입력 최적화: ${allAiInputs.length} → ${aiInputs.length}종목 (세션 상위 후보만)`, { component: 'OVERSEAS' });
      }
    }

    // AI 호출 최적화: 매수 후보 or 보유종목 있을 때만 호출 (Gemini 비용 절감)
    const hasBuyCandidates = aiInputs.some(s => !s.isHolding && (s.score >= 20 || s.signal === 'BUY' || s.signal === 'STRONG_BUY'));
    const hasSellCandidates = aiInputs.some(s => s.isHolding);
    const shouldCallAI = hasBuyCandidates || hasSellCandidates;

    let aiDecisions: Awaited<ReturnType<typeof analyzeOverseasWithAI>> = [];
    if (shouldCallAI) {
      const [perfSummary, userInsights] = await Promise.all([getRecentPerfSummary(), getUserInsights()]);
      // 외부 신호 조기 조회 (AI 프롬프트에 포함)
      const [fgEarly, earningsEarly] = await Promise.all([
        getFearGreedIndex().catch(() => null),
        getUpcomingEarnings(usCodes).catch(() => [] as import('../market/external-signals.js').EarningsEvent[]),
      ]);
      const earningsRiskCodes = earningsEarly.filter(e => e.daysUntil >= 0 && e.daysUntil <= 5).map(e => e.code);
      const mktCtx = fgEarly ? {
        fearGreed: fgEarly.fearGreedScore,
        fearGreedLabel: fgEarly.fearGreedLabel,
        vix: fgEarly.vix,
        earningsRisk: earningsRiskCodes,
      } : undefined;
      aiDecisions = await analyzeOverseasWithAI(aiInputs, cash, holdings.size, perfSummary, userInsights || undefined, mktCtx);
    } else {
      logger.info('🤖 AI 생략 — 매수/매도 후보 없음 (비용 절감)', { component: 'OVERSEAS' });
    }

    // AI 결과를 코드 → 판단 맵으로 변환
    const aiMap = new Map(aiDecisions.map(d => [d.code, d]));

    // 종목별 해외 승률 로드 (AI 없을 때 스코어링 보정용)
    const overseasCodes = techResults.map(t => t.code);
    const overseasWinRates = await getOverseasWinRates(overseasCodes).catch(() => new Map<string, OverseasWinRate>());
    if (overseasWinRates.size > 0) {
      logger.info(`📈 해외 승률 데이터: ${overseasWinRates.size}종목`, { component: 'OVERSEAS' });
    }

    // ── 3. 매도 판단 ──
    const sellOrders: string[] = [];
    for (const [code, holding] of holdings) {
      if (pendingOrderStocks.has(code)) {
        logger.info(`⏳ 미체결 주문 존재 → ${code} 추가 주문 스킵`, { component: 'OVERSEAS' });
        continue;
      }
      const tech = techResults.find(t => t.code === code);
      if (!tech) continue;

      const curPrice = tech.price.currentPrice;
      const pnlPct = ((curPrice - holding.avgPrice) / holding.avgPrice) * 100;
      const ai = aiMap.get(code);

      // 트레일링 스탑: 최고가 갱신
      const prevMax = await getMaxPrice(code);
      const newMax = Math.max(prevMax || holding.avgPrice, curPrice);
      if (newMax > prevMax) await setMaxPrice(code, newMax);
      const maxPnlPct = ((newMax - holding.avgPrice) / holding.avgPrice) * 100;
      const drawdownFromPeak = ((curPrice - newMax) / newMax) * 100;

      let sellReason = '';

      // 1) 손절: -2.5% (하드 룰)
      if (pnlPct <= -2.5) {
        sellReason = `손절: ${pnlPct.toFixed(1)}%`;
      }
      // 2) 트레일링 스탑: 최고점 대비 -2.5% 하락 (최소 +2% 이상 수익 구간에서만)
      else if (maxPnlPct >= 2 && drawdownFromPeak <= -2.5) {
        sellReason = `트레일링 스탑: 최고 +${maxPnlPct.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}%`;
      }
      // 3) 하드 익절: +10% (모멘텀 상관없이 확정)
      else if (pnlPct >= 10) {
        sellReason = `익절(10%): +${pnlPct.toFixed(1)}%`;
      }
      // 4) AI 매도 신호 — confidence 60% 이상이면 구간 무관하게 신뢰
      else if (ai?.action === 'SELL' && ai.confidence >= 0.55) {
        sellReason = `AI 매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
      }
      // 5) AI 없을 때 기술적 익절: RSI 과매수(>75) + 점수 약화 + 최소 수익 확보
      else if (!ai && tech.rsi > 75 && tech.score < 15 && pnlPct >= 2) {
        sellReason = `기술 익절(과매수): RSI=${tech.rsi.toFixed(0)} +${pnlPct.toFixed(1)}%`;
      }
      // 6) AI 없을 때 소프트 익절: +6% 이상 수익 구간
      else if (!ai && pnlPct >= 6) {
        sellReason = `소프트 익절(AI없음): +${pnlPct.toFixed(1)}%`;
      }
      // 7) AI 없을 때 기술적 강매도: 점수 -25 이하 + SELL/STRONG_SELL
      else if (!ai && tech.score <= -25 && (tech.signal === 'SELL' || tech.signal === 'STRONG_SELL')) {
        sellReason = `기술적 매도(AI없음): score=${tech.score} RSI=${tech.rsi.toFixed(0)}`;
      }

      if (sellReason) {
        const exec = await executeOverseasOrder(
          code,
          'SELL',
          holding.qty,
          curPrice,
          tech.exchange,
          sellReason,
          holding.qty,
          holding.avgPrice,
        );
        if (!exec.submitted) continue;

        if (exec.filledQty <= 0) {
          pendingOrderStocks.add(code);
          sellOrders.push(`매도 접수 ${code} x${holding.qty} (체결 대기)`);
          continue;
        }

        await setHolding(code, tech.exchange, exec.finalQty, exec.finalAvgPrice);
        if (exec.finalQty <= 0) {
          await clearMaxPrice(code);
        }

        // 수수료 0.25% 차감 (해외주식 매도: 브로커 수수료 + 거래세 합산)
        const proceeds = exec.filledPrice * exec.filledQty * (1 - 0.0025);
        cash += proceeds;
        await setCash(cash);
        sellOrders.push(`매도 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${sellReason}) [수수료 $${(exec.filledPrice * exec.filledQty * 0.0025).toFixed(2)}]`);
      }
    }

    // ── 4. 리스크 관리: 포트폴리오 손실 한도 체크 ──
    // 현금만 보면 매수 후 항상 손실로 오인 → 보유종목 평가액 포함한 포트폴리오 기준으로 계산
    const holdingEvalUsd = Array.from(holdings.entries()).reduce((sum, [code, h]) => {
      const tech = techResults.find((t) => t.code === code);
      return sum + (tech ? tech.price.currentPrice * h.qty : h.avgPrice * h.qty);
    }, 0);
    const portfolioValue = cash + holdingEvalUsd;
    // 세션 시작 시 기준값 설정 (매일 리셋) — 누적 손실이 아닌 당일 손실만 체크
    if (sessionStartPortfolioValue === null) sessionStartPortfolioValue = portfolioValue;
    const dailyLossPct = ((portfolioValue - sessionStartPortfolioValue) / sessionStartPortfolioValue) * 100;
    const riskBlocked = dailyLossPct <= -8; // 8% 손실 시 당일 매수 중단
    if (riskBlocked) {
      logger.warn(`⛔ 리스크 한도 초과: 포트폴리오 $${portfolioValue.toFixed(0)} (${dailyLossPct.toFixed(1)}%) → 당일 신규 매수 차단`, { component: 'OVERSEAS' });
    }

    // ── 5. 매수 판단 ──
    const buyOrders: string[] = [];
    const updatedHoldings = await getHoldings();
    const currentHoldingCount = updatedHoldings.size;

    // 외부 신호: Fear&Greed + 어닝 캘린더 (병렬 조회)
    const [marketSentiment, upcomingEarnings] = await Promise.all([
      getFearGreedIndex().catch(() => null),
      getUpcomingEarnings(usCodes).catch(() => []),
    ]);
    const mktSignal = marketSentiment ? interpretMarketSentiment(marketSentiment) : null;
    if (mktSignal) {
      logger.info(`📊 시장 신호: ${mktSignal.reason}`, { component: 'OVERSEAS' });
    }

    if (!riskBlocked && currentHoldingCount < MAX_POSITIONS && cash >= 200) {
      const buyTargets = techResults
        .filter(t => !updatedHoldings.has(t.code) && !pendingOrderStocks.has(t.code))
        // 어닝 3일 이내 종목 매수 금지 (어닝 서프라이즈 리스크)
        .filter(t => {
          if (hasEarningsRisk(t.code, upcomingEarnings, 3)) {
            logger.info(`📅 어닝 리스크 차단: ${t.code} (3일 이내 실적 발표)`, { component: 'OVERSEAS' });
            return false;
          }
          return true;
        })
        // 극탐욕(F&G≥80) 또는 VIX 공황(>35) 시 신규 매수 차단 (극공포 역매수는 허용)
        .filter(t => {
          if (mktSignal && !mktSignal.allowBuy && !mktSignal.aggressive) {
            logger.info(`📊 시장 과열/공황 차단: ${t.code} — ${mktSignal.reason}`, { component: 'OVERSEAS' });
            return false;
          }
          return true;
        })
        .filter(t => {
          const ai = aiMap.get(t.code);
          // AI 신뢰도 65% 이상 + 상승 방향일 때만 진입
          if (ai?.action === 'BUY' && ai.confidence >= 0.65) return true;
          // STRONG_BUY는 60%도 허용
          if (ai?.action === 'BUY' && t.signal === 'STRONG_BUY' && ai.confidence >= 0.60) return true;
          // AI 없을 때: 강한 기술적 신호만 진입
          //   ADX ≥ 25 (추세 확실), score ≥ 40, RSI 적정 구간
          if (!ai) {
            const isBuySignal = t.signal === 'STRONG_BUY' && t.score >= 40 && t.adx >= 25;
            const rsiOk = t.isMomentum ? (t.rsi >= 30 && t.rsi <= 70) : (t.rsi >= 30 && t.rsi <= 60);
            return isBuySignal && rsiOk;
          }
          return false;
        })
        .map(t => ({ ...t, ai: aiMap.get(t.code) }))
        .sort((a, b) => {
          // AI 있으면 confidence 우선, 없으면 score + 모멘텀 + 승률 보너스
          const wrA = overseasWinRates.get(a.code);
          const wrB = overseasWinRates.get(b.code);
          const wrBoostA = wrA && wrA.sampleCount >= 2 ? (wrA.winRate >= 0.65 ? 15 : wrA.winRate >= 0.55 ? 8 : wrA.winRate <= 0.30 ? -15 : wrA.winRate <= 0.40 ? -8 : 0) : 0;
          const wrBoostB = wrB && wrB.sampleCount >= 2 ? (wrB.winRate >= 0.65 ? 15 : wrB.winRate >= 0.55 ? 8 : wrB.winRate <= 0.30 ? -15 : wrB.winRate <= 0.40 ? -8 : 0) : 0;
          const sa = (a.ai?.confidence ?? 0) * 100 + a.score * 0.3 + (a.isMomentum ? 20 : 0) + wrBoostA;
          const sb = (b.ai?.confidence ?? 0) * 100 + b.score * 0.3 + (b.isMomentum ? 20 : 0) + wrBoostB;
          return sb - sa;
        });

      const slotsAvailable = MAX_POSITIONS - currentHoldingCount;
      for (const target of buyTargets.slice(0, slotsAvailable)) {
        // 가용 현금의 70% 한도 (과잉 투자 방지)
        const positionSize = Math.min(portfolioValue * 0.15, POSITION_SIZE_USD, cash * 0.70);
        if (positionSize < 50) break;

        const qty = Math.floor(positionSize / (target.price.currentPrice * 1.0025)); // 수수료 0.25% 포함 단가
        if (qty <= 0) continue;

        const buyMode = target.isMomentum ? '🚀모멘텀' : '📉반등';
        const wrInfo = overseasWinRates.get(target.code);
        const wrTag = wrInfo && wrInfo.sampleCount >= 2 ? ` 승률${(wrInfo.winRate * 100).toFixed(0)}%/${wrInfo.sampleCount}건` : '';
        const reason = target.ai
          ? `${buyMode} AI(${(target.ai.confidence * 100).toFixed(0)}%): ${target.ai.reasoning}${wrTag}`
          : `${buyMode} 기술(AI없음): score=${target.score} RSI=${target.rsi.toFixed(0)} ADX=${target.adx.toFixed(0)}${wrTag}`;

        const exec = await executeOverseasOrder(
          target.code,
          'BUY',
          qty,
          target.price.currentPrice,
          target.exchange,
          reason,
          0,
          0,
        );
        if (!exec.submitted) continue;

        if (exec.filledQty <= 0) {
          pendingOrderStocks.add(target.code);
          buyOrders.push(`매수 접수 ${target.code} x${qty} ${buyMode} (체결 대기)`);
          continue;
        }

        // 수수료 0.25% 포함 실제 매수 비용
        const cost = exec.filledQty * exec.filledPrice * 1.0025;
        await setHolding(target.code, target.exchange, exec.finalQty, exec.finalAvgPrice);
        cash -= cost;
        await setCash(cash);
        buyOrders.push(`매수 ${target.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} ${buyMode} (AI ${((target.ai?.confidence ?? 0) * 100).toFixed(0)}%) [수수료 $${(exec.filledQty * exec.filledPrice * 0.0025).toFixed(2)}]`);
      }
    }

    // ── 5-b. 현금 파킹 전략 — 유휴 현금을 안전 ETF에 소수점 자동투자 ──
    const avgTechScore = techResults.length > 0
      ? techResults.reduce((s, t) => s + t.score, 0) / techResults.length
      : 0;
    const parkingResult = await runParkingStrategy({ cash, avgScore: avgTechScore, isUSSession });
    if (parkingResult.cashUsed > 0) {
      cash -= parkingResult.cashUsed;
      await setCash(cash);
    }
    const parkingOrders = parkingResult.actions;

    // ── 6. 결과 로그 ──
    const totalActions = buyOrders.length + sellOrders.length + parkingOrders.length;
    const finalHoldings = await getHoldings();
    const holdingList = Array.from(finalHoldings.entries()).map(([code, h]) => {
      const tech = techResults.find(t => t.code === code);
      const pnl = tech ? ((tech.price.currentPrice - h.avgPrice) / h.avgPrice * 100).toFixed(1) : '?';
      return `${code} x${h.qty} @$${h.avgPrice.toFixed(2)} (${Number(pnl) >= 0 ? '+' : ''}${pnl}%)`;
    });

    const summary = [
      `${regionFlags} 해외주식 자동매매 완료`,
      `분석: ${techResults.length}종목 | AI판단: ${aiDecisions.length}건 | 실행: ${totalActions}건`,
      `잔고: $${cash.toFixed(2)} | 보유: ${finalHoldings.size}/${MAX_POSITIONS}종목`,
      ...buyOrders.map(o => `🟢 ${o}`),
      ...sellOrders.map(o => `🔴 ${o}`),
      ...parkingOrders,
      holdingList.length > 0 ? `\n포트폴리오: ${holdingList.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    logger.info(summary, { component: 'OVERSEAS' });
    await logSystem('INFO', 'OVERSEAS', summary);

    if (totalActions > 0) {
      await sendTelegramMessage(summary);
    }

    reportSuccess();
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`해외주식 자동매매 실패: ${msg}`, { component: 'OVERSEAS' });
    await reportError('OVERSEAS', msg);
  } finally {
    isRunning = false;
  }
}

// ── 파킹 ETF (현금 자동운용) ──
// 시장 대기 현금을 안전 ETF에 소수점 매수 → 현금이 절대 놀지 않음
const PARKING_ETFS = [
  { code: 'SCHD', name: 'Schwab US Dividend ETF', exchange: 'NASDAQ' }, // 배당 중점
  { code: 'VOO',  name: 'Vanguard S&P500 ETF',    exchange: 'NYSE'   }, // 지수 추종
  { code: 'BND',  name: 'Vanguard Total Bond ETF', exchange: 'NYSE'   }, // 채권 (방어)
] as const;

// 거래 기회 대비 항상 남겨두는 현금 버퍼 ($)
const PARKING_CASH_BUFFER = 500;
// 파킹용 최소 주문 금액 ($)
const PARKING_MIN_ORDER = 20;

/**
 * 현금 파킹 전략 — 유휴 현금을 시장 상황에 따라 안전 ETF에 소수점 자동매수
 *
 * 상승장 (평균 score > 20): SCHD 45% + VOO 45% + BND 10%
 * 하락장 (평균 score < -10): SCHD 20% + VOO 10% + BND 70%
 * 중립:                      SCHD 35% + VOO 30% + BND 35%
 */
async function runParkingStrategy(params: {
  cash: number;
  avgScore: number; // 전체 종목 평균 기술점수 (시장 상황 판단용)
  isUSSession: boolean;
}): Promise<{ actions: string[]; cashUsed: number }> {
  const { cash, avgScore, isUSSession } = params;
  const actions: string[] = [];

  // 파킹은 미국 세션에서만 (ETF 거래 가능 시간)
  if (!isUSSession) return { actions, cashUsed: 0 };

  const investable = cash - PARKING_CASH_BUFFER;
  if (investable < PARKING_MIN_ORDER) return { actions, cashUsed: 0 };

  // 시장 상황별 ETF 비율
  let weights: Record<string, number>;
  if (avgScore > 20) {
    weights = { SCHD: 0.45, VOO: 0.45, BND: 0.10 }; // 상승장: 주식 ETF 집중
  } else if (avgScore < -10) {
    weights = { SCHD: 0.20, VOO: 0.10, BND: 0.70 }; // 하락장: 채권 방어
  } else {
    weights = { SCHD: 0.35, VOO: 0.30, BND: 0.35 }; // 중립: 균형
  }

  // 현재 파킹 보유 평가액 조회
  const parkingCodes = new Set<string>(PARKING_ETFS.map(e => e.code));
  let totalParkingValue = 0;
  const parkingPrices = new Map<string, number>();

  for (const etf of PARKING_ETFS) {
    try {
      const p = await getOverseasPrice(etf.code, etf.exchange);
      if (p.currentPrice > 0) parkingPrices.set(etf.code, p.currentPrice);
    } catch { /* skip */ }
  }

  const holdings = await getHoldings();
  for (const [code, h] of holdings) {
    if (parkingCodes.has(code)) {
      totalParkingValue += h.qty * (parkingPrices.get(code) ?? h.avgPrice);
    }
  }

  // 목표 파킹 총액 = 유휴현금의 70% (나머지 30%는 급매 기회 대비)
  const targetParking = investable * 0.70;
  const toInvest = Math.max(0, targetParking - totalParkingValue);
  if (toInvest < PARKING_MIN_ORDER) return { actions, cashUsed: 0 };

  const actualInvest = Math.min(toInvest, investable);
  let cashUsed = 0;

  for (const etf of PARKING_ETFS) {
    const alloc = actualInvest * (weights[etf.code] ?? 0);
    if (alloc < PARKING_MIN_ORDER) continue;

    const curPrice = parkingPrices.get(etf.code);
    if (!curPrice || curPrice <= 0) continue;

    if (config.isPaper) {
      // 모의투자: 소수점 수량 직접 계산
      const qty = alloc / curPrice;
      const h = holdings.get(etf.code);
      const prevQty = h?.qty ?? 0;
      const prevAvg = h?.avgPrice ?? 0;
      const newQty = prevQty + qty;
      const newAvg = newQty > 0 ? (prevAvg * prevQty + curPrice * qty) / newQty : curPrice;
      await setHolding(etf.code, etf.exchange, newQty, newAvg);
      await insertOrder({
        chain_id: null, stock_code: etf.code, side: 'BUY', order_type: '01',
        quantity: qty, price: curPrice,
        kis_order_no: `PKG${Date.now().toString(36)}`,
        kis_status: 'PAPER_FILLED', filled_quantity: qty, filled_price: curPrice,
        status: 'FILLED', trading_mode: 'paper', trigger_source: 'OVERSEAS',
        ai_reasoning: `파킹전략 소수점매수 (${avgScore >= 0 ? '상승' : '하락'}장 ${(weights[etf.code] * 100).toFixed(0)}% 배분)`,
      });
      cashUsed += alloc;
      actions.push(`📦 파킹매수 ${etf.code} $${alloc.toFixed(0)} ≈ ${qty.toFixed(4)}주 @$${curPrice.toFixed(2)}`);
    } else {
      try {
        const result = await placeFractionalOverseasBuy({ stockCode: etf.code, exchange: etf.exchange, amountUsd: alloc });
        if (result.success) {
          cashUsed += alloc;
          actions.push(`📦 파킹매수 ${etf.code} $${alloc.toFixed(0)} (${result.orderNo})`);
        } else {
          logger.warn(`파킹 소수점 주문 실패 ${etf.code}: ${result.message}`, { component: 'OVERSEAS' });
        }
      } catch (e) {
        logger.warn(`파킹 주문 오류 ${etf.code}: ${(e as Error).message}`, { component: 'OVERSEAS' });
      }
    }
  }

  if (cashUsed > 0) {
    logger.info(`📦 현금 파킹 완료: $${cashUsed.toFixed(0)} 투자 (남은현금 $${(cash - cashUsed).toFixed(0)}) | 시장: avgScore=${avgScore.toFixed(0)}`, { component: 'OVERSEAS' });
  }

  return { actions, cashUsed };
}

/**
 * 미국주식 주문 실행 (Paper / Live)
 */
async function executeOverseasOrder(
  code: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number,
  exchange: string,
  reasoning: string,
  previousQty: number,
  previousAvgPrice: number,
): Promise<OverseasExecutionResult> {
  const stockName = resolveOverseasStockName(code, exchange);

  if (config.isPaper) {
    const slippage = side === 'BUY' ? 0.001 : -0.001;
    const fillPrice = price * (1 + slippage);
    const fakeOrderNo = `USP${Date.now().toString(36)}`;

    const paperReasoning = side === 'SELL' && previousAvgPrice > 0
      ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}`
      : reasoning;
    await insertOrder({
      chain_id: null, stock_code: code, side, order_type: '01',
      quantity: qty, price: fillPrice, kis_order_no: fakeOrderNo,
      kis_status: 'PAPER_FILLED', filled_quantity: qty, filled_price: fillPrice,
      status: 'FILLED', trading_mode: 'paper', trigger_source: 'OVERSEAS',
      ai_reasoning: paperReasoning,
    });

    logger.info(`📝 [US_PAPER] ${side} ${code} x${qty} @$${fillPrice.toFixed(2)} (${fakeOrderNo})`, { component: 'OVERSEAS' });

    const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../notifications/web-push.js');
    if (side === 'BUY') {
      nb(code, stockName, qty, fillPrice, reasoning).catch(() => {});
    } else {
      const pnlPct = previousAvgPrice > 0 ? ((fillPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
      ns(code, stockName, qty, fillPrice, pnlPct, reasoning).catch(() => {});
    }
    const finalQty = side === 'BUY' ? previousQty + qty : Math.max(0, previousQty - qty);
    const finalAvgPrice = side === 'BUY' && finalQty > 0
      ? (previousAvgPrice * previousQty + fillPrice * qty) / finalQty
      : (finalQty > 0 ? previousAvgPrice : 0);
    return {
      submitted: true,
      filledQty: qty,
      filledPrice: fillPrice,
      finalQty,
      finalAvgPrice,
      orderNo: fakeOrderNo,
    };
  } else {
    try {
      const result = await placeOverseasOrder({ stockCode: code, exchange, side, quantity: qty, price });
      const liveReasoning = side === 'SELL' && previousAvgPrice > 0
        ? `[avgBuy:${previousAvgPrice.toFixed(4)}] ${reasoning}`
        : reasoning;
      const orderId = await insertOrder({
        chain_id: null, stock_code: code, side, order_type: '01',
        quantity: qty, price, kis_order_no: result.orderNo,
        kis_status: result.success ? 'SUBMITTED' : 'FAILED',
        filled_quantity: 0, filled_price: null,
        status: result.success ? 'PENDING' : 'FAILED', trading_mode: 'live',
        trigger_source: 'OVERSEAS', ai_reasoning: liveReasoning,
      });
      if (result.success) {
        logger.info(`🌍 [LIVE] 주문 접수: ${side} ${code} x${qty} @$${price.toFixed(2)} (${result.orderNo})`, { component: 'OVERSEAS' });
        const confirmed = await confirmOverseasFillFromBalance({
          code,
          exchange,
          side,
          requestedQty: qty,
          previousQty,
          previousAvgPrice,
          fallbackPrice: price,
        });

        if (confirmed.filledQty > 0) {
          await updateOrder(orderId, {
            filled_quantity: confirmed.filledQty,
            filled_price: confirmed.filledPrice,
            status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
            kis_status: confirmed.filledQty >= qty ? 'FILLED' : 'PARTIAL',
          });
          // 체결 확인 후 푸시 알림
          const { notifyOverseasBuy: nb, notifyOverseasSell: ns } = await import('../notifications/web-push.js');
          if (side === 'BUY') {
            nb(code, stockName, confirmed.filledQty, confirmed.filledPrice, reasoning).catch(() => {});
          } else {
            const pnlPct = previousAvgPrice > 0 ? ((confirmed.filledPrice - previousAvgPrice) / previousAvgPrice) * 100 : 0;
            ns(code, stockName, confirmed.filledQty, confirmed.filledPrice, pnlPct, reasoning).catch(() => {});
          }
        } else {
          logger.warn(`⏳ 체결 미확인: ${code} (${result.orderNo}) → PENDING 유지`, { component: 'OVERSEAS' });
        }

        return {
          submitted: true,
          filledQty: confirmed.filledQty,
          filledPrice: confirmed.filledPrice,
          finalQty: confirmed.finalQty,
          finalAvgPrice: confirmed.finalAvgPrice,
          orderNo: result.orderNo,
        };
      } else {
        logger.error(`🌍 주문 실패: ${code} - ${result.message}`, { component: 'OVERSEAS' });
        return {
          submitted: false,
          filledQty: 0,
          filledPrice: price,
          finalQty: previousQty,
          finalAvgPrice: previousAvgPrice,
          orderNo: result.orderNo,
        };
      }
    } catch (e) {
      logger.error(`🌍 주문 에러: ${code} - ${(e as Error).message}`, { component: 'OVERSEAS' });
      return {
        submitted: false,
        filledQty: 0,
        filledPrice: price,
        finalQty: previousQty,
        finalAvgPrice: previousAvgPrice,
        orderNo: '',
      };
    }
  }
}
