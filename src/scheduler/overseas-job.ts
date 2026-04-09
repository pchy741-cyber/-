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
import { analyzeOverseasWithAI, type OverseasStockInput } from '../ai/overseas/analyzer.js';

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
const MAX_POSITIONS = 5;           // 최대 동시 보유 종목
const POSITION_SIZE_USD = 1500;    // 종목당 최대 투자금 (기존 $2,000 → $1,500, 5개 분산)
const POSITION_PCT = 0.20;         // 또는 가용 현금의 20%

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
  // cap 제거 — 수익 누적 허용 (기존: 초기자본으로 강제 제한 → 수익 소멸 버그)
  const safe = Math.max(0, amount);
  await getPool().query(
    `INSERT INTO overseas_state (key, value) VALUES ('cash', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [safe.toString()],
  );
}

let isRunning = false;

/**
 * 현재 KST 시간 기준으로 열려있는 시장의 region 반환
 */
function getActiveRegions(): string[] {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const t = h * 60 + m;
  const day = kst.getUTCDay(); // 0=Sun, 6=Sat

  const regions: string[] = [];

  // 🇺🇸 미국: KST 23:30~06:30
  const isUSNight = t >= 23 * 60 + 30 && day >= 1 && day <= 5;
  const isUSDawn = t <= 6 * 60 + 30 && day >= 2 && day <= 6;
  if (isUSNight || isUSDawn) regions.push('US');

  // 🇯🇵 일본: KST 09:00~11:30, 12:30~15:00 (평일)
  if (day >= 1 && day <= 5) {
    if ((t >= 9 * 60 && t <= 11 * 60 + 30) || (t >= 12 * 60 + 30 && t <= 15 * 60)) regions.push('JP');
  }

  // 🇹🇼 대만: KST 10:00~14:30 (평일)
  if (day >= 1 && day <= 5) {
    if (t >= 10 * 60 && t <= 14 * 60 + 30) regions.push('TW');
  }

  logger.info(`🌏 시장 체크: KST ${h}:${String(m).padStart(2, '0')} (day=${day}) → [${regions.join(',')}]`, { component: 'OVERSEAS' });
  return regions;
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

    // ── 1. 시세 + 차트 병렬 수집 (배치 5개씩, rate limit 준수) ──
    const techResults: Array<{
      code: string; name: string; exchange: string;
      price: OverseasPrice; signal: string; score: number;
      rsi: number; adx: number; trendStrength: string;
    }> = [];

    // 배치 처리: 5개씩 병렬 → rate limit 안전
    const BATCH = 5;
    for (let i = 0; i < activeStocks.length; i += BATCH) {
      const batch = activeStocks.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map(async (stock) => {
          const price = await getOverseasPrice(stock.code, stock.exchange);
          const chart = await getOverseasDailyChart(stock.code, stock.exchange, 65);
          return { stock, price, chart };
        })
      );

      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const { stock, price, chart } = result.value;
        if (chart.length < 30 || price.currentPrice <= 0) continue;

        const candles: OHLCV[] = chart.map(c => ({
          date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        }));
        const tech = analyzeTechnicals(candles);
        if (!tech) continue;

        techResults.push({
          code: stock.code, name: stock.name, exchange: stock.exchange,
          price, signal: tech.overallSignal, score: tech.score,
          rsi: tech.rsi14, adx: tech.adx14, trendStrength: tech.trendStrength,
        });
        logger.info(
          `  ${stock.code}: $${price.currentPrice} ${price.changePct >= 0 ? '+' : ''}${price.changePct}% | ${tech.overallSignal}(${tech.score}) RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)}`,
          { component: 'OVERSEAS' },
        );
      }

      // 배치 간 300ms 간격 (rate limit)
      if (i + BATCH < activeStocks.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (techResults.length === 0) {
      logger.warn('해외주식 분석 데이터 없음 (장 외?)', { component: 'OVERSEAS' });
      return;
    }

    // ── 2. AI(Claude) 판단 ──
    const aiInputs: OverseasStockInput[] = techResults.map(t => {
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
      };
    });

    const aiDecisions = await analyzeOverseasWithAI(aiInputs, cash, holdings.size);

    // AI 결과를 코드 → 판단 맵으로 변환
    const aiMap = new Map(aiDecisions.map(d => [d.code, d]));

    // ── 3. 매도 판단 ──
    const sellOrders: string[] = [];
    for (const [code, holding] of holdings) {
      const tech = techResults.find(t => t.code === code);
      if (!tech) continue;

      const pnlPct = ((tech.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100;
      const ai = aiMap.get(code);

      let sellReason = '';
      // 익절 / 손절 (하드 룰 — AI 무시)
      if (pnlPct >= 5) sellReason = `익절: +${pnlPct.toFixed(1)}%`;
      else if (pnlPct <= -3) sellReason = `손절: ${pnlPct.toFixed(1)}%`;
      // AI가 SELL 판단 + 신뢰도 60% 이상
      else if (ai?.action === 'SELL' && ai.confidence >= 0.6) sellReason = `AI 매도: ${ai.reasoning}`;
      // 기술적 강매도 (AI 없을 때 fallback)
      else if (!ai && tech.signal === 'STRONG_SELL') sellReason = `기술적 매도: score=${tech.score}`;

      if (sellReason) {
        await executeOverseasOrder(code, 'SELL', holding.qty, tech.price.currentPrice, tech.exchange, sellReason);
        await setHolding(code, 0, 0);
        // 수수료 0.25% 차감 (해외주식 매도: 브로커 수수료 + 거래세 합산)
        const proceeds = tech.price.currentPrice * holding.qty * (1 - 0.0025);
        cash += proceeds;
        await setCash(cash);
        sellOrders.push(`매도 ${code} x${holding.qty} @$${tech.price.currentPrice} (${sellReason})`);
      }
    }

    // ── 4. 매수 판단 ──
    const buyOrders: string[] = [];
    const updatedHoldings = await getHoldings();
    const currentHoldingCount = updatedHoldings.size;

    if (currentHoldingCount < MAX_POSITIONS && cash >= 200) {
      // AI BUY 신호 우선, 없으면 기술적 BUY fallback
      const buyTargets = techResults
        .filter(t => !updatedHoldings.has(t.code))
        .map(t => {
          const ai = aiMap.get(t.code);
          const aiScore = ai?.action === 'BUY' ? ai.confidence * 100 : 0;
          const techScore = (t.signal === 'STRONG_BUY' ? 80 : t.signal === 'BUY' ? 60 : 0)
            + (t.adx >= 20 ? 20 : t.adx >= 15 ? 10 : 0);
          return { ...t, ai, combinedScore: aiScore + techScore };
        })
        .filter(t => {
          const ai = aiMap.get(t.code);
          // AI가 있으면 BUY + 신뢰도 55% 이상
          if (ai) return ai.action === 'BUY' && ai.confidence >= 0.55 && t.adx >= 12;
          // AI 없으면 기술적 fallback (기존보다 완화)
          return (t.signal === 'STRONG_BUY' || t.signal === 'BUY')
            && t.trendStrength !== 'WEAK'
            && t.adx >= 12;
        })
        .sort((a, b) => b.combinedScore - a.combinedScore);

      const slotsAvailable = MAX_POSITIONS - currentHoldingCount;
      for (const target of buyTargets.slice(0, slotsAvailable)) {
        const positionSize = Math.min(cash * POSITION_PCT, POSITION_SIZE_USD);
        if (positionSize < 50) break;

        const qty = Math.floor(positionSize / target.price.currentPrice);
        if (qty <= 0) continue;

        const cost = qty * target.price.currentPrice;
        const reason = target.ai
          ? `AI 매수(${(target.ai.confidence * 100).toFixed(0)}%): ${target.ai.reasoning}`
          : `기술적 매수: score=${target.score} RSI=${target.rsi.toFixed(0)} ADX=${target.adx.toFixed(0)}`;

        await executeOverseasOrder(target.code, 'BUY', qty, target.price.currentPrice, target.exchange, reason);
        await setHolding(target.code, qty, target.price.currentPrice);
        cash -= cost;
        await setCash(cash);
        buyOrders.push(`매수 ${target.code} x${qty} @$${target.price.currentPrice.toFixed(2)} (score=${target.combinedScore.toFixed(0)})`);
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
