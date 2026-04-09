import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { config } from '../config/index.js';
import { getPool, insertOrder, logSystem } from '../db/client.js';
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

// ── DB 기반 보유종목 관리 (서버 재시작해도 유지) ──
async function ensureOverseasTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS overseas_holdings (
      stock_code TEXT PRIMARY KEY,
      exchange TEXT NOT NULL DEFAULT 'NASDAQ',
      quantity NUMERIC NOT NULL DEFAULT 0,
      avg_price NUMERIC NOT NULL DEFAULT 0,
      bought_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS overseas_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

async function getHoldings(): Promise<Map<string, { qty: number; avgPrice: number; boughtAt: string }>> {
  const map = new Map();
  try {
    const { rows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
    for (const r of rows) {
      map.set(r.stock_code, { qty: Number(r.quantity), avgPrice: Number(r.avg_price), boughtAt: r.bought_at });
    }
  } catch { /* table might not exist yet */ }
  return map;
}

async function setHolding(code: string, qty: number, avgPrice: number): Promise<void> {
  if (qty <= 0) {
    await getPool().query('DELETE FROM overseas_holdings WHERE stock_code = $1', [code]);
  } else {
    await getPool().query(
      `INSERT INTO overseas_holdings (stock_code, quantity, avg_price, bought_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (stock_code) DO UPDATE SET quantity = $2, avg_price = $3`,
      [code, qty, avgPrice],
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
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ('cash', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [amount.toString()],
  );
}

let isRunning = false;

/**
 * 현재 KST 시간 기준으로 열려있는 시장의 region 반환
 */
function getActiveRegions(): string[] {
  // UTC+9 고정 변환 (toLocaleString 파싱 버그 방지)
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const t = h * 60 + m;
  const day = kst.getUTCDay(); // 0=Sun, 6=Sat

  const regions: string[] = [];

  // 🇺🇸 미국: KST 23:30~06:30 (월~금 밤 → 화~토 새벽)
  // 23시대: 월~금(day 1-5), 새벽: 화~토(day 2-6)
  const isUSNight = t >= 23 * 60 + 30 && day >= 1 && day <= 5;
  const isUSDawn = t <= 6 * 60 + 30 && day >= 2 && day <= 6;
  if (isUSNight || isUSDawn) regions.push('US');

  // 🇯🇵 일본: KST 09:00~11:30, 12:30~15:00 (평일만)
  if (day >= 1 && day <= 5) {
    if ((t >= 9 * 60 && t <= 11 * 60 + 30) || (t >= 12 * 60 + 30 && t <= 15 * 60)) regions.push('JP');
  }

  // 🇹🇼 대만: KST 10:00~14:30 (평일만)
  if (day >= 1 && day <= 5) {
    if (t >= 10 * 60 && t <= 14 * 60 + 30) regions.push('TW');
  }

  logger.info(`🌏 시장 체크: KST ${h}:${String(m).padStart(2, '0')} (day=${day}) → [${regions.join(',')}]`, { component: 'OVERSEAS' });

  return regions;
}

/**
 * 글로벌 주식 자동매매 Job
 * 각 시장 장중에만 해당 지역 종목 분석 + 매매
 * 기술적 지표 기반 매매 판단 + 자동 주문 실행
 */
export async function runOverseasJob(): Promise<void> {
  if (isRunning) return;

  if (isKillSwitchActive()) {
    logger.warn('🛑 Kill Switch 활성 — 해외주식 스킵', { component: 'OVERSEAS' });
    return;
  }

  isRunning = true;

  try {
    const activeRegions = getActiveRegions();
    if (activeRegions.length === 0) {
      logger.info('🌏 열린 해외 시장 없음 → 스킵', { component: 'OVERSEAS' });
      return;
    }

    const activeStocks = GLOBAL_WATCHLIST.filter(s => activeRegions.includes(s.region));
    const regionFlags = activeRegions.map(r => r === 'US' ? '🇺🇸' : r === 'JP' ? '🇯🇵' : '🇹🇼').join('');
    logger.info(`${regionFlags} 해외주식 자동매매 시작 (${activeStocks.length}종목)`, { component: 'OVERSEAS' });

    await ensureOverseasTable();

    const holdings = await getHoldings();
    let cash = await getCash();

    // 1. 시세 + 차트 수집 + 기술적 분석
    const analysis: Array<{
      code: string;
      name: string;
      exchange: string;
      price: OverseasPrice;
      signal: string;
      score: number;
      rsi: number;
      adx: number;
      trendStrength: string;
    }> = [];

    for (const stock of activeStocks) {
      try {
        const price = await getOverseasPrice(stock.code, stock.exchange);
        const chart = await getOverseasDailyChart(stock.code, stock.exchange, 65);

        if (chart.length >= 30 && price.currentPrice > 0) {
          const candles: OHLCV[] = chart.map((c) => ({
            date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          }));
          const tech = analyzeTechnicals(candles);
          if (tech) {
            analysis.push({
              code: stock.code, name: stock.name, exchange: stock.exchange,
              price, signal: tech.overallSignal, score: tech.score,
              rsi: tech.rsi14, adx: tech.adx14, trendStrength: tech.trendStrength,
            });
            logger.info(`  ${stock.code}: $${price.currentPrice} ${price.changePct > 0 ? '+' : ''}${price.changePct}% → ${tech.overallSignal}(${tech.score}) RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)}`, {
              component: 'OVERSEAS',
            });
          }
        }
      } catch (e) {
        logger.warn(`  ${stock.code} 실패: ${(e as Error).message}`, { component: 'OVERSEAS' });
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (analysis.length === 0) {
      logger.warn('해외주식 분석 데이터 없음 (장 외 시간?)', { component: 'OVERSEAS' });
      return;
    }

    // 2. 보유 종목 매도 판단 (익절/손절)
    const sellOrders: string[] = [];
    for (const [code, holding] of holdings) {
      const data = analysis.find((a) => a.code === code);
      if (!data) continue;

      const pnlPct = ((data.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100;

      let sellReason = '';
      if (pnlPct >= 5) sellReason = `익절: +${pnlPct.toFixed(1)}%`;
      else if (pnlPct <= -3) sellReason = `손절: ${pnlPct.toFixed(1)}%`;
      else if (data.signal === 'STRONG_SELL') sellReason = `기술적 매도: score=${data.score}`;

      if (sellReason) {
        await executeOverseasOrder(code, 'SELL', holding.qty, data.price.currentPrice, data.exchange, sellReason);
        await setHolding(code, 0, 0);
        cash += data.price.currentPrice * holding.qty;
        await setCash(cash);
        sellOrders.push(`매도 ${code} x${holding.qty} @$${data.price.currentPrice} (${sellReason})`);
      }
    }

    // 3. 신규 매수 판단
    const buyOrders: string[] = [];
    const currentHoldings = await getHoldings(); // 매도 후 갱신
    const buySignals = analysis
      .filter((a) => (a.signal === 'STRONG_BUY' || a.signal === 'BUY') && !currentHoldings.has(a.code) && a.trendStrength !== 'WEAK')
      .sort((a, b) => b.score - a.score);

    for (const signal of buySignals.slice(0, 2)) {
      // R:R 체크: 익절(5%) / 손절(3%) = 1.67 → OK
      // ADX < 15 → 추세 없음, 스킵
      if (signal.adx < 15) {
        logger.info(`  ${signal.code} 스킵: ADX=${signal.adx.toFixed(0)} (추세 없음)`, { component: 'OVERSEAS' });
        continue;
      }

      const positionSize = Math.min(cash * 0.25, 2000);
      if (positionSize < 50) break;

      const qty = Math.floor(positionSize / signal.price.currentPrice);
      if (qty <= 0) continue;

      const cost = qty * signal.price.currentPrice;
      await executeOverseasOrder(signal.code, 'BUY', qty, signal.price.currentPrice, signal.exchange,
        `기술적 매수: score=${signal.score} RSI=${signal.rsi.toFixed(0)} ADX=${signal.adx.toFixed(0)}(${signal.trendStrength})`);

      await setHolding(signal.code, qty, signal.price.currentPrice);
      cash -= cost;
      await setCash(cash);
      buyOrders.push(`매수 ${signal.code} x${qty} @$${signal.price.currentPrice.toFixed(2)} (score=${signal.score})`);
    }

    // 4. 결과 로그
    const totalActions = buyOrders.length + sellOrders.length;
    const updatedHoldings = await getHoldings();
    const holdingList = Array.from(updatedHoldings.entries()).map(([code, h]) => {
      const data = analysis.find((a) => a.code === code);
      const pnl = data ? ((data.price.currentPrice - h.avgPrice) / h.avgPrice * 100).toFixed(1) : '?';
      return `${code} x${h.qty} @$${h.avgPrice.toFixed(2)} (${Number(pnl) >= 0 ? '+' : ''}${pnl}%)`;
    });

    const summary = [
      `${regionFlags} 해외주식 자동매매 완료`,
      `분석: ${analysis.length}종목 | 실행: ${totalActions}건`,
      `잔고: $${cash.toFixed(2)}`,
      ...buyOrders.map((o) => `🟢 ${o}`),
      ...sellOrders.map((o) => `🔴 ${o}`),
      holdingList.length > 0 ? `\n보유: ${holdingList.join(', ')}` : '',
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
): Promise<void> {
  if (config.isPaper) {
    const slippage = side === 'BUY' ? 0.001 : -0.001;
    const fillPrice = price * (1 + slippage);
    const fakeOrderNo = `USP${Date.now().toString(36)}`;

    await insertOrder({
      chain_id: null, stock_code: code, side, order_type: '01',
      quantity: qty, price: fillPrice, kis_order_no: fakeOrderNo,
      kis_status: 'PAPER_FILLED', filled_quantity: qty, filled_price: fillPrice,
      status: 'FILLED', trading_mode: 'paper', trigger_source: 'OVERSEAS',
      ai_reasoning: reasoning,
    });

    logger.info(`📝 [US_PAPER] ${side} ${code} x${qty} @$${fillPrice.toFixed(2)} (${fakeOrderNo})`, { component: 'OVERSEAS' });

    // PWA 푸시 알림
    const { sendPushNotification } = await import('../notifications/web-push.js');
    const emoji = side === 'BUY' ? '🟢' : '🔴';
    await sendPushNotification({
      title: `${emoji} 해외 ${side === 'BUY' ? '매수' : '매도'}: ${code}`,
      body: `${qty}주 × $${fillPrice.toFixed(2)}\n${reasoning}`,
      tag: `overseas-${side.toLowerCase()}`,
      url: '/',
    }).catch(() => {});
  } else {
    try {
      const result = await placeOverseasOrder({ stockCode: code, exchange, side, quantity: qty, price });
      await insertOrder({
        chain_id: null, stock_code: code, side, order_type: '01',
        quantity: qty, price, kis_order_no: result.orderNo,
        kis_status: result.success ? 'SUBMITTED' : 'FAILED',
        filled_quantity: result.success ? qty : 0, filled_price: result.success ? price : null,
        status: result.success ? 'FILLED' : 'FAILED', trading_mode: 'live',
        trigger_source: 'OVERSEAS', ai_reasoning: reasoning,
      });
      if (result.success) {
        logger.info(`🇺🇸 [LIVE] ${side} ${code} x${qty} @$${price.toFixed(2)}`, { component: 'OVERSEAS' });
      } else {
        logger.error(`🇺🇸 주문 실패: ${code} - ${result.message}`, { component: 'OVERSEAS' });
      }
    } catch (e) {
      logger.error(`🇺🇸 주문 에러: ${code} - ${(e as Error).message}`, { component: 'OVERSEAS' });
    }
  }
}
