import { KIS_TR_ID, MARKET } from '../config/constants.js';
import { isTradingDay, setApiHolidayCache } from '../utils/holidays.js';
import { logger } from '../utils/logger.js';
import { kisRequest, marketDataRateLimiter } from './client.js';

/** NaN 방지 유틸: Number(undefined) → NaN이 비교 연산에서 예측 불가하므로 fallback으로 대체 */
const safeNum = (v: string | undefined | null, fallback = 0): number => {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ── 현재가 조회 ──
export interface CurrentPrice {
  stockCode: string;
  stockName: string;
  currentPrice: number;
  changePrice: number;
  changePct: number;
  volume: number;
  tradingValueEok: number; // 누적거래대금 (억원, acml_tr_pbmn) — KIS 공식값
  highPrice: number;
  lowPrice: number;
  openPrice: number;
  prevClosePrice: number;
  dividendYield: number; // 배당수익률 (%, dvr 필드)
  per: number; // PER
  marketCapEok: number; // 시가총액 (억원, hts_avls)
  // 상폐리스크 필드
  haltYn: string; // 거래정지 여부 (Y: 정지)
  mangIssuClsCode: string; // 관리종목구분코드 (0: 정상, 1+: 관리)
  mrktWarnClsCode: string; // 시장경보구분코드 (00: 정상, 01: 주의, 02+: 경고)
  invtCafulYn: string; // 투자주의환기종목여부 (Y: 해당)
}

export async function getCurrentPrice(stockCode: string): Promise<CurrentPrice> {
  await marketDataRateLimiter.acquire();
  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/quotations/inquire-price',
    trId: KIS_TR_ID.QUOTE.CURRENT_PRICE,
    useRealUrl: true,
    skipRateLimiter: true,
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
    },
  });

  const o = (res.output ?? {}) as Record<string, string>;

  return {
    stockCode,
    stockName: o.hts_kor_isnm ?? '',
    currentPrice: safeNum(o.stck_prpr),
    changePrice: safeNum(o.prdy_vrss),
    changePct: safeNum(o.prdy_ctrt),
    volume: safeNum(o.acml_vol),
    tradingValueEok: safeNum(o.acml_tr_pbmn) / 100_000_000,
    highPrice: safeNum(o.stck_hgpr),
    lowPrice: safeNum(o.stck_lwpr),
    openPrice: safeNum(o.stck_oprc),
    prevClosePrice: safeNum(o.stck_sdpr),
    dividendYield: safeNum(o.dvr),
    per: safeNum(o.per),
    marketCapEok: safeNum(o.hts_avls),
    haltYn: String(o.halt_yn ?? ''),
    mangIssuClsCode: String(o.mang_issu_cls_code ?? '0'),
    mrktWarnClsCode: String(o.mrkt_warn_cls_code ?? '00'),
    invtCafulYn: String(o.invt_caful_yn ?? ''),
  };
}

/** 상폐리스크 여부 판단 — true이면 AI 스코어링 대상에서 제외 */
export function isDelistingRisk(p: CurrentPrice): boolean {
  if (p.haltYn === 'Y') return true; // 거래정지
  // KIS API: mang_issu_cls_code → 'N'=정상, '0'=정상(구버전), 그 외=관리종목
  if (p.mangIssuClsCode !== '' && p.mangIssuClsCode !== '0' && p.mangIssuClsCode !== 'N') return true;
  if (Number(p.mrktWarnClsCode) >= 2) return true; // 경고 이상 (02: 경고, 03: 위험예고, 04: 위험)
  return false;
}

// ── 일봉 차트 (60일) ──
export interface DailyCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingValueEok: number; // 누적거래대금 (억원, acml_tr_pbmn) — KIS 공식값
}

// ── getDailyChart 인메모리 캐시 (일봉은 장중 변하지 않음) ──
const _dailyChartCache = new Map<string, { data: DailyCandle[]; expiresAt: number }>();
/** 캐시 최대 항목 수 (초과 시 전체 클리어) */
const DAILY_CHART_CACHE_MAX = 300;
/** 장중(09:00~15:30) 캐시 TTL — 당일 봉 미확정 */
const DAILY_CHART_TTL_MARKET_HOURS_MS = 5 * 60 * 1000; // 5분
/** 장후 캐시 TTL — 일봉 확정 */
const DAILY_CHART_TTL_AFTER_HOURS_MS = 24 * 60 * 60 * 1000; // 24시간
/** 캐시 정리 주기 */
const DAILY_CHART_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10분

// 만료 엔트리 자동 정리 — 무제한 성장 방지
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _dailyChartCache) {
    if (now >= entry.expiresAt) _dailyChartCache.delete(key);
  }
  if (_dailyChartCache.size > DAILY_CHART_CACHE_MAX) _dailyChartCache.clear();
}, DAILY_CHART_CACHE_CLEANUP_INTERVAL_MS).unref();

function getDailyChartCacheTtlMs(): number {
  const kst = getKSTNow();
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const timeNum = h * 100 + m;
  if (timeNum >= 900 && timeNum <= 1530) return DAILY_CHART_TTL_MARKET_HOURS_MS;
  return DAILY_CHART_TTL_AFTER_HOURS_MS;
}

export async function getDailyChart(stockCode: string, days: number = 60): Promise<DailyCandle[]> {
  // 캐시 체크
  const cacheKey = `${stockCode}:${days}`;
  const cached = _dailyChartCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  try {
    const kstNow = getKSTNow();
    const endDate = kstNow.toISOString().split('T')[0].replace(/-/g, '');
    const startDate = new Date(kstNow.getTime() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0].replace(/-/g, '');

    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
      trId: KIS_TR_ID.QUOTE.DAILY_CHART,
      useRealUrl: true,
      skipRateLimiter: true,
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
    const items = (res.output2 ?? res.output ?? []) as unknown as Record<string, string>[];
    if (!Array.isArray(items)) {
      // API 응답 이상 → stale 캐시 fallback
      if (cached?.data?.length) {
        logger.warn(`📊 일봉 API 응답 이상 → stale 캐시 서빙: ${stockCode}`, { component: 'KIS' });
        return cached.data;
      }
      return [];
    }

    // DESC 정렬 보장 (최신 [0]) — analyzeTechnicals() 계약: closes[0] = 현재가
    const result = items
      .map((c) => ({
        date: c.stck_bsop_date ?? '',
        open: safeNum(c.stck_oprc),
        high: safeNum(c.stck_hgpr),
        low: safeNum(c.stck_lwpr),
        close: safeNum(c.stck_clpr),
        volume: safeNum(c.acml_vol),
        tradingValueEok: safeNum(c.acml_tr_pbmn) / 100_000_000,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    // 캐시 저장
    if (result.length > 0) {
      _dailyChartCache.set(cacheKey, { data: result, expiresAt: Date.now() + getDailyChartCacheTtlMs() });
    }

    return result;
  } catch (err) {
    // KIS API 실패 → 만료된 캐시라도 서빙 (빈 차트보다 stale 차트가 나음)
    if (cached?.data?.length) {
      logger.warn(`📊 일봉 API 실패 → stale 캐시 서빙: ${stockCode} (${err instanceof Error ? err.message : String(err)})`, { component: 'KIS' });
      return cached.data;
    }
    logger.warn(`📊 일봉 조회 실패 (캐시 없음): ${stockCode} - ${err instanceof Error ? err.message : String(err)}`, { component: 'KIS' });
    return [];
  }
}

// ── 분봉 차트 ──
export interface MinuteCandle {
  time: string; // HHmmss
  date: string; // YYYYMMDD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getMinuteChart(stockCode: string): Promise<MinuteCandle[]> {
  const kst = getKSTNow();
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  const ss = String(kst.getUTCSeconds()).padStart(2, '0');
  await marketDataRateLimiter.acquire();
  const res = await kisRequest({
    path: '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
    trId: KIS_TR_ID.QUOTE.MINUTE_CHART,
    useRealUrl: true,
    skipRateLimiter: true,
    params: {
      FID_ETC_CLS_CODE: '',
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
      FID_INPUT_HOUR_1: `${hh}${mm}${ss}`,
      FID_PW_DATA_INCU_YN: 'Y',
    },
  });
  const items = (res.output2 ?? []) as unknown as Record<string, string>[];
  if (!Array.isArray(items)) return [];
  return items
    .filter((c) => c.stck_cntg_hour && safeNum(c.stck_prpr ?? c.stck_clpr) > 0)
    .map((c) => ({
      time: c.stck_cntg_hour ?? '',
      date: c.stck_bsop_date ?? '',
      open: safeNum(c.stck_oprc),
      high: safeNum(c.stck_hgpr),
      low: safeNum(c.stck_lwpr),
      close: safeNum(c.stck_prpr ?? c.stck_clpr),
      volume: safeNum(c.cntg_vol),
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

  const o = res.output as Record<string, string> | undefined;
  if (!o) return [];
  const entries: OrderbookEntry[] = [];

  for (let i = 1; i <= 10; i++) {
    entries.push({
      askPrice: safeNum(o[`askp${i}`]),
      askVolume: safeNum(o[`askp_rsqn${i}`]),
      bidPrice: safeNum(o[`bidp${i}`]),
      bidVolume: safeNum(o[`bidp_rsqn${i}`]),
    });
  }

  return entries;
}

// ── KST 시간 유틸 (re-export from utils/time.ts — 순환 의존 방지) ──
import { getKSTNow } from '../utils/time.js';

export { getKSTNow };

// ── 장 열림 여부 확인 (공휴일 포함) ──
export function isMarketOpen(): boolean {
  const kst = getKSTNow();
  const day = kst.getUTCDay(); // UTC기준이지만 +9h 보정했으므로 KST 요일

  // 주말 체크
  if (day === 0 || day === 6) {
    logger.debug(`장 닫힘: 주말 (day=${day})`, { component: 'MARKET' });
    return false;
  }

  // 한국 공휴일 체크
  if (!isTradingDay(kst)) return false;

  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const timeNum = hour * 100 + minute;

  const openTime = MARKET.OPEN_HOUR * 100 + MARKET.OPEN_MINUTE; // 900
  const closeTime = MARKET.CLOSE_HOUR * 100 + MARKET.CLOSE_MINUTE; // 1530

  const open = timeNum >= openTime && timeNum <= closeTime;
  logger.debug(
    `장 상태: ${open ? '열림' : '닫힘'} (KST ${hour}:${String(minute).padStart(2, '0')}, timeNum=${timeNum})`,
    { component: 'MARKET' },
  );
  return open;
}

// ── 복수 종목 현재가 일괄 조회 ──
// kisRateLimiter가 각 kisRequest 내부에서 12/sec 큐 관리 → 병렬 발사해도 안전
export async function getBatchPrices(stockCodes: string[]): Promise<Map<string, CurrentPrice>> {
  const results = new Map<string, CurrentPrice>();
  const settled = await Promise.allSettled(stockCodes.map((code) => getCurrentPrice(code)));
  for (let i = 0; i < stockCodes.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      results.set(r.value.stockCode, r.value);
    } else {
      logger.warn(`시세 조회 실패: ${stockCodes[i]} - ${r.reason}`, { component: 'KIS' });
    }
  }
  return results;
}

// ── 거래량 상위 종목 조회 (시장 발굴용) ──
export interface RankingStock {
  stock_code: string;
  stock_name: string;
}

export async function getVolumeRankingStocks(market: 'J' | 'Q' = 'J', limit = 30): Promise<RankingStock[]> {
  try {
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/volume-rank',
      trId: 'FHPST01710000',
      useRealUrl: true,
      params: {
        FID_COND_MRKT_DIV_CODE: market,
        FID_COND_SCR_DIV_CODE: '20171',
        FID_INPUT_ISCD: '0001',
        FID_DIV_CLS_CODE: '0',
        FID_BLNG_CLS_CODE: '0',
        FID_TRGT_CLS_CODE: '111111111',
        FID_TRGT_EXLS_CLS_CODE: '000000',
        FID_INPUT_PRICE_1: '',
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '',
        FID_INPUT_DATE_1: '',
      },
    });
    const output = (res.output as Record<string, string>[]) ?? [];
    return output
      .slice(0, limit)
      .map((o) => ({ stock_code: o.stck_shrn_iscd ?? '', stock_name: o.hts_kor_isnm ?? '' }))
      .filter((s) => s.stock_code && !s.stock_code.startsWith('1')); // ETF 제외
  } catch (err) {
    logger.warn(`거래량 상위 조회 실패: ${err}`, { component: 'KIS' });
    return [];
  }
}

// ── 등락률 상위 종목 조회 (급등주 발굴) ──
export async function getChangeRankingStocks(limit = 20, market: 'J' | 'Q' = 'J'): Promise<RankingStock[]> {
  try {
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/ranking/fluctuation',
      trId: 'FHPST01700000',
      useRealUrl: true,
      params: {
        FID_COND_MRKT_DIV_CODE: market,
        FID_COND_SCR_DIV_CODE: '20170',
        FID_INPUT_ISCD: '0001',
        FID_RANK_SORT_CLS_CODE: '0',
        FID_INPUT_CNT_1: '0',
        FID_PRC_CLS_CODE: '1',
        FID_INPUT_PRICE_1: '',
        FID_INPUT_PRICE_2: '',
        FID_VOL_CNT: '100000',
        FID_TRGT_CLS_CODE: '0',
        FID_TRGT_EXLS_CLS_CODE: '0',
        FID_DIV_CLS_CODE: '0',
        FID_RSFL_RATE1: '',
        FID_RSFL_RATE2: '',
      },
    });
    const output = (res.output as Record<string, string>[]) ?? [];
    return output
      .slice(0, limit)
      .map((o) => ({ stock_code: o.stck_shrn_iscd ?? '', stock_name: o.hts_kor_isnm ?? '' }))
      .filter((s) => s.stock_code && !s.stock_code.startsWith('1'));
  } catch (err) {
    logger.warn(`등락률 상위 조회 실패: ${err}`, { component: 'KIS' });
    return [];
  }
}

// ── 종목별 투자자 수급 (기관/외국인/개인) ──
export interface InvestorFlow {
  stockCode: string;
  /** 기관 순매수량 (양수=순매수, 음수=순매도) */
  institutionNet: number;
  /** 외국인 순매수량 */
  foreignNet: number;
  /** 개인 순매수량 */
  individualNet: number;
  /** 외국인 보유 비율 (%) */
  foreignHoldingPct: number;
}

/**
 * 종목별 당일 투자자별 매매동향 조회 (FHKST01010900)
 * Track A 스코어링용 — 실제 기관/외국인 수급 데이터를 AI에 주입
 */
export async function getInvestorFlow(stockCode: string): Promise<InvestorFlow | null> {
  try {
    await marketDataRateLimiter.acquire();
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-investor',
      trId: KIS_TR_ID.QUOTE.INVESTOR_FLOW,
      useRealUrl: true,
      skipRateLimiter: true,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
      },
    });

    const o = res.output as Record<string, string> | undefined;
    if (!o) return null;
    return {
      stockCode,
      institutionNet: safeNum(o.orgn_ntby_qty),
      foreignNet: safeNum(o.frgn_ntby_qty),
      individualNet: safeNum(o.prsn_ntby_qty),
      foreignHoldingPct: safeNum(o.frgn_hldn_qty_rt),
    };
  } catch {
    return null;
  }
}

/**
 * 복수 종목 수급 일괄 조회 (배치 처리, 오류 무시)
 */
/** 수급 일괄 조회 시 동시 요청 수 (rate limit 준수) */
const INVESTOR_FLOW_BATCH_SIZE = 5;

export async function getBatchInvestorFlow(stockCodes: string[]): Promise<Map<string, InvestorFlow>> {
  const result = new Map<string, InvestorFlow>();
  const BATCH = INVESTOR_FLOW_BATCH_SIZE;
  for (let i = 0; i < stockCodes.length; i += BATCH) {
    const slice = stockCodes.slice(i, i + BATCH);
    const flows = await Promise.allSettled(slice.map((c) => getInvestorFlow(c)));
    for (const f of flows) {
      if (f.status === 'fulfilled' && f.value) {
        result.set(f.value.stockCode, f.value);
      }
    }
  }
  return result;
}

// ── KIS API 기반 연간 휴장일 캐시 갱신 ──────────────────────────────────
/**
 * KIS FHKSE030000 (국내 휴장일 조회)로 당해 연도 전체 휴장일을 받아
 * holidays.ts API 캐시에 주입한다.
 * 부팅 시 1회 + 자정 이후 매일 1회 호출.
 */
export async function refreshMarketHolidayCache(): Promise<void> {
  const kstYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).split('-')[0]);
  const closureDates = new Set<string>();

  // 상반기(0101) + 하반기(0701) 2회 조회 → 연간 전체 커버
  const baseDates = [`${kstYear}0101`, `${kstYear}0701`];
  for (const bassDate of baseDates) {
    try {
      const res = await kisRequest<Array<Record<string, string>>>({
        path: '/uapi/domestic-stock/v1/quotations/chk-holiday',
        trId: 'FHKSE030000',
        useRealUrl: true,
        skipRateLimiter: true,
        params: { BASS_DT: bassDate },
      });
      const items: Array<Record<string, string>> = Array.isArray(res.output) ? res.output : [];
      for (const item of items) {
        const dt = item.bass_dt ?? item.BASS_DT ?? '';
        if (!dt?.startsWith(String(kstYear))) continue;
        // opnd_yn='N': 개장 안함 = 시장 휴장일 (주말·공휴일 모두 포함)
        if ((item.opnd_yn ?? item.OPND_YN) === 'N') {
          closureDates.add(`${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`);
        }
      }
    } catch (e: unknown) {
      logger.warn(`KIS 휴장일 조회 실패 (${bassDate}): ${e instanceof Error ? e.message : String(e)}`, { component: 'MARKET' });
    }
  }

  if (closureDates.size >= 10) {
    setApiHolidayCache(kstYear, closureDates);
    logger.info(`✅ KIS 휴장일 API 캐시 ${closureDates.size}건 (${kstYear}년)`, { component: 'MARKET' });
  } else {
    logger.warn(`⚠️ KIS 휴장일 응답 부족 (${closureDates.size}건) — 하드코딩 목록 사용`, { component: 'MARKET' });
  }
}
