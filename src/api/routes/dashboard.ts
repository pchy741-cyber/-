import { Hono } from 'hono';
import { getPortfolioFlowStatus } from '../../automation/ceo-workflow.js';
import { getDefenseParkState } from '../../ai/track-b/defense-park.js';
import { getCachedScores, cachePrice, getLastKnownPrices } from '../../cache/redis.js';
import { cachePriceMemory, getLastKnownPricesMemory, getCachedPriceMemory } from '../../cache/memory.js';
import { config } from '../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, getPool, getTodayStartSnapshot } from '../../db/client.js';
import { getAccountBalance } from '../../kis/account.js';
import { getCurrentPrice, getBatchPrices, isMarketOpen } from '../../kis/market.js';
import { getWithdrawConfig, getWithdrawals, getTotalReserved } from '../../automation/profit-withdraw.js';
import { getKillSwitchStatus } from '../../risk/kill-switch.js';
import { getPaperBalance } from '../../risk/engine.js';
import { placeOrder } from '../../kis/order.js';
import { getDailyChart } from '../../kis/market.js';
import { analyzeTechnicals } from '../../analysis/indicators.js';
import { getInvestorFlow } from '../../automation/investor-flow.js';
import { fetchShortSellingData } from '../../automation/short-selling.js';
import { fetchAnalystConsensus } from '../../automation/analyst-consensus.js';
import { getMacroSnapshot } from '../../automation/macro-data.js';
import { logger } from '../../utils/logger.js';
import { getOverseasScores } from '../../cache/overseas-scores.js';
import { getAiStatus } from '../../cache/ai-status.js';

export const dashboardRoutes = new Hono();

// ── 환율 캐시 (1시간 TTL, 실패 시 1420 폴백) ──
let _fxCache = { rate: 1420, fetchedAt: 0 };

// ── 뉴스 요약 캐시 (2시간 TTL) ──
let _newsSummaryCache = { summary: '', fetchedAt: 0 };
const NEWS_SUMMARY_TTL = 120 * 60 * 1000; // 2시간 캐시 (AI 호출 절약)

// ── 오늘의 테마 캐시 (2시간 TTL) ──
interface NewsTheme { theme: string; reason: string; stocks: Array<{ code: string; name: string; market: string }> }
let _newsThemeCache: { data: NewsTheme | null; fetchedAt: number } = { data: null, fetchedAt: 0 };
const NEWS_THEME_TTL = 120 * 60 * 1000;
const GARBLED_NAME_REGEX = /[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$]/;
const KNOWN_GLOBAL_STOCK_NAMES: Record<string, string> = {
  AAPL: 'Apple',
  NVDA: 'NVIDIA',
  MSFT: 'Microsoft',
  GOOGL: 'Google',
  AMZN: 'Amazon',
  TSLA: 'Tesla',
  META: 'Meta',
  '7203': 'Toyota',
  '6758': 'Sony',
  '6861': 'Keyence',
  '2330': 'TSMC',
  '2317': 'Foxconn',
  '2454': 'MediaTek',
};
const KNOWN_KR_STOCK_NAMES: Record<string, string> = {
  '000100': '유한양행',
  '005290': '동진쎄미켐',
  '009540': 'HD한국조선해양',
  '010130': '고려아연',
  '012450': '한화에어로스페이스',
  '028300': 'HLB',
  '036490': 'SK머티리얼즈',
  '042700': '한미반도체',
  '058470': '리노공업',
  '068270': '셀트리온',
  '079550': 'LIG넥스원',
  '086520': '에코프로',
  '112040': '위메이드',
  '196170': '알테오젠',
  '207940': '삼성바이오로직스',
  '214150': '클래시스',
  '263750': '펄어비스',
  '267260': 'HD현대일렉트릭',
  '277810': '레인보우로보틱스',
  '328130': '루닛',
  '336260': '두산퓨얼셀',
  '336370': '솔루스첨단소재',
  '357780': '솔브레인',
  '403870': 'HPSP',
  '454910': '두산로보틱스',
};

function isInvalidStockName(name: unknown, stockCode?: string): boolean {
  const n = String(name ?? '').trim();
  if (!n) return true;
  if (stockCode && n === stockCode) return true;
  if (/^[0-9]{6}$/.test(n)) return true;
  return GARBLED_NAME_REGEX.test(n);
}

function getKnownStockName(code: string): string | undefined {
  return KNOWN_GLOBAL_STOCK_NAMES[code] ?? KNOWN_KR_STOCK_NAMES[code];
}

async function getFxRate(): Promise<number> {
  const now = Date.now();
  if (now - _fxCache.fetchedAt < 60 * 60 * 1000) return _fxCache.rate;
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4000) });
    const data = await resp.json() as any;
    const krw = data?.rates?.KRW;
    if (krw && krw > 1000 && krw < 2000) {
      _fxCache = { rate: Math.round(krw), fetchedAt: now };
    }
  } catch { /* 폴백 유지 */ }
  return _fxCache.rate;
}

// ── 대시보드 요약 ──
dashboardRoutes.get('/dashboard', async (c) => {
  // KIS API 실패 시에도 기본값으로 응답 (장 외 시간, API 제한 등)
  const defaultBalance = { totalDeposit: 10000000, totalEvalAmount: 0, orderableCash: 10000000, totalProfitLoss: 0, totalProfitLossPct: 0, positions: [] };

  const balanceFn = config.isPaper ? getPaperBalance : getAccountBalance;
  const [balanceResult, chains, strategy, insightRows, defensePark] = await Promise.all([
    balanceFn().catch(() => defaultBalance),
    getOpenChains().catch(() => []),
    getActiveStrategy().catch(() => null),
    getPool().query(
      `SELECT id, category, insight, confidence, sample_count, last_updated, is_manual,
              recommendation, param_change, is_applied, applied_at
       FROM learned_insights ORDER BY is_manual DESC, confidence DESC LIMIT 30`
    ).catch(() => ({ rows: [] as any[] })),
    getDefenseParkState().catch(() => ({ isActive: false, parkStockCode: '069500', parkStockName: 'KODEX 200', entryReason: null, enteredAt: null })),
  ]);
  const balance = balanceResult ?? defaultBalance;

  const watchlist = await getActiveWatchlist().catch(() => []);
  const stockCodes = watchlist.map((w) => w.stock_code);

  let scores: any[] = [];
  try {
    scores = await getCachedScores(stockCodes);
    if (scores.length === 0) {
      scores = await getLatestScores(stockCodes);
    }
  } catch { /* scores unavailable */ }

  // chains에 현재가 매칭 — KIS API 우선 (신선한 가격), 실패 시 캐시 폴백
  const posMap = new Map((balance.positions ?? []).map((p: any) => [p.stockCode, p]));
  const chainCodes = [...new Set(chains.map((ch: any) => ch.stock_code))];
  const priceMap = new Map<string, number>();

  // 1차: KIS 잔고 positions (실계좌 모드에서 정확)
  for (const code of chainCodes) {
    const pos = posMap.get(code);
    if (pos?.currentPrice > 0) priceMap.set(code, pos.currentPrice);
  }

  // 2차: KIS 시세 API — 장중에만 호출 (장 마감 후엔 캐시 사용으로 속도 보장)
  const nameMap = new Map<string, string>();
  const watchlistNameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const chainNameMap = new Map(chains.map((ch: any) => [ch.stock_code, ch.stock_name ?? '']));
  // 이름이 없는 종목은 장 마감 후에도 1회 조회 (이름 보정 목적) — watchlist + chains 모두 확인
  const needNameCodes = chainCodes.filter(c => {
    const n = String(watchlistNameMap.get(c) ?? '') || String(chainNameMap.get(c) ?? '');
    return !n || n === c || /^\d{6}$/.test(n);
  });
  const codesToFetch = isMarketOpen() ? chainCodes : needNameCodes;

  // 병렬 배치 조회 (순차 → 동시 → 속도 대폭 개선)
  if (codesToFetch.length > 0) {
    try {
      const batchResult = await getBatchPrices(codesToFetch);
      for (const [code, quote] of batchResult) {
        if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
        if (quote.stockName && quote.stockName !== code) nameMap.set(code, quote.stockName);
      }
    } catch {
      // 배치 실패 시 개별 순차 폴백
      for (const code of codesToFetch) {
        try {
          const quote = await getCurrentPrice(code);
          if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
          if (quote.stockName && quote.stockName !== code) nameMap.set(code, quote.stockName);
        } catch { /* skip */ }
      }
    }
  }

  // 종목명 백그라운드 보정: watchlist + transaction_chains 모두 코드명 → 실제명으로 업데이트
  for (const [code, name] of nameMap) {
    const wName = String(watchlistNameMap.get(code) ?? '');
    if (isInvalidStockName(wName, code)) {
      getPool().query('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [name, code]).catch(() => {});
    }
    const cName = String(chainNameMap.get(code) ?? '');
    if (isInvalidStockName(cName, code)) {
      getPool().query(
        "UPDATE transaction_chains SET stock_name = $1 WHERE stock_code = $2 AND (stock_name IS NULL OR stock_name = $2 OR stock_name ~ '^[0-9]{6}$' OR stock_name !~ '[A-Za-z가-힣]')",
        [name, code]
      ).catch(() => {});
    }
  }

  // 3차: API 실패 시 단기 캐시 폴백 (30초 TTL)
  for (const code of chainCodes) {
    if (!priceMap.has(code)) {
      const cached = getCachedPriceMemory(code);
      if (cached && cached > 0) priceMap.set(code, cached);
    }
  }

  // 4차: 마지막 수단 — 2시간 장기 캐시 (장 마감 후 등)
  const stillMissing = chainCodes.filter(code => !priceMap.has(code));
  if (stillMissing.length > 0) {
    const redisCached = await getLastKnownPrices(stillMissing).catch(() => new Map());
    redisCached.forEach((price, code) => priceMap.set(code, price));
    for (const code of stillMissing.filter(c => !priceMap.has(c))) {
      const last = getLastKnownPricesMemory([code]).get(code);
      if (last) priceMap.set(code, last);
    }
  }

  // 모든 가격 캐싱 (인메모리 + Redis)
  for (const [code, price] of priceMap) {
    cachePriceMemory(code, price);
    cachePrice(code, price).catch(() => {});
  }

  let totalChainInvested = 0;
  let totalChainPnl = 0;
  const enrichedChains = chains.map((ch: any) => {
    const currentPrice = priceMap.get(ch.stock_code) ?? 0;
    const avgPrice = Number(ch.avg_buy_price) || 0;
    const qty = Number(ch.total_quantity) || 0;
    const invested = avgPrice * qty;
    const unrealizedPnl = currentPrice > 0 ? (currentPrice - avgPrice) * qty : 0;
    const unrealizedPnlPct = currentPrice > 0 && avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
    totalChainInvested += invested;
    totalChainPnl += unrealizedPnl;
    // 종목명: KIS API > watchlist > chains DB > 코드 순으로 사용 (코드처럼 생긴 이름은 제외)
    const isCode = (n: any) => !n || String(n) === ch.stock_code || /^\d{6}$/.test(String(n));
    const known = getKnownStockName(ch.stock_code);
    const resolvedName = [nameMap.get(ch.stock_code), watchlistNameMap.get(ch.stock_code), ch.stock_name, known]
      .find(n => !isCode(n) && !isInvalidStockName(n, ch.stock_code)) ?? ch.stock_code;
    return { ...ch, stock_name: resolvedName, currentPrice, unrealizedPnl, unrealizedPnlPct, invested };
  });

  // 투자금/손익 계산 — 모드별 분기
  // Live: KIS 잔고가 source-of-truth (chains는 메타 정보)
  // Paper: KIS가 반영 안 하므로 chains 기반 계산
  const rawCash = balance.orderableCash ?? 10000000;

  let totalInvested: number;
  let totalPnl: number;
  let actualCash: number;

  if (config.isPaper) {
    // Paper: chains 기반 원금 (cap 없음), 손익 = 미실현+실현 합산
    totalInvested = totalChainInvested; // 현재 보유 원금 합산 (상한선 없음)
    totalPnl = totalChainPnl + (balance.totalProfitLoss ?? 0); // 미실현 + 실현
    actualCash = rawCash; // getPaperBalance: 초기자본 + 실현손익 - 보유원가
  } else {
    // Live: KIS 잔고가 source-of-truth
    totalInvested = balance.totalEvalAmount ?? 0; // 평가금액(원금+미실현손익 포함)
    totalPnl = balance.totalProfitLoss ?? 0;      // 미실현손익
    actualCash = rawCash;
  }

  // pnlPct: Live는 KIS API 직접값 사용(정확), Paper는 원금 대비 계산
  const totalPnlPct = config.isPaper
    ? (totalChainInvested > 0 ? (totalPnl / totalChainInvested) * 100 : 0)
    : (balance.totalProfitLossPct ?? 0); // KIS API가 내려주는 정확한 수익률

  // totalValue는 pnlPct 계산 전에 필요 없음 — grandTotalValue가 실제 반환값
  // (Paper: cash + 미실현평가금액(evalAmount) ≈ cash + 원금 + 미실현손익, Live: cash + evalAmount)

  // ── 해외 보유종목 (별도 표시용, 국내 총자산에 합산하지 않음) ──
  let overseasHoldings: Array<{ stock_code: string; quantity: number; avg_price: number; bought_at: string }> = [];
  let overseasTotalInvested = 0;
  let overseasCash = 0;
  try {
    const { rows: osRows } = await getPool().query('SELECT * FROM overseas_holdings WHERE quantity > 0');
    const { rows: osCashRows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'cash'");
    overseasCash = osCashRows.length > 0 ? Number(osCashRows[0].value) : 0;

    for (const r of osRows) {
      const qty = Number(r.quantity);
      const avgP = Number(r.avg_price);
      overseasTotalInvested += avgP * qty;
      overseasHoldings.push({
        stock_code: r.stock_code,
        quantity: qty,
        avg_price: avgP,
        bought_at: r.bought_at,
      });
    }
  } catch { /* overseas table may not exist */ }

  // ── 국내 + 해외 합산 ──
  const FX_RATE = await getFxRate(); // 실시간 환율 (1시간 캐시, 실패 시 1420 폴백)
  const overseasInvestedKrw = (isNaN(overseasTotalInvested) ? 0 : overseasTotalInvested) * FX_RATE;
  const overseasCashKrw = (isNaN(overseasCash) ? 0 : overseasCash) * FX_RATE;

  // domesticInvested: 화면 표시용 "현재 국내 투자금(원금)" — 손익 미포함
  // Paper: totalInvested = totalChainInvested (원금), Live: evalAmount(원금+미실현) 이지만 KIS 기준이 이것
  const domesticInvested = totalInvested || 0;

  // grandTotalValue: 국내(현금 + 평가금액) + 해외(투자원금 + 현금)
  // Paper: cash + evalAmount(=KIS paper posVal ≈ 원금+미실현) + 해외
  // Live:  cash + evalAmount(=KIS evalAmount) + 해외
  const grandTotalValue = (actualCash || 0) + domesticInvested + overseasInvestedKrw + overseasCashKrw;

  // grandTotalInvested: 투자 중인 원금 합산 (현금 제외)
  const grandTotalInvested = totalChainInvested + overseasInvestedKrw;

  return c.json({
    portfolio: {
      totalValue: Math.round(grandTotalValue),         // 국내 + 해외 합산 총자산
      cash: Math.round(actualCash),                    // 가용현금
      invested: Math.round(grandTotalInvested),        // 국내+해외 투자 원금
      domesticInvested: Math.round(totalChainInvested),// 국내 투자 원금
      domesticCash: Math.round(actualCash),
      // Live: KIS evlu_pfls_smtl_amt = 미실현손익 (source-of-truth), 실현손익은 잔고 API 미제공
      // Paper: chains 기반 미실현손익, balance.totalProfitLoss = 실현손익
      unrealizedPnl: Math.round(config.isPaper ? totalChainPnl : (balance.totalProfitLoss || totalChainPnl)),
      realizedPnl: config.isPaper ? Math.round(balance.totalProfitLoss ?? 0) : 0,
      pnl: Math.round(totalPnl),                       // 국내 미실현+실현 합산
      pnlPct: Math.round(totalPnlPct * 100) / 100,
      positions: balance.positions ?? [],
    },
    overseas: {
      holdings: overseasHoldings,
      totalInvestedUsd: overseasTotalInvested,
      totalInvestedKrw: overseasInvestedKrw,
      cashUsd: overseasCash,
      cashKrw: overseasCashKrw,
      fxRate: FX_RATE,
      scores: getOverseasScores(),
    },
    activeChains: enrichedChains.length,
    chains: enrichedChains,
    scores,
    strategy: strategy ?? { mode: 'SWING' },
    killSwitch: getKillSwitchStatus(),
    tradingMode: config.tradingMode,
    riskLimits: await (async () => {
      const snap = await getTodayStartSnapshot().catch(() => null);
      const startValue = snap ? Number(snap.total_value) : grandTotalValue;
      const maxDailyDrawdownKrw = Math.round(startValue * 0.3);
      return { maxDailyDrawdownKrw, startValue: Math.round(startValue) };
    })(),
    insights: insightRows.rows,
    defensePark,
  });
});

// ── 종목명 검색 (KRX 공개 API + DB) ──
dashboardRoutes.get('/search/stock', async (c) => {
  const q = String(c.req.query('q') ?? '').trim();
  if (q.length < 1) return c.json([]);

  // 6자리 숫자면 시세 API로 직접 조회
  if (/^\d{6}$/.test(q)) {
    try {
      const price = await getCurrentPrice(q);
      if (price.stockName) {
        const market = price.stockName ? 'KOSPI' : 'KOSPI';
        return c.json([{ code: q, name: price.stockName, market }]);
      }
    } catch { /* fallback */ }
    return c.json([{ code: q, name: q, market: 'KOSPI' }]);
  }

  const results: Array<{ code: string; name: string; market: string }> = [];

  // 1차: DB watchlist에서 부분 이름 검색
  try {
    const { rows } = await getPool().query(
      `SELECT stock_code, stock_name FROM watchlist WHERE stock_name ILIKE $1 LIMIT 5`,
      [`%${q}%`],
    );
    for (const r of rows) results.push({ code: r.stock_code, name: r.stock_name, market: 'KOSPI' });
  } catch { /* ignore */ }

  // 2차: NAVER 자동완성 API (이름 → 코드 매핑 — 검색어 필터 정확)
  if (results.length < 5) {
    try {
      const resp = await fetch(
        `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock,etf&lang=ko`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(4000),
        },
      );
      const data = await resp.json() as any;
      const items: any[] = data?.items?.[0] ?? [];
      for (const item of items) {
        const code = String(item[0] ?? '');
        const name = String(item[1] ?? '');
        const typeInfo = String(item[2] ?? '');
        if (code.length === 6 && name && !results.find(r => r.code === code)) {
          const market = typeInfo.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI';
          results.push({ code, name, market });
        }
      }
    } catch { /* NAVER API 실패 시 DB 결과만 반환 */ }
  }

  // 3차: KRX 전체 종목 리스트에서 이름 필터 (NAVER 실패 폴백)
  if (results.length === 0) {
    try {
      // 최근 거래일 계산 (오늘 or 가장 최근 평일)
      const d = new Date();
      const day = d.getUTCDay();
      if (day === 0) d.setUTCDate(d.getUTCDate() - 2);
      else if (day === 6) d.setUTCDate(d.getUTCDate() - 1);
      const trdDd = d.toISOString().split('T')[0].replace(/-/g, '');

      const resp = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': 'https://data.krx.co.kr/',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({
          bld: 'dbms/MDC/STAT/standard/MDCSTAT01501',
          mktId: 'ALL',
          trdDd,
          lang: 'ko',
          pageNo: '1',
          rowSize: '5000',
        }).toString(),
        signal: AbortSignal.timeout(6000),
      });
      const data = await resp.json() as any;
      const qLower = q.toLowerCase();
      if (Array.isArray(data.output)) {
        for (const item of data.output) {
          const code = String(item.ISU_SRT_CD ?? '');
          const name = String(item.ISU_ABBRV ?? item.ISU_KOR_ABBRV ?? '');
          const mkt = String(item.MKT_NM ?? 'KOSPI');
          if (code.length === 6 && name.toLowerCase().includes(qLower) && !results.find(r => r.code === code)) {
            results.push({ code, name, market: mkt.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI' });
            if (results.length >= 10) break;
          }
        }
      }
    } catch { /* KRX API 실패 */ }
  }

  return c.json(results.slice(0, 10));
});

// ── 감시 목록 CRUD ──
dashboardRoutes.get('/watchlist', async (c) => {
  try {
    const data = await getActiveWatchlist();
    const unresolvedDomestic = [...new Set(
      data
        .filter((w: any) => /^[0-9]{6}$/.test(String(w.stock_code)) && isInvalidStockName(w.stock_name, w.stock_code))
        .map((w: any) => String(w.stock_code))
    )];

    const nameMap = new Map<string, string>();
    // 해외/글로벌은 고정 매핑으로 즉시 보정
    for (const w of data) {
      const code = String(w.stock_code ?? '');
      const knownName = getKnownStockName(code);
      if (isInvalidStockName(w.stock_name, code) && knownName) {
        nameMap.set(code, knownName);
      }
    }

    // 국내 종목은 KIS 시세 API에서 종목명 보정
    if (unresolvedDomestic.length > 0) {
      const quotes = await getBatchPrices(unresolvedDomestic.slice(0, 30)).catch(() => new Map());
      for (const [code, q] of quotes) {
        if (!isInvalidStockName(q.stockName, code)) {
          nameMap.set(code, q.stockName.trim());
        }
      }
    }

    // 최근 매도 수익률 조회 (watchlist 카드에 ±% 표시용)
    const sellPctMap = new Map<string, { pct: number; closedAt: string }>();
    try {
      const codes = data.map((w: any) => String(w.stock_code));
      if (codes.length > 0) {
        const { rows: sellRows } = await getPool().query(`
          SELECT DISTINCT ON (tc.stock_code)
            tc.stock_code,
            tc.avg_buy_price,
            tc.closed_at,
            (SELECT o.filled_price FROM orders o
             WHERE o.chain_id = tc.id AND o.side = 'SELL'
             ORDER BY o.created_at DESC LIMIT 1) AS last_sell_price
          FROM transaction_chains tc
          WHERE tc.status = 'CLOSED'
            AND tc.stock_code = ANY($1)
          ORDER BY tc.stock_code, tc.closed_at DESC
        `, [codes]);
        for (const r of sellRows) {
          const buy = Number(r.avg_buy_price ?? 0);
          const sell = Number(r.last_sell_price ?? 0);
          if (buy > 0 && sell > 0) {
            sellPctMap.set(r.stock_code, {
              pct: ((sell - buy) / buy) * 100,
              closedAt: r.closed_at,
            });
          }
        }
      }
    } catch { /* skip — non-critical */ }

    const base = data.map((w: any) => {
      const code = String(w.stock_code ?? '');
      const resolved = nameMap.get(code);
      const sellInfo = sellPctMap.get(code);
      return {
        ...(resolved ? { ...w, stock_name: resolved } : w),
        ...(sellInfo ? { last_sell_pct: sellInfo.pct, last_sell_at: sellInfo.closedAt } : {}),
      };
    });

    // 다음 요청부터 즉시 일관되게 나오도록 DB도 보정
    if (nameMap.size > 0) {
      await Promise.allSettled(
        [...nameMap.entries()].map(([code, name]) =>
          getPool().query(
            `UPDATE watchlist
               SET stock_name = $1
             WHERE stock_code = $2
               AND is_active = true`,
            [name, code],
          )
        )
      );
    }

    return c.json(base);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'watchlist 조회 실패' }, 500);
  }
});

dashboardRoutes.post('/watchlist', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const stockCode = String(body.stock_code ?? '').trim().replace(/\D/g, '');
  let stockName = String(body.stock_name ?? '').trim();
  const marketRaw = String(body.market ?? 'KOSPI').trim().toUpperCase();
  const market = marketRaw === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';

  if (stockCode.length !== 6) {
    return c.json({ error: '종목코드는 숫자 6자리여야 합니다.' }, 400);
  }

  // 종목명이 비어 있으면 시세 API에서 자동 보완 시도
  if (!stockName) {
    try {
      const quote = await getCurrentPrice(stockCode);
      stockName = quote.stockName?.trim() || '';
    } catch {
      // no-op: fallback below
    }
  }
  if (!stockName) {
    stockName = stockCode;
  }

  try {
    await getPool().query(
      `INSERT INTO watchlist (stock_code, stock_name, market)
       VALUES ($1, $2, $3)
       ON CONFLICT (stock_code) DO UPDATE SET stock_name = $2, market = $3`,
      [stockCode, stockName, market],
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  // CEO 워크플로우: 종목 추가 시 자동 알림
  const { onStockAdded } = await import('../../automation/ceo-workflow.js');
  onStockAdded(stockCode, stockName).catch((err: unknown) => {
    logger.warn(`CEO 워크플로우 알림 실패 (onStockAdded): ${err}`, { component: 'WATCHLIST' });
  });

  return c.json({ ok: true, stock_code: stockCode, stock_name: stockName, market });
});

// 자금 흐름 상태 조회
dashboardRoutes.get('/flow', async (c) => {
  try {
    const status = await getPortfolioFlowStatus();
    return c.json(status);
  } catch {
    return c.json({
      totalPortfolio: 10000000, cash: 10000000, cashRatio: 100,
      investedRatio: 0, flowStatus: 'FLOWING', flowMessage: '대기 중',
      mode: 'SWING', activePositions: 0, pendingStocks: 0,
      allocation: [], pendingStockCodes: [],
    });
  }
});

dashboardRoutes.delete('/watchlist/:stockCode', async (c) => {
  const stockCode = c.req.param('stockCode');
  try {
    await getPool().query('UPDATE watchlist SET is_active = false WHERE stock_code = $1', [stockCode]);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  // CEO 워크플로우: 종목 제거 시 보유분 자동 청산
  const { onStockRemoved } = await import('../../automation/ceo-workflow.js');
  onStockRemoved(stockCode).catch(() => {});

  return c.json({ ok: true });
});

// ── KIS 실계좌 잔고 (국내+해외) ──
dashboardRoutes.get('/kis-balance', async (c) => {
  try {
    const [domestic, overseas] = await Promise.all([
      getAccountBalance().catch(() => null),
      import('../../kis/overseas.js').then((m) => m.getOverseasBalance()).catch(() => []),
    ]);
    return c.json({ domestic, overseas });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'KIS 잔고 조회 실패' }, 500);
  }
});

// ── KIS 관심종목 동기화 ──
dashboardRoutes.post('/watchlist/sync', async (c) => {
  try {
    const { syncInterestGroups, syncHoldingsToWatchlist } = await import('../../kis/interest-group.js');
    // 관심종목은 모의투자에서 미지원일 수 있음 → 실패해도 보유종목은 계속 진행
    const interest = await syncInterestGroups().catch(() => ({ added: [] as string[], total: 0 }));
    const holdings = await syncHoldingsToWatchlist().catch(() => ({ added: [] as string[] }));
    const allAdded = [...interest.added, ...holdings.added];
    return c.json({ ok: true, added: allAdded, kisTotal: interest.total, message: allAdded.length > 0 ? `${allAdded.length}종목 동기화 완료` : '이미 최신 상태 (모의투자는 관심종목 API 미지원)' });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'KIS 동기화 실패' }, 500);
  }
});

// ── 종목명 깨짐 일괄 보정 (watchlist + transaction_chains 미등록 종목 포함) ──
dashboardRoutes.post('/watchlist/fix-names', async (c) => {
  try {
    const { fixWatchlistNames } = await import('../../kis/interest-group.js');
    const result = await fixWatchlistNames();
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json({ error: err?.message }, 500);
  }
});

// ── 매매 기록 ──
dashboardRoutes.get('/trades', async (c) => {
  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 50)), 500);
  try {
    const { rows } = await getPool().query(
      `SELECT o.*,
         COALESCE(
           CASE
             WHEN w.stock_name IS NOT NULL
               AND w.stock_name != o.stock_code
               AND w.stock_name !~ '^[0-9]{6}$'
             THEN w.stock_name
             ELSE NULL
           END,
           o.stock_code
         ) AS stock_name,
         json_build_object(
           'stock_code', tc.stock_code,
           'status', tc.status,
           'strategy_mode', tc.strategy_mode,
           'avg_buy_price', tc.avg_buy_price
         ) AS transaction_chains
       FROM orders o
       LEFT JOIN transaction_chains tc ON o.chain_id = tc.id
       LEFT JOIN watchlist w ON o.stock_code = w.stock_code
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit],
    );
    const tradePnlMap = new Map<string, { pnl: number; pct: number | null }>();
    const domesticCodes = [...new Set(
      rows
        .map((r: any) => String(r.stock_code ?? ''))
        .filter((code: string) => /^[0-9]{6}$/.test(code))
    )];

    if (domesticCodes.length > 0) {
      const { rows: pnlRows } = await getPool().query(
        `SELECT id, stock_code, side, filled_quantity, filled_price
           FROM orders
          WHERE status = 'FILLED'
            AND stock_code = ANY($1::text[])
          ORDER BY created_at ASC, id ASC`,
        [domesticCodes],
      );

      const BUY_FEE_PCT = 0.00015;
      const SELL_FEE_PCT = 0.00245;
      const holdings = new Map<string, { qty: number; totalCost: number }>();

      for (const o of pnlRows as Array<any>) {
        const code = String(o.stock_code ?? '');
        const side = String(o.side ?? '');
        const qty = Math.max(0, Number(o.filled_quantity ?? 0));
        const price = Math.max(0, Number(o.filled_price ?? 0));
        if (!code || qty <= 0 || price <= 0) continue;

        const h = holdings.get(code) ?? { qty: 0, totalCost: 0 };
        if (side === 'BUY') {
          const buyValue = qty * price;
          const buyFee = Math.round(buyValue * BUY_FEE_PCT);
          h.qty += qty;
          h.totalCost += (buyValue + buyFee);
          holdings.set(code, h);
          continue;
        }

        if (side !== 'SELL' || h.qty <= 0) continue;
        const matchedQty = Math.min(qty, h.qty);
        if (matchedQty <= 0) continue;

        const avgCost = h.totalCost / h.qty;
        const costBasis = avgCost * matchedQty;
        const sellValue = matchedQty * price;
        const sellFee = Math.round(sellValue * SELL_FEE_PCT);
        const pnl = sellValue - sellFee - costBasis;
        const pct = costBasis > 0 ? (pnl / costBasis) * 100 : null;
        tradePnlMap.set(String(o.id), { pnl, pct });

        h.qty -= matchedQty;
        h.totalCost -= costBasis;
        if (h.qty <= 0) {
          h.qty = 0;
          h.totalCost = 0;
        }
        holdings.set(code, h);
      }
    }

    const rowsWithPnl = rows.map((r: any) => {
      const p = tradePnlMap.get(String(r.id ?? ''));
      return {
        ...r,
        realized_pnl: p?.pnl ?? null,
        realized_pnl_pct: p?.pct ?? null,
      };
    });

    const unresolvedDomestic = [...new Set(
      rowsWithPnl
        .filter((r: any) => /^[0-9]{6}$/.test(String(r.stock_code)) && isInvalidStockName(r.stock_name, r.stock_code))
        .map((r: any) => String(r.stock_code))
    )];
    const nameMap = new Map<string, string>();

    // 글로벌 티커 이름 보정
    for (const r of rowsWithPnl) {
      const code = String(r.stock_code ?? '');
      const knownName = getKnownStockName(code);
      if (isInvalidStockName(r.stock_name, code) && knownName) {
        nameMap.set(code, knownName);
      }
    }

    // 국내 코드는 KIS 조회로 보정
    if (unresolvedDomestic.length > 0) {
      const quotes = await getBatchPrices(unresolvedDomestic.slice(0, 30)).catch(() => new Map());
      for (const [code, q] of quotes) {
        if (!isInvalidStockName(q.stockName, code)) {
          nameMap.set(code, q.stockName.trim());
        }
      }
    }

    if (nameMap.size === 0) return c.json(rowsWithPnl);

    const patched = rowsWithPnl.map((r: any) => {
      const code = String(r.stock_code ?? '');
      const resolved = nameMap.get(code);
      return resolved ? { ...r, stock_name: resolved } : r;
    });

    // watchlist에 있는 코드면 이름 동기화
    await Promise.allSettled(
      [...nameMap.entries()].map(([code, name]) =>
        getPool().query(
          `UPDATE watchlist
             SET stock_name = $1
           WHERE stock_code = $2`,
          [name, code],
        )
      )
    );

    return c.json(patched);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 시장 참고 소스 ──
dashboardRoutes.get('/sources', async (c) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM market_sources ORDER BY is_pinned DESC, added_at DESC LIMIT 50');
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

dashboardRoutes.post('/sources', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = String(body.title ?? '').trim();
  const url = String(body.url ?? '').trim();
  const sourceType = String(body.source_type ?? 'article').trim();
  const memo = String(body.memo ?? '').trim() || null;

  if (!title || !url) return c.json({ error: '제목과 URL은 필수입니다.' }, 400);

  try {
    const { rows } = await getPool().query(
      `INSERT INTO market_sources (title, url, source_type, memo) VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, url, sourceType, memo],
    );
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dashboardRoutes.patch('/sources/:id/pin', async (c) => {
  const id = c.req.param('id');
  try {
    await getPool().query('UPDATE market_sources SET is_pinned = NOT is_pinned WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dashboardRoutes.delete('/sources/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await getPool().query('DELETE FROM market_sources WHERE id = $1', [id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 수익 인출 ──
dashboardRoutes.get('/withdraw/config', async (c) => {
  const config = await getWithdrawConfig();
  const reserved = await getTotalReserved();
  return c.json({ ...config, totalReserved: reserved });
});

dashboardRoutes.put('/withdraw/config', async (c) => {
  const body = await c.req.json();
  try {
    const { rows } = await getPool().query(
      `UPDATE profit_withdraw_config SET
         is_active = $1, target_profit_pct = $2, withdraw_ratio_pct = $3,
         min_withdraw_amount = $4, check_frequency = $5, updated_at = NOW()
       WHERE id = (SELECT id FROM profit_withdraw_config LIMIT 1)
       RETURNING *`,
      [
        body.is_active ?? false,
        body.target_profit_pct ?? 10,
        body.withdraw_ratio_pct ?? 50,
        body.min_withdraw_amount ?? 100000,
        body.check_frequency ?? 'daily',
      ],
    );
    return c.json(rows[0]);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dashboardRoutes.get('/withdraw/history', async (c) => {
  const history = await getWithdrawals();
  return c.json(history);
});

dashboardRoutes.patch('/withdraw/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const status = body.status;
  if (!['withdrawn', 'cancelled'].includes(status)) return c.json({ error: '유효한 상태: withdrawn, cancelled' }, 400);
  try {
    await getPool().query('UPDATE profit_withdrawals SET status = $1 WHERE id = $2', [status, id]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 탈출 모드 등록: +0.5% 돌파 순간 자동 전량 매도 ──
dashboardRoutes.post('/escape/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    const { rows } = await getPool().query('SELECT * FROM transaction_chains WHERE id = $1', [chainId]);
    const chain = rows[0];
    if (!chain) return c.json({ error: '체인을 찾을 수 없습니다' }, 404);
    if (chain.total_quantity <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    // 현재가 조회
    const { getCurrentPrice } = await import('../../kis/market.js');
    const priceData = await getCurrentPrice(chain.stock_code);
    const curPrice = priceData.currentPrice;
    if (!curPrice || curPrice <= 0) return c.json({ error: '현재가를 조회할 수 없습니다' }, 500);

    // 탈출 목표가 = 현재가 × 1.005 (원 단위 반올림)
    const escapeTarget = Math.ceil(curPrice * 1.005);
    await getPool().query(
      'UPDATE transaction_chains SET escape_target_price = $1 WHERE id = $2',
      [escapeTarget, chainId],
    );

    logger.info(
      `🚪 탈출 모드 등록: ${chain.stock_code} 목표가 ${escapeTarget.toLocaleString()}원 (현재 ${curPrice.toLocaleString()}원 → +0.5%)`,
      { component: 'ESCAPE' },
    );

    return c.json({ ok: true, escape_target_price: escapeTarget, current_price: curPrice });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 탈출 모드 취소 ──
dashboardRoutes.delete('/escape/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    await getPool().query('UPDATE transaction_chains SET escape_target_price = NULL WHERE id = $1', [chainId]);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 수동 매도 (CEO 긴급 매도) ──
dashboardRoutes.post('/sell/:chainId', async (c) => {
  const chainId = c.req.param('chainId');
  try {
    const { rows } = await getPool().query('SELECT * FROM transaction_chains WHERE id = $1', [chainId]);
    const chain = rows[0];
    if (!chain) return c.json({ error: '체인을 찾을 수 없습니다' }, 404);
    if (chain.total_quantity <= 0) return c.json({ error: '매도할 수량이 없습니다' }, 400);

    const result = await placeOrder({
      stockCode: chain.stock_code,
      side: 'SELL',
      quantity: chain.total_quantity,
    });

    // 체인 상태 업데이트
    await getPool().query(
      `UPDATE transaction_chains SET status = 'CLOSED', closed_at = NOW(), close_reason = 'CEO 수동 매도' WHERE id = $1`,
      [chainId],
    );

    // 주문 기록 (filled_quantity/filled_price 포함 — Paper 복원 로직이 이 필드를 읽음)
    const avgPrice = Number(chain.avg_buy_price) || 0;
    await getPool().query(
      `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
       VALUES ($1, $2, 'SELL', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', $6, 'MANUAL', 'CEO 수동 전량 매도')`,
      [chainId, chain.stock_code, chain.total_quantity, avgPrice, result.orderNo ?? '', config.tradingMode],
    );

    return c.json({ ok: true, orderNo: result.orderNo, message: `${chain.stock_code} ${chain.total_quantity}주 전량 매도 주문 완료` });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 종목 상세 분석 (기술적 지표 + 수급 + 공매도 + 목표가) ──
dashboardRoutes.get('/stock/:code/analysis', async (c) => {
  const stockCode = c.req.param('code');
  const defaultResult = { technicals: null, flow: null, shorts: null, consensus: null };

  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  try {
    const [chart, flow, shorts, consensus] = await Promise.allSettled([
      withTimeout(getDailyChart(stockCode, 65), 6000),
      withTimeout(getInvestorFlow(stockCode, 5).catch(() => null), 4000),
      withTimeout(fetchShortSellingData(stockCode, 5).catch(() => null), 4000),
      withTimeout(fetchAnalystConsensus(stockCode).catch(() => null), 4000),
    ]);

    let technicals = null;
    if (chart.status === 'fulfilled' && chart.value.length >= 20) {
      const candles = chart.value.map((c: any) => ({
        date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      technicals = analyzeTechnicals(candles);
    }

    return c.json({
      stockCode,
      technicals,
      flow: flow.status === 'fulfilled' ? flow.value : null,
      shorts: shorts.status === 'fulfilled' ? shorts.value : null,
      consensus: consensus.status === 'fulfilled' ? consensus.value : null,
    });
  } catch {
    return c.json({ stockCode, ...defaultResult });
  }
});

// ── 매크로 환경 ──
dashboardRoutes.get('/macro', async (c) => {
  try {
    const macro = await getMacroSnapshot();
    return c.json(macro);
  } catch {
    return c.json({ regime: 'NEUTRAL', fearGreedIndex: 50 });
  }
});

// ── 오늘 수집된 뉴스 피드 ──
dashboardRoutes.get('/news', async (c) => {
  try {
    const { getTodayNews } = await import('../../automation/news-collector.js');
    const newsMap = getTodayNews();
    const result: Array<{ stockCode: string; stockName?: string; items: Array<{ title: string; link: string; publishedAt?: string }> }> = [];
    for (const [stockCode, items] of newsMap.entries()) {
      if (items.length > 0) {
        result.push({ stockCode, items: items.slice(0, 10) });
      }
    }
    // 최신 뉴스가 많은 종목 순
    result.sort((a, b) => b.items.length - a.items.length);
    return c.json(result);
  } catch (err: any) {
    return c.json([], 200);
  }
});

// ── 매크로 뉴스 피드 ──
dashboardRoutes.get('/news/macro', async (c) => {
  try {
    const { collectMacroNews } = await import('../../automation/news-collector.js');
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 8000)),
    ]);
    const lines = raw.split('\n').filter(l => l.startsWith('- [')).map(l => l.replace(/^- /, ''));
    return c.json({ headlines: lines });
  } catch {
    return c.json({ headlines: [] });
  }
});

// ── 매크로 뉴스 AI 한 줄 요약 (Gemini 2.0 Flash — 무료 티어) ──
dashboardRoutes.get('/news/summary', async (c) => {
  try {
    // 30분 캐시 — 반복 호출 시 API 절약 + 타임아웃 방지
    if (_newsSummaryCache.summary && Date.now() - _newsSummaryCache.fetchedAt < NEWS_SUMMARY_TTL) {
      return c.json({ summary: _newsSummaryCache.summary });
    }

    const { collectMacroNews } = await import('../../automation/news-collector.js');
    // RSS 피드 최대 10s × 7개 allSettled + 여유 → 28s 타임아웃
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 28000)),
    ]);
    if (!raw) return c.json({ summary: '' });

    const geminiKey = config.ai.geminiKey || process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.startsWith('your_') || geminiKey.length < 10) return c.json({ summary: '' });

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash', generationConfig: { temperature: 0.2 } });

    const headlines = raw.split('\n').filter(l => l.startsWith('- [')).map(l => {
      const m = l.match(/^\- \[(.+?)\]\(.+?\)\s*—\s*(.+)$/);
      return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
    }).join('\n');

    const res = await model.generateContent(
      `아래는 오늘 글로벌 금융 뉴스 헤드라인입니다. 주식 투자에 영향을 미치는 핵심 내용만 뽑아서 한국어로 자연스럽게 2~3문장으로 요약해 주세요. 투자자 관점에서 오늘 시장 분위기와 주요 이슈를 간결하게 서술하세요.\n\n${headlines}`,
    );

    const summary = res.response.text() ?? '';
    // 캐시 업데이트
    if (summary) _newsSummaryCache = { summary, fetchedAt: Date.now() };
    return c.json({ summary });
  } catch (err) {
    logger.error('뉴스 요약 생성 실패', { error: String(err), component: 'NEWS_SUMMARY' });
    return c.json({ summary: '' });
  }
});

// ── 오늘의 테마 + 추천 종목 (Gemini 2.0 Flash — 무료 티어) ──
dashboardRoutes.get('/news/theme', async (c) => {
  try {
    if (_newsThemeCache.data && Date.now() - _newsThemeCache.fetchedAt < NEWS_THEME_TTL) {
      return c.json(_newsThemeCache.data);
    }

    const { collectMacroNews } = await import('../../automation/news-collector.js');
    const raw = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 20000)),
    ]);
    if (!raw) return c.json({ theme: '', reason: '', stocks: [] });

    const geminiKey = config.ai.geminiKey || process.env.GEMINI_API_KEY;
    if (!geminiKey || geminiKey.startsWith('your_') || geminiKey.length < 10) {
      return c.json({ theme: '', reason: '', stocks: [] });
    }

    const headlines = raw.split('\n').filter(l => l.startsWith('- [')).map(l => {
      const m = l.match(/^\- \[(.+?)\]\(.+?\)\s*—\s*(.+)$/);
      return m ? `${m[1]} (${m[2]})` : l.replace(/^- /, '');
    }).slice(0, 20).join('\n');

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    });

    const prompt = `아래 글로벌 금융 뉴스 헤드라인을 분석해서 오늘 한국 주식시장에서 가장 주목받을 테마/섹터를 1개 선정하고, 관련 한국 상장주 3~5개를 추천하세요.

헤드라인:
${headlines}

반드시 아래 JSON 형식으로만 응답하세요:
{
  "theme": "테마명 (예: AI 반도체, 방산, 2차전지, 바이오 등)",
  "reason": "한 문장으로 이 테마를 선택한 이유 (투자자 관점)",
  "stocks": [
    {"code": "005930", "name": "삼성전자", "market": "KOSPI"},
    {"code": "000660", "name": "SK하이닉스", "market": "KOSPI"}
  ]
}

주의: code는 반드시 실제 한국거래소 6자리 종목코드, market은 KOSPI 또는 KOSDAQ`;

    const res = await model.generateContent(prompt);
    const text = res.response.text() ?? '';

    let data: NewsTheme;
    try {
      data = JSON.parse(text) as NewsTheme;
      if (!data.theme || !Array.isArray(data.stocks)) throw new Error('invalid');
    } catch {
      return c.json({ theme: '', reason: '', stocks: [] });
    }

    _newsThemeCache = { data, fetchedAt: Date.now() };
    return c.json(data);
  } catch (err) {
    logger.error('오늘의 테마 생성 실패', { error: String(err), component: 'NEWS_THEME' });
    return c.json({ theme: '', reason: '', stocks: [] });
  }
});

// ── 매매 상태 진단 (왜 매수 안 하는지) ──
dashboardRoutes.get('/trading-status', async (c) => {
  try {
    const [killSwitch, defensePark, strategy, scores, watchlist, recentLossCodes] = await Promise.all([
      Promise.resolve(getKillSwitchStatus()),
      getDefenseParkState().catch(() => ({ isActive: false, entryReason: null })),
      getActiveStrategy().catch(() => null),
      (async () => {
        const wl = await getActiveWatchlist().catch(() => []);
        const codes = wl.map((w: any) => w.stock_code);
        const s = await getCachedScores(codes).catch(() => []);
        return s.length > 0 ? s : await getLatestScores(codes).catch(() => []);
      })(),
      getActiveWatchlist().catch(() => []),
      (async () => {
        const { getRecentLossStocks } = await import('../../db/client.js');
        return getRecentLossStocks(7).catch(() => new Set<string>());
      })(),
    ]);

    const mode = (strategy?.mode ?? 'SWING') as string;
    const buyThreshold = strategy?.buy_threshold ?? (mode === 'DEFENSE' ? 85 : 65);
    const marketOpen = isMarketOpen();

    const blocks: { reason: string; detail: string; severity: 'warn' | 'info' | 'ok' }[] = [];

    // 1. Kill switch
    if (killSwitch.active) {
      blocks.push({ reason: '긴급정지 (Kill Switch)', detail: killSwitch.reason ?? '수동 발동', severity: 'warn' });
    }

    // 2. 방어 파킹
    if (defensePark.isActive) {
      blocks.push({ reason: '방어 파킹 중', detail: defensePark.entryReason ?? '하락세 감지 → 현금 ETF 보호', severity: 'warn' });
    }

    // 3. 장 마감
    if (!marketOpen) {
      blocks.push({ reason: '장 마감', detail: '09:00~15:30 외 시간 — 매수 불가', severity: 'info' });
    }

    // 4. DEFENSE 모드
    if (mode === 'DEFENSE') {
      blocks.push({ reason: 'DEFENSE 모드', detail: `AI 점수 ${buyThreshold}점 이상만 진입 — 기준 매우 높음`, severity: 'warn' });
    }

    // 5. AI 점수 후보 없음
    const candidates = scores.filter((s: any) => (s.composite_score ?? 0) >= buyThreshold && (s.confidence ?? 1) >= 0.6);
    const topScore = scores.length > 0 ? Math.max(...scores.map((s: any) => s.composite_score ?? 0)) : 0;
    if (scores.length === 0) {
      blocks.push({ reason: 'AI 스코어 없음', detail: 'Track A 미실행 or 캐시 만료 — 기술적 지표 fallback 사용 중', severity: 'info' });
    } else if (candidates.length === 0) {
      blocks.push({ reason: `매수 후보 없음 (최고 ${topScore}점)`, detail: `현재 임계치 ${buyThreshold}점 — 모든 감시 종목 점수 미달`, severity: 'warn' });
    }

    // 6. 손실 밴 종목
    if (recentLossCodes.size > 0) {
      const watchCodes = new Set(watchlist.map((w: any) => w.stock_code));
      const bannedInWatch = [...recentLossCodes].filter((c) => watchCodes.has(c));
      if (bannedInWatch.length > 0) {
        blocks.push({ reason: `손실 밴 ${bannedInWatch.length}종목`, detail: `7일 내 손절 ${bannedInWatch.length}종목 재진입 금지: ${bannedInWatch.slice(0, 3).join(', ')}`, severity: 'info' });
      }
    }

    // 7. 감시목록 부족
    if (watchlist.length < 3) {
      blocks.push({ reason: '감시목록 부족', detail: `현재 ${watchlist.length}종목 — 3종목 이상 권장`, severity: 'warn' });
    }

    // 전반적 상태
    const hasHardBlock = blocks.some(b => b.severity === 'warn' && (
      b.reason.includes('긴급정지') || b.reason.includes('방어 파킹') || b.reason.includes('후보 없음') || b.reason.includes('DEFENSE')
    ));
    const overallStatus: 'ACTIVE' | 'WATCHING' | 'BLOCKED' = killSwitch.active || defensePark.isActive
      ? 'BLOCKED'
      : hasHardBlock
        ? 'WATCHING'
        : 'ACTIVE';

    return c.json({
      overallStatus,   // ACTIVE=정상매매 | WATCHING=관망중 | BLOCKED=완전차단
      mode,
      buyThreshold,
      marketOpen,
      topScore,
      candidateCount: candidates.length,
      watchlistCount: watchlist.length,
      lossBlockedCount: recentLossCodes.size,
      blocks,
    });
  } catch (err) {
    return c.json({ overallStatus: 'UNKNOWN', blocks: [], error: String(err) });
  }
});

// ── 시스템 로그 ──
dashboardRoutes.get('/ai-status', (c) => {
  return c.json(getAiStatus());
});

dashboardRoutes.get('/logs', async (c) => {
  const limit = Number(c.req.query('limit') ?? 100);
  const component = c.req.query('component');

  try {
    let sql = 'SELECT * FROM system_log';
    const params: any[] = [];

    if (component) {
      sql += ' WHERE component = $1';
      params.push(component);
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await getPool().query(sql, params);
    return c.json(rows);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
