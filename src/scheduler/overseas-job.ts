import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { config } from '../config/index.js';
import { getPool, insertOrder, logSystem, updateOrder } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import {
  getOverseasBalance,
  getOverseasDailyChart,
  getOverseasPrice,
  placeOverseasOrder,
  type OverseasPrice,
} from '../kis/overseas.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, reportError, reportSuccess } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';
import { analyzeOverseasWithAI, type OverseasStockInput } from '../ai/overseas/analyzer.js';
import { setOverseasScores } from '../cache/overseas-scores.js';

// 글로벌 감시 목록 — 미국 + 일본 + 대만 (안정 대형주 위주)
const GLOBAL_WATCHLIST = [
  // 🇺🇸 미국 (KST 23:30~06:30)
  { code: 'AAPL', name: 'Apple', exchange: 'NASDAQ', region: 'US' },
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ', region: 'US' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', region: 'US' },
  { code: 'GOOGL', name: 'Google', exchange: 'NASDAQ', region: 'US' },
  { code: 'AMZN', name: 'Amazon', exchange: 'NASDAQ', region: 'US' },
  { code: 'TSLA', name: 'Tesla', exchange: 'NASDAQ', region: 'US' },
  { code: 'META', name: 'Meta', exchange: 'NASDAQ', region: 'US' },
  // 🇯🇵 일본 (KST 09:00~11:30, 12:30~15:00)
  { code: '7203', name: 'Toyota', exchange: 'TSE', region: 'JP' },
  { code: '6758', name: 'Sony', exchange: 'TSE', region: 'JP' },
  { code: '6861', name: 'Keyence', exchange: 'TSE', region: 'JP' },
  { code: '8306', name: 'MUFG', exchange: 'TSE', region: 'JP' },
  { code: '6501', name: 'Hitachi', exchange: 'TSE', region: 'JP' },
  // 🇹🇼 대만 (KST 10:00~14:30)
  { code: '2330', name: 'TSMC', exchange: 'TPE', region: 'TW' },
  { code: '2317', name: 'Foxconn', exchange: 'TPE', region: 'TW' },
  { code: '2454', name: 'MediaTek', exchange: 'TPE', region: 'TW' },
  { code: '2308', name: 'Delta Electronics', exchange: 'TPE', region: 'TW' },
  { code: '3711', name: 'ASMedia', exchange: 'TPE', region: 'TW' },
];

// ─── 포지션 한도 (미국/아시아 공통) ───
const MAX_POSITIONS = 7;           // 최대 동시 보유 종목
const POSITION_SIZE_USD = 3000;    // 종목당 최대 투자금 (스윙 적극 투자)
const POSITION_PCT = 0.20;         // 또는 가용 현금의 20%

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

// ── 미국장 세션 캐시 ──
// 장 시작 시 전 종목 기술점수 스캔 → 상위 종목만 매 사이클 AI 호출 (비용 절감)
interface USSessionCache {
  topCodes: string[];   // 이번 세션 매수 후보 상위 코드
  sessionDate: string;  // 'YYYY-MM-DD HH' — 세션 구분용
  techCache: Map<string, { score: number; rsi: number; adx: number; signal: string; trendStrength: string; isMomentum: boolean; dayRangePct: number }>;
}
let usSessionCache: USSessionCache | null = null;
const US_TOP_COUNT = 6; // 매 사이클 AI에 넘길 최대 후보 수 (보유종목 제외)

/** 세션 캐시 초기화 (runner.ts에서 23:20에 호출) */
export function resetUSSessionCache(): void {
  usSessionCache = null;
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
async function syncPendingOverseasOrders(): Promise<void> {
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
    // 시간 필터 없음 — 크론 스케줄이 타이밍 제어, 여기서는 전 종목 처리
    const allActiveStocks = GLOBAL_WATCHLIST;
    const regionFlags = '🌏';

    await ensureOverseasTable();
    // PENDING 주문 재동기화 — 미체결 종목이 영구 스킵되는 버그 방지
    if (!config.isPaper) await syncPendingOverseasOrders();

    const holdings = await getHoldings();
    const pendingOrderStocks = await getPendingOverseasStocks();
    let cash = await getCash();

    // ── 세션 캐시: 신규 세션이면 전 종목 스캔 → 이후 사이클은 보유 + 상위 후보만 ──
    const sessionId = getUSSessionId();
    const isNewSession = !usSessionCache || usSessionCache.sessionDate !== sessionId;

    if (isNewSession) {
      usSessionCache = null;
      logger.info('🌏 새 세션 시작 — 전 종목 점수 스캔', { component: 'OVERSEAS' });
    }

    // 기존 세션이면 보유 + 캐시 상위만 조회 (API 비용 절감)
    let activeStocks = allActiveStocks;
    if (usSessionCache) {
      const heldCodes = new Set(holdings.keys());
      const targetCodes = new Set([...heldCodes, ...usSessionCache.topCodes]);
      activeStocks = allActiveStocks.filter(s => targetCodes.has(s.code));
      logger.info(
        `세션 캐시 사용 — ${activeStocks.length}종목 (보유:${heldCodes.size} + 후보:${usSessionCache.topCodes.length})`,
        { component: 'OVERSEAS' },
      );
    }

    logger.info(`${regionFlags} 해외주식 자동매매 시작 (${activeStocks.length}/${allActiveStocks.length}종목)`, { component: 'OVERSEAS' });

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
      const settled = await Promise.allSettled(
        batch.map(async (stock) => {
          const price = await getOverseasPrice(stock.code, stock.exchange);
          // 세션 캐시에 기술점수가 있고 보유종목이 아니면 차트 재호출 생략
          const cached = usSessionCache?.techCache.get(stock.code);
          const chart = cached ? null : await getOverseasDailyChart(stock.code, stock.exchange, 65);
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
          // 미국 종목이면 캐시 저장
          if (usSessionCache) {
            usSessionCache.techCache.set(stock.code, { score, rsi, adx, signal, trendStrength, isMomentum, dayRangePct });
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
      // score + 모멘텀 보너스로 정렬 → 상위 US_TOP_COUNT 캐시
      const sorted = [...techResults].sort((a, b) => {
        const sa = a.score + (a.isMomentum ? 30 : 0);
        const sb = b.score + (b.isMomentum ? 30 : 0);
        return sb - sa;
      });
      const topCodes = sorted.slice(0, US_TOP_COUNT).map(t => t.code);
      const techCacheMap = new Map<string, { score: number; rsi: number; adx: number; signal: string; trendStrength: string; isMomentum: boolean; dayRangePct: number }>();
      for (const t of techResults) {
        techCacheMap.set(t.code, { score: t.score, rsi: t.rsi, adx: t.adx, signal: t.signal, trendStrength: t.trendStrength, isMomentum: t.isMomentum, dayRangePct: t.dayRangePct });
      }
      usSessionCache = { topCodes, sessionDate: sessionId, techCache: techCacheMap };
      logger.info(`🌏 이번 세션 AI 매수 후보: [${topCodes.join(', ')}] (score 기준 상위 ${US_TOP_COUNT})`, { component: 'OVERSEAS' });
    }

    if (techResults.length === 0) {
      logger.warn('해외주식 분석 데이터 없음 (장 외?)', { component: 'OVERSEAS' });
      return;
    }

    // ── 1-b. 대시보드용 점수 캐시 갱신 ──
    const regionMap = new Map(GLOBAL_WATCHLIST.map(s => [s.code, s.region as 'US' | 'JP' | 'TW']));
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

    // US 세션 캐시 있을 때: 비보유 종목 중 상위 후보만 AI에 전달 (API 비용 절감)
    let aiInputs = allAiInputs;
    if (usSessionCache) {
      const topSet = new Set(usSessionCache.topCodes);
      aiInputs = allAiInputs.filter(s => heldSet.has(s.code) || topSet.has(s.code));
      if (aiInputs.length < allAiInputs.length) {
        logger.info(`🤖 AI 입력 최적화: ${allAiInputs.length} → ${aiInputs.length}종목 (세션 상위 후보만)`, { component: 'OVERSEAS' });
      }
    }

    const [perfSummary, userInsights] = await Promise.all([getRecentPerfSummary(), getUserInsights()]);
    const aiDecisions = await analyzeOverseasWithAI(aiInputs, cash, holdings.size, perfSummary, userInsights || undefined);

    // AI 결과를 코드 → 판단 맵으로 변환
    const aiMap = new Map(aiDecisions.map(d => [d.code, d]));

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

      // 1) 손절: -3% (하드 룰)
      if (pnlPct <= -3) {
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
      else if (ai?.action === 'SELL' && ai.confidence >= 0.60) {
        sellReason = `AI 매도(${(ai.confidence * 100).toFixed(0)}%): ${ai.reasoning}`;
      }
      // 5) AI 없을 때 fallback: +7% 이상이면 소프트 익절
      else if (!ai && pnlPct >= 7) {
        sellReason = `소프트 익절(AI없음): +${pnlPct.toFixed(1)}%`;
      }
      // 6) AI 없을 때 fallback: 기술적 강매도
      else if (!ai && tech.signal === 'STRONG_SELL' && tech.score < -30) {
        sellReason = `기술적 매도(AI없음): score=${tech.score}`;
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
        sellOrders.push(`매도 ${code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} (${sellReason})`);
      }
    }

    // ── 4. 리스크 관리: 포트폴리오 손실 한도 체크 ──
    const INITIAL_OVERSEAS_CASH = 10000; // $10,000 초기 자본
    // 현금만 보면 매수 후 항상 손실로 오인 → 보유종목 평가액 포함한 포트폴리오 기준으로 계산
    const holdingEvalUsd = Array.from(holdings.entries()).reduce((sum, [code, h]) => {
      const tech = techResults.find((t) => t.code === code);
      return sum + (tech ? tech.price.currentPrice * h.qty : h.avgPrice * h.qty);
    }, 0);
    const portfolioValue = cash + holdingEvalUsd;
    const dailyLossPct = ((portfolioValue - INITIAL_OVERSEAS_CASH) / INITIAL_OVERSEAS_CASH) * 100;
    const riskBlocked = dailyLossPct <= -8; // 8% 손실 시 당일 매수 중단
    if (riskBlocked) {
      logger.warn(`⛔ 리스크 한도 초과: 포트폴리오 $${portfolioValue.toFixed(0)} (${dailyLossPct.toFixed(1)}%) → 당일 신규 매수 차단`, { component: 'OVERSEAS' });
    }

    // ── 5. 매수 판단 ──
    const buyOrders: string[] = [];
    const updatedHoldings = await getHoldings();
    const currentHoldingCount = updatedHoldings.size;

    if (!riskBlocked && currentHoldingCount < MAX_POSITIONS && cash >= 200) {
      const buyTargets = techResults
        .filter(t => !updatedHoldings.has(t.code) && !pendingOrderStocks.has(t.code))
        .filter(t => {
          const ai = aiMap.get(t.code);
          // AI가 BUY라고 판단한 것만 신뢰 — 백엔드 재검증 없음
          if (ai?.action === 'BUY' && ai.confidence >= 0.55) return true;
          // AI 없을 때 fallback: 강한 기술 신호만
          if (!ai) return t.signal === 'STRONG_BUY' && t.adx >= 15;
          return false;
        })
        .map(t => ({ ...t, ai: aiMap.get(t.code) }))
        .sort((a, b) => (b.ai?.confidence ?? 0) - (a.ai?.confidence ?? 0));

      const slotsAvailable = MAX_POSITIONS - currentHoldingCount;
      for (const target of buyTargets.slice(0, slotsAvailable)) {
        const positionSize = Math.min(cash * POSITION_PCT, POSITION_SIZE_USD);
        if (positionSize < 50) break;

        const qty = Math.floor(positionSize / target.price.currentPrice);
        if (qty <= 0) continue;

        const buyMode = target.isMomentum ? '🚀모멘텀' : '📉반등';
        const reason = target.ai
          ? `${buyMode} AI(${(target.ai.confidence * 100).toFixed(0)}%): ${target.ai.reasoning}`
          : `${buyMode} 기술(AI없음): score=${target.score} RSI=${target.rsi.toFixed(0)} ADX=${target.adx.toFixed(0)}`;

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

        const cost = exec.filledQty * exec.filledPrice;
        await setHolding(target.code, target.exchange, exec.finalQty, exec.finalAvgPrice);
        cash -= cost;
        await setCash(cash);
        buyOrders.push(`매수 ${target.code} x${exec.filledQty} @$${exec.filledPrice.toFixed(2)} ${buyMode} (AI ${((target.ai?.confidence ?? 0) * 100).toFixed(0)}%)`);
      }
    }

    // ── 5. 결과 로그 ──
    const totalActions = buyOrders.length + sellOrders.length;
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

    const { sendPushNotification } = await import('../notifications/web-push.js');
    const emoji = side === 'BUY' ? '🟢' : '🔴';
    await sendPushNotification({
      title: `${emoji} 해외 ${side === 'BUY' ? '매수' : '매도'}: ${code}`,
      body: `${qty}주 × $${fillPrice.toFixed(2)}\n${reasoning}`,
      tag: `overseas-${side.toLowerCase()}`,
      url: '/',
    }).catch(() => {});
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
