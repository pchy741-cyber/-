import { KIS_TR_ID, MARKET } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { isTradingDay } from '../utils/holidays.js';
import { kisRequest } from './client.js';

// ── 현재가 조회 ──
export interface CurrentPrice {
  stockCode: string;
  stockName: string;
  currentPrice: number;
  changePrice: number;
  changePct: number;
  volume: number;
  highPrice: number;
  lowPrice: number;
  openPrice: number;
  prevClosePrice: number;
}

export async function getCurrentPrice(stockCode: string): Promise<CurrentPrice> {
  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/quotations/inquire-price',
    trId: KIS_TR_ID.QUOTE.CURRENT_PRICE,
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
    },
  });

  const o = res.output as Record<string, string>;

  return {
    stockCode,
    stockName: o.hts_kor_isnm ?? '',
    currentPrice: Number(o.stck_prpr),
    changePrice: Number(o.prdy_vrss),
    changePct: Number(o.prdy_ctrt),
    volume: Number(o.acml_vol),
    highPrice: Number(o.stck_hgpr),
    lowPrice: Number(o.stck_lwpr),
    openPrice: Number(o.stck_oprc),
    prevClosePrice: Number(o.stck_sdpr),
  };
}

// ── 일봉 차트 (60일) ──
export interface DailyCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getDailyChart(stockCode: string, days: number = 60): Promise<DailyCandle[]> {
  const endDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0].replace(/-/g, '');

  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
    trId: KIS_TR_ID.QUOTE.DAILY_CHART,
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
      FID_INPUT_DATE_1: startDate,
      FID_INPUT_DATE_2: endDate,
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0',
    },
  });

  // KIS API는 output 또는 output2로 반환 (API 버전에 따라 다름)
  const items = ((res.output2 ?? res.output ?? []) as unknown as Record<string, string>[]);
  if (!Array.isArray(items)) return [];

  return items.map((c) => ({
    date: c.stck_bsop_date,
    open: Number(c.stck_oprc),
    high: Number(c.stck_hgpr),
    low: Number(c.stck_lwpr),
    close: Number(c.stck_clpr),
    volume: Number(c.acml_vol),
  }));
}

// ── 호가 (Orderbook) ──
export interface OrderbookEntry {
  askPrice: number;
  askVolume: number;
  bidPrice: number;
  bidVolume: number;
}

export async function getOrderbook(stockCode: string): Promise<OrderbookEntry[]> {
  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
    trId: KIS_TR_ID.QUOTE.ORDERBOOK,
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
    },
  });

  const o = res.output as Record<string, string>;
  const entries: OrderbookEntry[] = [];

  for (let i = 1; i <= 10; i++) {
    entries.push({
      askPrice: Number(o[`askp${i}`] ?? 0),
      askVolume: Number(o[`askp_rsqn${i}`] ?? 0),
      bidPrice: Number(o[`bidp${i}`] ?? 0),
      bidVolume: Number(o[`bidp_rsqn${i}`] ?? 0),
    });
  }

  return entries;
}

// ── 장 열림 여부 확인 (공휴일 포함) ──
export function isMarketOpen(): boolean {
  // KST 시간 정확 추출 (toLocaleString → new Date 변환 버그 방지)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET.TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map(p => [p.type, p.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');

  // 주말 체크
  if (day === 0 || day === 6) return false;

  // 한국 공휴일 체크
  if (!isTradingDay(new Date())) return false;

  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const timeNum = hour * 100 + minute;

  const openTime = MARKET.OPEN_HOUR * 100 + MARKET.OPEN_MINUTE; // 900
  const closeTime = MARKET.CLOSE_HOUR * 100 + MARKET.CLOSE_MINUTE; // 1530

  return timeNum >= openTime && timeNum <= closeTime;
}

// ── 복수 종목 현재가 일괄 조회 ──
export async function getBatchPrices(stockCodes: string[]): Promise<Map<string, CurrentPrice>> {
  const results = new Map<string, CurrentPrice>();

  // kisRateLimiter가 글로벌 rate limit 관리 → 여기서는 순차 호출만
  for (let i = 0; i < stockCodes.length; i++) {
    try {
      const price = await getCurrentPrice(stockCodes[i]);
      results.set(price.stockCode, price);
    } catch (err) {
      logger.warn(`시세 조회 실패: ${stockCodes[i]} - ${err}`, { component: 'KIS' });
    }
  }

  return results;
}
