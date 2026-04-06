import { analyzeTechnicals, type OHLCV } from '../analysis/indicators.js';
import { config } from '../config/index.js';
import { insertOrder, logSystem } from '../db/client.js';
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

// 미국 주식 감시 목록 (대형 기술주)
const US_WATCHLIST = [
  { code: 'AAPL', name: 'Apple', exchange: 'NASDAQ' },
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ' },
  { code: 'GOOGL', name: 'Google', exchange: 'NASDAQ' },
  { code: 'AMZN', name: 'Amazon', exchange: 'NASDAQ' },
  { code: 'TSLA', name: 'Tesla', exchange: 'NASDAQ' },
  { code: 'META', name: 'Meta', exchange: 'NASDAQ' },
];

// 보유 종목 추적 (인메모리 — 서버 재시작 시 초기화)
const overseasHoldings = new Map<string, { qty: number; avgPrice: number; boughtAt: string }>();

// 미국주식 가상 예수금 (Paper 모드)
let overseasCash = 10000; // $10,000

let isRunning = false;

/**
 * 미국 주식 자동매매 Job
 * KST 23:30~06:00 (미국 장중) 15분 간격 실행
 * 기술적 지표 기반 매매 판단 + 자동 주문 실행
 */
export async function runOverseasJob(): Promise<void> {
  if (isRunning) return;

  if (isKillSwitchActive()) {
    logger.warn('🛑 Kill Switch 활성 — 미국주식 스킵', { component: 'OVERSEAS' });
    return;
  }

  isRunning = true;

  try {
    logger.info('🇺🇸 미국주식 자동매매 시작', { component: 'OVERSEAS' });

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

    for (const stock of US_WATCHLIST) {
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
              code: stock.code,
              name: stock.name,
              exchange: stock.exchange,
              price,
              signal: tech.overallSignal,
              score: tech.score,
              rsi: tech.rsi14,
              adx: tech.adx14,
              trendStrength: tech.trendStrength,
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
      logger.warn('미국주식 분석 데이터 없음 (장 외 시간?)', { component: 'OVERSEAS' });
      return;
    }

    // 2. 보유 종목 매도 판단 (익절/손절)
    const sellOrders: string[] = [];
    for (const [code, holding] of overseasHoldings) {
      const data = analysis.find((a) => a.code === code);
      if (!data) continue;

      const pnlPct = ((data.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100;

      // 익절: +5%
      if (pnlPct >= 5) {
        await executeOverseasOrder(code, 'SELL', holding.qty, data.price.currentPrice, data.exchange, `익절: +${pnlPct.toFixed(1)}%`);
        overseasHoldings.delete(code);
        overseasCash += data.price.currentPrice * holding.qty;
        sellOrders.push(`매도 ${code} x${holding.qty} @$${data.price.currentPrice} (+${pnlPct.toFixed(1)}%)`);
      }
      // 손절: -3%
      else if (pnlPct <= -3) {
        await executeOverseasOrder(code, 'SELL', holding.qty, data.price.currentPrice, data.exchange, `손절: ${pnlPct.toFixed(1)}%`);
        overseasHoldings.delete(code);
        overseasCash += data.price.currentPrice * holding.qty;
        sellOrders.push(`매도 ${code} x${holding.qty} @$${data.price.currentPrice} (${pnlPct.toFixed(1)}%)`);
      }
      // 기술적 매도 시그널
      else if (data.signal === 'STRONG_SELL') {
        await executeOverseasOrder(code, 'SELL', holding.qty, data.price.currentPrice, data.exchange, `기술적 매도: score=${data.score}`);
        overseasHoldings.delete(code);
        overseasCash += data.price.currentPrice * holding.qty;
        sellOrders.push(`매도 ${code} x${holding.qty} @$${data.price.currentPrice} (기술적)`);
      }
    }

    // 3. 신규 매수 판단
    const buyOrders: string[] = [];
    const buySignals = analysis
      .filter((a) => (a.signal === 'STRONG_BUY' || a.signal === 'BUY') && !overseasHoldings.has(a.code) && a.trendStrength !== 'WEAK')
      .sort((a, b) => b.score - a.score);

    for (const signal of buySignals.slice(0, 2)) { // 한 번에 최대 2종목
      const positionSize = Math.min(overseasCash * 0.25, 2000); // 잔고 25% 이내, 최대 $2000
      if (positionSize < 50) break; // 최소 $50

      const qty = Math.floor(positionSize / signal.price.currentPrice);
      if (qty <= 0) continue;

      const cost = qty * signal.price.currentPrice;
      await executeOverseasOrder(signal.code, 'BUY', qty, signal.price.currentPrice, signal.exchange,
        `기술적 매수: score=${signal.score} RSI=${signal.rsi.toFixed(0)} ADX=${signal.adx.toFixed(0)}(${signal.trendStrength})`);

      overseasHoldings.set(signal.code, {
        qty,
        avgPrice: signal.price.currentPrice,
        boughtAt: new Date().toISOString(),
      });
      overseasCash -= cost;
      buyOrders.push(`매수 ${signal.code} x${qty} @$${signal.price.currentPrice.toFixed(2)} (score=${signal.score})`);
    }

    // 4. 결과 로그 + 알림
    const totalActions = buyOrders.length + sellOrders.length;
    const holdingList = Array.from(overseasHoldings.entries()).map(([code, h]) => {
      const data = analysis.find((a) => a.code === code);
      const pnl = data ? ((data.price.currentPrice - h.avgPrice) / h.avgPrice * 100).toFixed(1) : '?';
      return `${code} x${h.qty} @$${h.avgPrice.toFixed(2)} (${Number(pnl) >= 0 ? '+' : ''}${pnl}%)`;
    });

    const summary = [
      `🇺🇸 미국주식 자동매매 완료`,
      `분석: ${analysis.length}종목 | 실행: ${totalActions}건`,
      `잔고: $${overseasCash.toFixed(2)}`,
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
    logger.error(`미국주식 자동매매 실패: ${msg}`, { component: 'OVERSEAS' });
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
    // Paper 모드: 가상 체결
    const slippage = side === 'BUY' ? 0.001 : -0.001;
    const fillPrice = price * (1 + slippage);
    const fakeOrderNo = `USP${Date.now().toString(36)}`;

    await insertOrder({
      chain_id: null,
      stock_code: code,
      side,
      order_type: '01',
      quantity: qty,
      price: fillPrice,
      kis_order_no: fakeOrderNo,
      kis_status: 'PAPER_FILLED',
      filled_quantity: qty,
      filled_price: fillPrice,
      status: 'FILLED',
      trading_mode: 'paper',
      trigger_source: 'OVERSEAS',
      ai_reasoning: reasoning,
    });

    logger.info(`📝 [US_PAPER] ${side} ${code} x${qty} @$${fillPrice.toFixed(2)} (${fakeOrderNo})`, { component: 'OVERSEAS' });
  } else {
    // 실거래 주문
    try {
      const result = await placeOverseasOrder({ stockCode: code, exchange, side, quantity: qty, price });

      await insertOrder({
        chain_id: null,
        stock_code: code,
        side,
        order_type: '01',
        quantity: qty,
        price,
        kis_order_no: result.orderNo,
        kis_status: result.success ? 'SUBMITTED' : 'FAILED',
        filled_quantity: result.success ? qty : 0,
        filled_price: result.success ? price : null,
        status: result.success ? 'FILLED' : 'FAILED',
        trading_mode: 'live',
        trigger_source: 'OVERSEAS',
        ai_reasoning: reasoning,
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
