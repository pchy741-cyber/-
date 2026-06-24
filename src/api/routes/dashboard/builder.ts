/**
 * 대시보드 페이로드 빌더 — buildDashPayload + getOrBuildDashPayload
 */

import { getDefenseParkState, PARK_STOCK_CODE, PARK_STOCK_NAME } from '../../../ai/track-b/defense-park.js';
import { cacheGet, cachePriceMemory, getCachedPriceMemory, getLastKnownPricesMemory } from '../../../cache/memory.js';
import { getOverseasScores } from '../../../cache/overseas-scores.js';
import { cachePrice, getLastKnownPrices, getScoresWithFallback } from '../../../cache/redis.js';
import { FALLBACK_FX_RATE, SECTOR_CLASS } from '../../../config/constants.js';
import { runWithMode } from '../../../config/context.js';
import { baseIsPaper } from '../../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getOpenChains, isMemoryMode, safeQuery } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import { getBatchPrices, isMarketOpen } from '../../../kis/market.js';
import { getOverseasPrice } from '../../../kis/overseas.js';
import { getPaperBalance } from '../../../risk/engine.js';
import { getKillSwitchStatusAll } from '../../../risk/kill-switch.js';
import { PAPER_INITIAL_CAPITAL } from '../../../risk/paper-balance.js';
import { calcDailyLossLimit, getOverseasLossTiers } from '../../../risk/seed-capital.js';
import { getCooldownStatus } from '../../../risk/trade-gate.js';
import { getPartialTpStages } from '../../../scheduler/overseas/risk-intelligence.js';
import { computePaperCash } from '../../../scheduler/overseas/state.js';
import { GLOBAL_WATCHLIST } from '../../../scheduler/overseas/watchlist.js';
import { logger } from '../../../utils/logger.js';
import { buildFxImpact, buildMonthlyGoal, buildSuggestedActions } from './builder-helpers.js';
import { calcTotalAssets } from './calc.js';
import {
  getDashBuildingByMode,
  getDashCache,
  getFxRate,
  getKnownStockName,
  isInvalidStockName,
  setDashCache,
} from './helpers.js';

// 동시 빌드 dedup: 같은 모드의 buildDashPayload가 두 번 동시 실행되지 않게
export async function getOrBuildDashPayload(viewIsPaper: boolean): Promise<unknown> {
  const key = viewIsPaper ? 'paper' : 'live';
  const building = getDashBuildingByMode();
  const existing = building.get(key);
  if (existing) return existing;
  const promise = buildDashPayload(viewIsPaper).finally(() => {
    building.delete(key);
  });
  building.set(key, promise);
  return promise;
}

export async function prewarmDashboard(): Promise<void> {
  // 서버 모드(live) 캐시만 선제 빌드 — paper는 요청 시 빌드
  const viewIsPaper = baseIsPaper;
  const key = viewIsPaper ? 'paper' : 'live';
  if (getDashCache(key)) return;
  try {
    const payload = await getOrBuildDashPayload(viewIsPaper);
    setDashCache(key, payload);
    logger.info(`🔥 대시보드 캐시 선제 빌드 완료 [${key}]`, { component: 'BOOT' });
  } catch (e: any) {
    logger.warn(`대시보드 캐시 선제 빌드 실패: ${e.message}`, { component: 'BOOT' });
  }
}

async function buildDashPayload(viewIsPaper: boolean): Promise<unknown> {
  // KIS API 실패 시 기본값 — 실전모드는 0 (가짜잔고 표시 방지), 연습모드만 시드자본
  const defaultBalance = viewIsPaper
    ? {
        totalDeposit: PAPER_INITIAL_CAPITAL,
        d2Deposit: PAPER_INITIAL_CAPITAL,
        orderableCash: PAPER_INITIAL_CAPITAL,
        cashSource: 'd2_deposit' as const,
        totalProfitLoss: 0,
        totalProfitLossPct: 0,
        netAsset: PAPER_INITIAL_CAPITAL,
        totalEvalAmount: 0,
        purchaseCost: 0,
        positions: [],
      }
    : {
        totalDeposit: 0,
        d2Deposit: 0,
        orderableCash: 0,
        cashSource: 'zero' as const,
        totalProfitLoss: 0,
        totalProfitLossPct: 0,
        netAsset: 0,
        totalEvalAmount: 0,
        purchaseCost: 0,
        positions: [],
      };

  const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);

  const balanceFn = viewIsPaper
    ? () => withTimeout(getPaperBalance(), 10000, defaultBalance as any)
    : () => withTimeout(getAccountBalance(true), 6000, defaultBalance as any);

  // v10.10.5c: watchlist를 Promise.all에 포함 (기존: 순차 호출 → 5-15ms 절약)
  const [balanceResult, chains, strategy, insightRows, defensePark, , watchlist] = await Promise.all([
    balanceFn().catch(() => defaultBalance),
    getOpenChains(viewIsPaper).catch(() => []),
    runWithMode(viewIsPaper, () => getActiveStrategy()).catch(() => null),
    safeQuery(
      `SELECT id, category, insight, confidence, sample_count, last_updated, is_manual,
              recommendation, param_change, is_applied, applied_at, is_paper
       FROM learned_insights WHERE is_paper = $1 ORDER BY is_manual DESC, confidence DESC LIMIT 30`,
      [viewIsPaper],
    ).catch(() => ({ rows: [] as any[] })),
    getDefenseParkState().catch(() => ({
      isActive: false,
      parkStockCode: PARK_STOCK_CODE,
      parkStockName: PARK_STOCK_NAME,
      entryReason: null,
      enteredAt: null,
    })),
    Promise.resolve(null),
    getActiveWatchlist().catch(() => []),
  ]);
  const balance = balanceResult ?? defaultBalance;
  const stockCodes = watchlist.map((w) => w.stock_code);

  // 감시종목 268+개 전체 스코어 조회는 부하 과중 → 상위 50개만 표시
  // (Track B pipeline도 35개만 사용, 대시보드도 동일 수준으로 제한)
  const allScores = await getScoresWithFallback(stockCodes);
  const scores = allScores.sort((a: any, b: any) => (b.composite_score ?? 0) - (a.composite_score ?? 0)).slice(0, 50);

  // chains + scores에 현재가 매칭 — KIS API 우선 (신선한 가격), 실패 시 캐시 폴백
  const posMap = new Map<string, any>((balance.positions ?? []).map((p: any) => [p.stockCode, p]));
  const chainCodes = [...new Set(chains.map((ch: any) => ch.stock_code))];
  const scoreCodes = scores.map((s: any) => s.stock_code as string).filter(Boolean);
  const allWatchCodes = [...new Set([...chainCodes, ...scoreCodes])];
  const priceMap = new Map<string, number>();

  // 1차: KIS 잔고 positions (실계좌 모드에서만 신뢰 — paper는 내부 avgPrice 폴백으로 오염 가능)
  if (!viewIsPaper) {
    for (const code of chainCodes) {
      const pos = posMap.get(code);
      if (pos?.currentPrice > 0) priceMap.set(code, pos.currentPrice);
    }
  }

  // 2차: KIS 시세 API 조회 — 최소 호출 원칙
  const nameMap = new Map<string, string>();
  const watchlistNameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const chainNameMap = new Map(chains.map((ch: any) => [ch.stock_code, ch.stock_name ?? '']));

  // 장중: score 코드 중 캐시(인메모리 30s) 없는 것만 추가 조회
  const scoreCodesNeedingPrice = isMarketOpen()
    ? scoreCodes.filter((c) => !priceMap.has(c) && !(getCachedPriceMemory(c) ?? 0))
    : [];

  // 이름 보정 필요 코드
  const needNameCodes = allWatchCodes.filter((c) => {
    const n = String(watchlistNameMap.get(c) ?? '') || String(chainNameMap.get(c) ?? '');
    return !n || n === c || /^\d{6}$/.test(n);
  });

  // 실제 API 호출 대상: 포지션 종목(chain) 우선, 이름 미확인 + score는 여유분만
  // KIS rate limit 방지: 총 5개 초과 금지 (marketDataRateLimiter 4/sec 기준 ~1.5초)
  const chainNeedingPrice = chainCodes.filter((c) => !priceMap.has(c));
  const remaining = Math.max(0, 5 - chainNeedingPrice.length);
  const codesToFetch = [
    ...new Set([
      ...chainNeedingPrice,
      ...needNameCodes.slice(0, Math.ceil(remaining / 2)),
      ...scoreCodesNeedingPrice.slice(0, Math.floor(remaining / 2)),
    ]),
  ].slice(0, 8);

  // 병렬 배치 조회 (체인+이름보정 위주 — 대폭 축소)
  if (codesToFetch.length > 0) {
    try {
      const batchResult = await withTimeout(getBatchPrices(codesToFetch), 3000, new Map());
      for (const [code, quote] of batchResult) {
        if (quote.currentPrice > 0) priceMap.set(code, quote.currentPrice);
        if (quote.stockName && quote.stockName !== code) nameMap.set(code, quote.stockName);
      }
    } catch {
      // 배치 실패 시 캐시 폴백만 사용 (순차 개별 조회는 rate limit 악화시킴)
      logger.warn(`대시보드 배치 가격 조회 실패 — 캐시 폴백`, { component: 'DASHBOARD' });
    }
  }

  // 종목명 백그라운드 보정: watchlist + transaction_chains 모두 코드명 → 실제명으로 업데이트
  if (!isMemoryMode()) {
    for (const [code, name] of nameMap) {
      const wName = String(watchlistNameMap.get(code) ?? '');
      if (isInvalidStockName(wName, code)) {
        safeQuery('UPDATE watchlist SET stock_name = $1 WHERE stock_code = $2', [name, code]).catch(() => {});
      }
      const cName = String(chainNameMap.get(code) ?? '');
      if (isInvalidStockName(cName, code)) {
        safeQuery(
          "UPDATE transaction_chains SET stock_name = $1 WHERE stock_code = $2 AND is_paper = $3 AND (stock_name IS NULL OR stock_name = $2 OR stock_name ~ '^[0-9]{6}$' OR stock_name !~ '[A-Za-z가-힣]')",
          [name, code, viewIsPaper],
        ).catch(() => {});
      }
    }
  }

  // 3차: 인메모리 캐시 폴백 (chain + score 모두)
  for (const code of allWatchCodes) {
    if (!priceMap.has(code)) {
      const cached = getCachedPriceMemory(code);
      if (cached && cached > 0) priceMap.set(code, cached);
    }
  }

  // 4차: 마지막 수단 — 2시간 장기 캐시 (장 마감 후 등)
  const stillMissing = chainCodes.filter((code) => !priceMap.has(code));
  if (stillMissing.length > 0) {
    const redisCached = await getLastKnownPrices(stillMissing).catch(() => new Map());
    redisCached.forEach((price, code) => {
      priceMap.set(code, price);
    });
    for (const code of stillMissing.filter((c) => !priceMap.has(c))) {
      const last = getLastKnownPricesMemory([code]).get(code);
      if (last) priceMap.set(code, last);
    }
  }

  // 5차: paper 전용 — getPaperPositions()가 이미 조회한 가격 재활용
  // getBatchPrices는 cachePriceMemory를 쓰지 않아 3차에서 누락됨 → posMap으로 보완
  // currentPrice가 avgPrice 폴백인 경우에도 unrealizedPnl=0 (현재 동작과 동일) — 최악 동등
  if (viewIsPaper) {
    for (const code of chainCodes) {
      if (!priceMap.has(code)) {
        const pos = posMap.get(code);
        if (pos?.currentPrice > 0) priceMap.set(code, pos.currentPrice);
      }
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
    // 현재가 0 방지: 장 마감 시 캐시 만료로 PnL이 갑자기 0으로 리셋되는 버그 수정
    // 폴백 순서: priceMap → avgPrice(PnL=0 유지, 급변 방지)
    const rawPrice = priceMap.get(ch.stock_code) ?? 0;
    const avgPrice = Number(ch.avg_buy_price) || 0;
    const currentPrice = rawPrice > 0 ? rawPrice : avgPrice;
    const qty = Number(ch.total_quantity) || 0;
    const total_invested = avgPrice * qty;
    const unrealizedPnl = currentPrice > 0 ? (currentPrice - avgPrice) * qty : 0;
    const unrealizedPnlPct = currentPrice > 0 && avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
    // 국내 종목(6자리 숫자)만 KRW totalChainInvested에 합산 — 해외 종목(알파벳)은 overseasTotalInvestedUsd로 별도 처리
    if (/^\d{6}$/.test(ch.stock_code)) {
      totalChainInvested += total_invested;
      totalChainPnl += unrealizedPnl;
    }
    const isCode = (n: any) => !n || String(n) === ch.stock_code || /^\d{6}$/.test(String(n));
    const known = getKnownStockName(ch.stock_code);
    const resolvedName =
      [nameMap.get(ch.stock_code), watchlistNameMap.get(ch.stock_code), ch.stock_name, known].find(
        (n) => !isCode(n) && !isInvalidStockName(n, ch.stock_code),
      ) ?? ch.stock_code;
    const isParking = defensePark?.isActive && ch.stock_code === defensePark?.parkStockCode;
    return { ...ch, stock_name: resolvedName, currentPrice, unrealizedPnl, unrealizedPnlPct, total_invested, isParking };
  });

  // 🔄 LIVE 뷰: KIS 실계좌 포지션 중 체인이 없는 종목을 가상 체인으로 표시
  if (!viewIsPaper && balance.positions?.length > 0) {
    const chainCodeSet = new Set(enrichedChains.map((ch: any) => ch.stock_code));
    for (const pos of balance.positions as any[]) {
      if (pos.quantity > 0 && !chainCodeSet.has(pos.stockCode)) {
        const invested = pos.avgBuyPrice * pos.quantity;
        // KIS evlu_pfls_amt가 0이면 현재가-평단으로 직접 계산 (수동매수 포지션 미실현손익 표기 보호)
        const kisPnl = pos.profitLoss ?? 0;
        const kisPnlPct = pos.profitLossPct ?? 0;
        const cp = pos.currentPrice ?? 0;
        const avg = pos.avgBuyPrice ?? 0;
        const qty = pos.quantity ?? 0;
        const compPnl = cp > 0 && avg > 0 ? (cp - avg) * qty : 0;
        const compPnlPct = cp > 0 && avg > 0 ? ((cp - avg) / avg) * 100 : 0;
        const finalPnl = kisPnl !== 0 ? kisPnl : compPnl;
        const finalPnlPct = kisPnlPct !== 0 ? kisPnlPct : compPnlPct;
        totalChainInvested += invested;
        totalChainPnl += finalPnl;
        enrichedChains.push({
          id: `KIS_SYNC_${pos.stockCode}`,
          stock_code: pos.stockCode,
          stock_name: pos.stockName || pos.stockCode,
          status: 'OPEN',
          strategy_mode: 'SWING',
          avg_buy_price: avg,
          total_quantity: qty,
          total_invested: invested,
          realized_pnl: 0,
          current_averaging_count: 0,
          max_averaging_count: 0,
          is_paper: false,
          trigger_source: 'KIS_SYNC',
          currentPrice: cp,
          unrealizedPnl: finalPnl,
          unrealizedPnlPct: finalPnlPct,
          invested,
          isParking: false,
          opened_at: null,
        });
      }
    }
  }

  // calcTotalAssets 입력값 준비
  const rawCash = balance.orderableCash ?? PAPER_INITIAL_CAPITAL;

  // ── 실현손익 3 쿼리 → Promise.all 병렬화 (네트워크 왕복 70% 단축) ──
  let liveRealizedPnl = 0;
  let overseasRealizedPnlUsd = 0;
  try {
    const tradingMode = viewIsPaper ? 'paper' : 'live';
    const [realizedRows, flowRows, holdCostRows] = await Promise.all([
      safeQuery<{ total: string }>(
        `SELECT COALESCE(SUM(realized_pnl), 0)::text AS total
         FROM transaction_chains WHERE status='CLOSED' AND is_paper=$1`,
        [viewIsPaper],
      ),
      safeQuery<{ net_flow: string }>(
        `SELECT COALESCE(SUM(CASE
           WHEN side = 'SELL' THEN filled_price * filled_quantity
           WHEN side = 'BUY'  THEN -(filled_price * filled_quantity)
         END), 0)::text AS net_flow
         FROM orders
         WHERE trigger_source = 'OVERSEAS' AND status = 'FILLED' AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))`,
        [tradingMode],
      ),
      safeQuery<{ invested: string }>(
        `SELECT COALESCE(SUM(avg_price * quantity), 0)::text AS invested
         FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1`,
        [viewIsPaper],
      ),
    ]);
    liveRealizedPnl = Number(realizedRows.rows[0]?.total ?? 0);
    const netFlowUsd = Number(flowRows.rows[0]?.net_flow ?? 0);
    const currentInvestedUsd = Number(holdCostRows.rows[0]?.invested ?? 0);
    overseasRealizedPnlUsd = Math.round((netFlowUsd + currentInvestedUsd) * 100) / 100;
  } catch {
    /* 실현손익 계산 실패 시 0 유지 */
  }

  // ── 해외 보유종목 (별도 표시용, 국내 총자산에 합산하지 않음) ──
  const overseasHoldings: Array<{
    stock_code: string;
    quantity: number;
    avg_price: number;
    bought_at: string;
    last_price: number;
    sector: string;
    tp_pct: number;
    sl_pct: number;
    trail_pct: number;
    trail_active: boolean;
    trail_stop_pct: number;
    max_pnl_pct: number;
    partial_tp_stage: number;
    next_partial_tp_pct: number | null;
    is_scalp: boolean;
    scalp_tp: number | null;
    scalp_sl: number | null;
  }> = [];
  let overseasTotalInvested = 0;
  let overseasMarketValueUsd = 0;
  let overseasCash = 0;
  let _osCashAge = Infinity; // 스테일 가드용: overseas_state.cash 경과 초 (try 블록 밖 선언)
  let _overseasMaxUsd = 0; // KIS maxUsd(통합증거금 전체 주문가능 USD) — 환율 역변환 오차 방지
  try {
    const pfx = viewIsPaper ? 'p_' : 'l_';

    // Paper: orders 기반 실시간 계산 (USD), Live: DB에서 KRW 읽기
    const { rows: osRows } = await safeQuery('SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1', [
      viewIsPaper,
    ]);
    if (viewIsPaper) {
      overseasCash = await computePaperCash(); // USD (결정론적 — orders 기반)
    } else {
      // cash + cash_max_usd 배치 조회 (2 쿼리 → 1 쿼리)
      const { rows: cashStateRows } = await safeQuery(
        `SELECT key, value, EXTRACT(EPOCH FROM (NOW() - COALESCE(updated_at, NOW() - INTERVAL '999 hours'))) AS age_sec
         FROM overseas_state WHERE key IN ('cash', 'cash_max_usd')`,
      );
      for (const row of cashStateRows) {
        if (row.key === 'cash') {
          _osCashAge = Number(row.age_sec);
          overseasCash = Number(row.value); // KRW
        } else if (row.key === 'cash_max_usd') {
          _overseasMaxUsd = Number(row.value);
        }
      }
    }

    // 종목별 고점/부분익절단계/동적TP·SL 일괄 조회
    const codes = osRows.map((r: any) => String(r.stock_code));
    const stateKeys = codes.flatMap((c) => [
      `${pfx}maxprice_${c}`,
      `${pfx}partial_tp_stage_${c}`,
      `${pfx}dynamic_tpsl_${c}`,
    ]);
    const stateMap = new Map<string, string>();
    if (stateKeys.length > 0) {
      const { rows: stRows } = await safeQuery('SELECT key, value FROM overseas_state WHERE key = ANY($1)', [
        stateKeys,
      ]);
      for (const sr of stRows) stateMap.set(sr.key, sr.value);
    }

    // last_price=0이거나 15분 이상 stale인 종목: 인메모리 캐시 → KIS API 조회 (최대 3종목)
    const staleThresh = Date.now() - 15 * 60 * 1000;
    const needPrice = osRows.filter((r: any) => {
      if (Number(r.last_price ?? 0) <= 0) return true;
      if (r.last_price_at && new Date(r.last_price_at).getTime() < staleThresh) return true;
      return false;
    }).slice(0, 3);
    // v10.10.5c: 순차 → 병렬 (최대 3종목 × 3s timeout = 기존 9s → 3s)
    await Promise.allSettled(needPrice.map(async (r) => {
      const memP = cacheGet<{ price: number }>(`overseas:lastprice:${r.stock_code}`)?.price ?? 0;
      if (memP > 0) { r.last_price = memP; return; }
      try {
        const p = await withTimeout(getOverseasPrice(String(r.stock_code), String(r.exchange)), 3000, null!);

        if (p?.currentPrice > 0) {
          r.last_price = p.currentPrice;
          safeQuery(
            'UPDATE overseas_holdings SET last_price = $1, last_price_at = NOW() WHERE stock_code = $2 AND exchange = $3 AND is_paper = $4',
            [p.currentPrice, r.stock_code, r.exchange, viewIsPaper],
          ).catch(() => {});
        }
      } catch { /* 시세 조회 실패 시 기존 폴백 사용 */ }
    }));

    if (viewIsPaper && osRows.length > 0) {
      logger.info(
        `[PAPER_OS_HOLDINGS] ${osRows.length}행: ${osRows.map((r: any) => `${r.stock_code} qty=${r.quantity} avg=${r.avg_price} last=${r.last_price}`).join(' | ')}`,
        { component: 'DASHBOARD' },
      );
    }
    // GLOBAL_WATCHLIST → Map 변환 (O(n²) → O(n) 최적화)
    const watchlistCodeMap = new Map(GLOBAL_WATCHLIST.map(w => [w.code, w]));

    for (const r of osRows) {
      const code = String(r.stock_code);
      const qty = Number(r.quantity);
      const avgP = Number(r.avg_price);
      // last_price 우선순위: DB last_price → 인메모리 가격 캐시 → avg_price 폴백
      const dbLastP = Number(r.last_price ?? 0);
      const memPrice = cacheGet<{ price: number }>(`overseas:lastprice:${code}`)?.price ?? 0;
      const lastP = dbLastP > 0 ? dbLastP : memPrice > 0 ? memPrice : avgP;
      const curP = lastP;
      overseasTotalInvested += avgP * qty;
      overseasMarketValueUsd += curP * qty;

      const wItem = watchlistCodeMap.get(code);
      const sector = wItem?.sector ?? '';
      const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
      const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
      const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

      // ── TP/SL: overseas_holdings에 매수 시 저장된 값 우선 사용 ──
      const holdingTp = r.tp_pct != null ? Number(r.tp_pct) : null;
      const holdingSl = r.sl_pct != null ? Number(r.sl_pct) : null;
      // 레거시 폴백: overseas_state 캐시 → 섹터 기반 폴백
      let dynTp = holdingTp;
      let dynSl = holdingSl;
      if (dynTp == null || dynSl == null) {
        const dynRaw = stateMap.get(`${pfx}dynamic_tpsl_${code}`);
        if (dynRaw) {
          try {
            const v = JSON.parse(dynRaw);
            if (dynTp == null) dynTp = Number(v.tp);
            if (dynSl == null) dynSl = Number(v.sl);
          } catch {
            /* skip */
          }
        }
      }
      // 섹터 기반 폴백 SL (동적 값 없을 때만)
      const fallbackSl = isHighBeta ? -8.0 : isMediumBeta ? -5.0 : isDefense ? -4.0 : -5.0;
      const baseSl = dynSl != null && Number.isFinite(dynSl) ? dynSl : fallbackSl;

      // ── 부분익절 단계: risk-intelligence.ts 함수 사용 (동기화) ──
      const partialStageNum = Number(stateMap.get(`${pfx}partial_tp_stage_${code}`) ?? 0);
      const tpStages = getPartialTpStages(sector);
      // 다음 부분익절 목표
      const nextPartialStage = tpStages.find((s) => s.stage > partialStageNum);
      const nextPartialTpPct = nextPartialStage?.triggerPct ?? null;
      // 동적 Hard TP (매매엔진 값 우선, 없으면 섹터 기반 폴백)
      const fallbackHardTp = isHighBeta ? 25.0 : isDefense ? 18.0 : 20.0;
      const hardTp = dynTp != null && Number.isFinite(dynTp) ? dynTp : fallbackHardTp;
      // 실질 TP = 다음 부분익절 목표 or hard TP
      const effectiveTpPct = nextPartialTpPct ?? hardTp;

      // ── 트레일링 스톱 계산 (고점 추적 데이터 활용) ──
      const maxPrice = Number(stateMap.get(`${pfx}maxprice_${code}`) ?? 0);
      const maxPnlPct = maxPrice > 0 && avgP > 0 ? ((maxPrice - avgP) / avgP) * 100 : 0;
      const trailActivatePct = isHighBeta ? 10.0 : isMediumBeta ? 8.0 : 5.0;
      const trailActive = maxPnlPct >= trailActivatePct;
      // ATR 동적 트레일 드랍 (sell-logic과 동일한 공식, ATR 기본 추정)
      const estAtr = isHighBeta ? 3.0 : isDefense ? 1.2 : 2.0;
      const atrTrail = -(estAtr * 2.5);
      const minTrail = isHighBeta ? -12.0 : isDefense ? -6.0 : -8.0;
      const maxTrail = isHighBeta ? -5.0 : isDefense ? -3.0 : -4.0;
      const dynTrailDrop = Math.max(minTrail, Math.min(maxTrail, atrTrail));
      // 트레일링 활성 시: 고점 대비 dynTrailDrop% = 매도, 이를 평단 기준 %로 변환
      const trailStopPct =
        trailActive && maxPrice > 0 && avgP > 0 ? ((maxPrice * (1 + dynTrailDrop / 100) - avgP) / avgP) * 100 : baseSl;
      // 실질 SL = 트레일링 활성이면 트레일스톱, 아니면 동적/고정 SL
      const effectiveSlPct = trailActive ? Math.max(trailStopPct, baseSl) : baseSl;

      overseasHoldings.push({
        stock_code: code,
        quantity: qty,
        avg_price: Math.round(avgP * 10000) / 10000,
        bought_at: r.bought_at,
        last_price: curP,
        sector,
        tp_pct: effectiveTpPct,
        sl_pct: effectiveSlPct,
        trail_pct: trailActivatePct,
        trail_active: trailActive,
        trail_stop_pct: trailStopPct,
        max_pnl_pct: maxPnlPct,
        partial_tp_stage: partialStageNum,
        next_partial_tp_pct: nextPartialTpPct,
        is_scalp: !!r.is_scalp,
        scalp_tp: r.scalp_tp != null ? Number(r.scalp_tp) : null,
        scalp_sl: r.scalp_sl != null ? Number(r.scalp_sl) : null,
      });
    }
  } catch {
    /* overseas table may not exist */
  }

  // ── 총자산 계산: calcTotalAssets 순수 함수로 위임 ──
  let FX_RATE = await getFxRate();
  if (FX_RATE <= 0) FX_RATE = FALLBACK_FX_RATE;

  // 전일 총자산 스냅샷 (수익률 계산용) + 미실현PnL (입금 영향 제거용)
  let prevDayTotalValue = 0;
  let prevDayUnrealizedPnl = 0;
  {
    const snapResult = await safeQuery<{ total_value: string; unrealized_pnl: string }>(
      `SELECT total_value, unrealized_pnl FROM portfolio_snapshots
       WHERE is_paper = $1 AND total_value > 0
         AND snapshot_at < (NOW() AT TIME ZONE 'Asia/Seoul')::DATE
       ORDER BY snapshot_at DESC LIMIT 1`,
      [viewIsPaper],
    );
    if (snapResult.rows[0]) {
      prevDayTotalValue = Number(snapResult.rows[0].total_value);
      prevDayUnrealizedPnl = Number(snapResult.rows[0].unrealized_pnl ?? 0);
    }
  }

  const assets = calcTotalAssets({
    viewIsPaper,
    rawCash,
    netAsset: balance.netAsset ?? 0,
    kisDomEval: balance.totalEvalAmount ?? 0,
    kisPurchaseCost: (balance as any).purchaseCost ?? 0,
    kisTotalProfitLoss: balance.totalProfitLoss ?? 0,
    kisTotalProfitLossPct: balance.totalProfitLossPct ?? 0,
    cashSource: balance.cashSource ?? 'unknown',
    totalChainInvested,
    totalChainPnl,
    overseasTotalInvestedUsd: overseasTotalInvested,
    overseasMarketValueUsd,
    overseasCashRaw: overseasCash,
    overseasMaxUsd: _overseasMaxUsd,
    fxRate: FX_RATE,
    paperInitialCapital: PAPER_INITIAL_CAPITAL,
    liveRealizedPnl,
    prevDayTotalValue,
    prevDayUnrealizedPnl,
  });

  // 디버깅 로그 — 계산 결과 확인
  logger.info(
    `💰 총자산 계산 [${viewIsPaper ? 'Paper' : 'Live'}] (${assets.calcMethod}): ` +
    `freeCash=${assets.freeDomesticCash.toLocaleString()} | nass=${(balance.netAsset ?? 0).toLocaleString()} | ` +
    `domMV=${assets.domesticMarketValue.toLocaleString()} | ` +
    `ovrsMV=${assets.overseasMarketValueKrw.toLocaleString()} ovrsCash=${assets.overseasCashKrw.toLocaleString()} | ` +
    `TOTAL=${assets.grandTotalValue.toLocaleString()} cashSrc=${assets.actualCashSource}`,
    { component: 'DASHBOARD' },
  );

  // 별칭 — 하위 코드에서 사용
  const grandTotalValue = assets.grandTotalValue;
  const overseasInvestedKrw = assets.overseasInvestedKrw;
  const overseasMarketValueKrw = assets.overseasMarketValueKrw;
  const overseasCashForDisplay = assets.overseasCashForDisplay;
  const actualCashSource = assets.actualCashSource;

  // 비중(weight) 계산 — grandTotalValue 기준 시가 기반 통합 비중
  for (const ch of enrichedChains as any[]) {
    const marketVal = ch.currentPrice > 0 ? ch.currentPrice * Number(ch.total_quantity || 0) : ch.total_invested; // 시세 없으면 원가 폴백
    ch.weight = grandTotalValue > 0 ? Math.round((marketVal / grandTotalValue) * 1000) / 10 : 0;
  }
  for (const h of overseasHoldings as any[]) {
    const marketKrw = h.last_price * h.quantity * FX_RATE;
    h.weight = grandTotalValue > 0 ? Math.round((marketKrw / grandTotalValue) * 1000) / 10 : 0;
  }

  // 동일 종목 복수 체인 합산 (같은 종목 중복 표시 방지)
  const chainsByCode = new Map<string, any[]>();
  for (const ch of enrichedChains as any[]) {
    const arr = chainsByCode.get(ch.stock_code) ?? [];
    arr.push(ch);
    chainsByCode.set(ch.stock_code, arr);
  }
  const displayChains = [...chainsByCode.values()].map((group: any[]) => {
    if (group.length === 1) return { ...group[0], chainIds: [group[0].id] };
    const primary = group[0];
    const totalQty = group.reduce((s: number, c: any) => s + Number(c.total_quantity || 0), 0);
    const totalInv = group.reduce((s: number, c: any) => s + (c.total_invested || 0), 0);
    const weightedAvg = totalQty > 0 ? totalInv / totalQty : 0;
    const cp = primary.currentPrice;
    const mergedPnl = cp > 0 ? (cp - weightedAvg) * totalQty : 0;
    const mergedPnlPct = cp > 0 && weightedAvg > 0 ? ((cp - weightedAvg) / weightedAvg) * 100 : 0;
    const totalWeight = group.reduce((s: number, c: any) => s + (c.weight || 0), 0);
    return {
      ...primary,
      avg_buy_price: weightedAvg,
      total_quantity: totalQty,
      total_invested: totalInv,
      unrealizedPnl: mergedPnl,
      unrealizedPnlPct: mergedPnlPct,
      weight: totalWeight,
      status: group.some((c: any) => c.status === 'PROFIT_TAKING') ? 'PROFIT_TAKING' : primary.status,
      chainIds: group.map((c: any) => c.id),
      _mergedCount: group.length,
    };
  });

  const dashPayload = {
    portfolio: {
      totalValue: assets.grandTotalValue,
      cash: assets.totalCash,
      invested: assets.totalInvested,
      domesticInvested: assets.domesticInvested,
      domesticEval: assets.domesticMarketValue,
      domesticCash: assets.unifiedCash,
      unrealizedPnl: Math.round(viewIsPaper ? totalChainPnl : balance.totalProfitLoss || totalChainPnl),
      realizedPnl: Math.round(liveRealizedPnl),
      pnl: Math.round(assets.totalPnl), // totalPnl already includes overseasUnrealizedPnlKrw (calc.ts)
      pnlPct: assets.totalPnlPct,
      prevDayTotalValue: assets.prevDayTotalValue,
      dailyChangePct: assets.dailyChangePct,
      positions: balance.positions ?? [],
    },
    overseas: {
      holdings: overseasHoldings,
      totalInvestedUsd: overseasTotalInvested,
      totalInvestedKrw: overseasInvestedKrw,
      totalMarketValueUsd: overseasMarketValueUsd,
      totalMarketValueKrw: overseasMarketValueKrw,
      unrealizedPnlKrw: assets.overseasUnrealizedPnlKrw,
      unrealizedPnlUsd: Math.round((overseasMarketValueUsd - overseasTotalInvested) * 100) / 100,
      unrealizedPnlPct:
        overseasInvestedKrw > 0
          ? Math.round(((overseasMarketValueKrw - overseasInvestedKrw) / overseasInvestedKrw) * 10000) / 100
          : 0,
      realizedPnlUsd: overseasRealizedPnlUsd,
      realizedPnlKrw: Math.round(overseasRealizedPnlUsd * FX_RATE),
      cashUsd: assets.overseasCashUsdDisplay,
      cashKrw: overseasCashForDisplay,
      fxRate: FX_RATE,
      scores: getOverseasScores(),
    },
    activeChains: displayChains.length,
    chains: displayChains,
    scores: scores.map((s: any) => ({
      ...s,
      stock_name: watchlistNameMap.get(s.stock_code) || s.stock_code,
      currentPrice: priceMap.get(s.stock_code) ?? 0,
    })),
    strategy: strategy ?? { mode: 'SWING' },
    killSwitch: await runWithMode(viewIsPaper, async () => getKillSwitchStatusAll()),
    cooldown: await runWithMode(viewIsPaper, async () => {
      const status = await getCooldownStatus().catch(() => ({
        active: false,
        consecutive: 0,
        remainingMinutes: 0,
        reason: '',
      }));
      const { isEodOnlyMode } = await import('../../../risk/trade-gate-stats.js');
      const eodOnly = await isEodOnlyMode().catch(() => false);
      return { ...status, eodOnly };
    }),
    tradingMode: viewIsPaper ? 'paper' : 'live',
    viewMode: viewIsPaper ? 'paper' : 'live',
    cashSource: actualCashSource,
    riskLimits: (() => {
      const limit = calcDailyLossLimit(grandTotalValue, viewIsPaper);
      // 해외 리스크 베이스: Paper=해외현금+시가, Live=시가만(통합증거금)
      const osPortfolioKrw = !viewIsPaper
        ? overseasMarketValueKrw
        : overseasCashForDisplay + overseasMarketValueKrw;
      const osPortfolioUsd = FX_RATE > 0 ? osPortfolioKrw / FX_RATE : 0;
      // 해외 손실한도: 해외 전용 단계(OVERSEAS_LOSS_TIERS) 사용 — 국내 pct 사용 금지
      const osTiers = getOverseasLossTiers(viewIsPaper);
      return {
        maxDailyDrawdownKrw: limit.limitAmount,
        dailyDrawdownPct: limit.pct,
        basis: limit.basis,
        overseasLimitUsd: Math.round((osPortfolioUsd * osTiers.blockPct) / 100),
        overseasWarnUsd: Math.round((osPortfolioUsd * osTiers.warnPct) / 100),
        overseasBlockUsd: Math.round((osPortfolioUsd * osTiers.blockPct) / 100),
        overseasKillPct: osTiers.killPct,
        overseasBasisUsd: Math.round(osPortfolioUsd),
      };
    })(),
    insights: insightRows.rows,
    defensePark,

    suggestedActions: buildSuggestedActions(overseasHoldings, displayChains, grandTotalValue, assets.unifiedCash).map((a) => ({
      ...a,
      mode: (viewIsPaper ? 'paper' : 'live') as 'paper' | 'live',
    })),
    monthlyGoal: buildMonthlyGoal(grandTotalValue, assets.totalPnl, overseasMarketValueKrw, overseasInvestedKrw),
    fxImpact: buildFxImpact(overseasTotalInvested, overseasMarketValueUsd, FX_RATE),
  };
  return dashPayload;
}
