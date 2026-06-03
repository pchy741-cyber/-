/**
 * 대시보드 페이로드 빌더 — buildDashPayload + getOrBuildDashPayload
 */
import { getCachedScores, getScoresWithFallback, cachePrice, getLastKnownPrices } from '../../../cache/redis.js';
import { cachePriceMemory, getLastKnownPricesMemory, getCachedPriceMemory, cacheGet } from '../../../cache/memory.js';
import { config, baseIsPaper } from '../../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getOpenChains, getTodayStartSnapshot, isMemoryMode, safeQuery } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import { getCurrentPrice, getBatchPrices, isMarketOpen } from '../../../kis/market.js';
import { getDefenseParkState } from '../../../ai/track-b/defense-park.js';
import { getPaperBalance } from '../../../risk/engine.js';
import { PAPER_INITIAL_CAPITAL } from '../../../risk/paper-balance.js';
import { getKillSwitchStatusAll } from '../../../risk/kill-switch.js';
import { calcDailyLossLimit } from '../../../risk/seed-capital.js';
import { getCooldownStatus } from '../../../risk/trade-gate.js';
import { getOverseasScores } from '../../../cache/overseas-scores.js';
import { getOverseasPrice } from '../../../kis/overseas.js';
import { SECTOR_CLASS } from '../../../config/constants.js';
import { GLOBAL_WATCHLIST } from '../../../scheduler/overseas/watchlist.js';
import { getDynamicTpSl, computePaperCash } from '../../../scheduler/overseas/state.js';
import { getPartialTpStages } from '../../../scheduler/overseas/risk-intelligence.js';
import { logger } from '../../../utils/logger.js';
import {
  isInvalidStockName, getKnownStockName, getFxRate,
  getDashCache, setDashCache, getDashBuildingByMode,
} from './helpers.js';

// 동시 빌드 dedup: 같은 모드의 buildDashPayload가 두 번 동시 실행되지 않게
export async function getOrBuildDashPayload(viewIsPaper: boolean): Promise<unknown> {
  const key = viewIsPaper ? 'paper' : 'live';
  const building = getDashBuildingByMode();
  const existing = building.get(key);
  if (existing) return existing;
  const promise = buildDashPayload(viewIsPaper).finally(() => { building.delete(key); });
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
  // KIS API 실패 시 기본값 — 실전모드는 0 (10M 가짜잔고 표시 방지), 연습모드만 1000만원
  const defaultBalance = viewIsPaper
    ? { totalDeposit: 10000000, totalEvalAmount: 0, orderableCash: 10000000, totalProfitLoss: 0, totalProfitLossPct: 0, netAsset: 10000000, purchaseCost: 0, positions: [] }
    : { totalDeposit: 0, totalEvalAmount: 0, orderableCash: 0, totalProfitLoss: 0, totalProfitLossPct: 0, netAsset: 0, purchaseCost: 0, positions: [] };

  const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>(res => setTimeout(() => res(fallback), ms))]);

  const balanceFn = viewIsPaper
    ? () => withTimeout(getPaperBalance(), 5000, defaultBalance as any)
    : () => withTimeout(getAccountBalance(true), 6000, defaultBalance as any);

  const [balanceResult, chains, strategy, insightRows, defensePark] = await Promise.all([
    balanceFn().catch(() => defaultBalance),
    getOpenChains(viewIsPaper).catch(() => []),
    getActiveStrategy().catch(() => null),
    safeQuery(
      `SELECT id, category, insight, confidence, sample_count, last_updated, is_manual,
              recommendation, param_change, is_applied, applied_at, is_paper
       FROM learned_insights ORDER BY is_manual DESC, confidence DESC LIMIT 30`
    ).catch(() => ({ rows: [] as any[] })),
    getDefenseParkState().catch(() => ({ isActive: false, parkStockCode: '069500', parkStockName: 'KODEX 200', entryReason: null, enteredAt: null })),
  ]);
  const balance = balanceResult ?? defaultBalance;

  const watchlist = await getActiveWatchlist().catch(() => []);
  const stockCodes = watchlist.map((w) => w.stock_code);

  // 감시종목 268+개 전체 스코어 조회는 부하 과중 → 상위 50개만 표시
  // (Track B pipeline도 35개만 사용, 대시보드도 동일 수준으로 제한)
  const allScores = await getScoresWithFallback(stockCodes);
  const scores = allScores
    .sort((a: any, b: any) => (b.composite_score ?? 0) - (a.composite_score ?? 0))
    .slice(0, 50);

  // chains + scores에 현재가 매칭 — KIS API 우선 (신선한 가격), 실패 시 캐시 폴백
  const posMap = new Map<string, any>((balance.positions ?? []).map((p: any) => [p.stockCode, p]));
  const chainCodes = [...new Set(chains.map((ch: any) => ch.stock_code))];
  const scoreCodes = scores.map((s: any) => s.stock_code as string).filter(Boolean);
  const allWatchCodes = [...new Set([...chainCodes, ...scoreCodes])];
  const priceMap = new Map<string, number>();

  // 1차: KIS 잔고 positions (실계좌 모드에서 정확)
  for (const code of chainCodes) {
    const pos = posMap.get(code);
    if (pos?.currentPrice > 0) priceMap.set(code, pos.currentPrice);
  }

  // 2차: KIS 시세 API 조회 — 최소 호출 원칙
  const nameMap = new Map<string, string>();
  const watchlistNameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const chainNameMap = new Map(chains.map((ch: any) => [ch.stock_code, ch.stock_name ?? '']));

  // 장중: score 코드 중 캐시(인메모리 30s) 없는 것만 추가 조회
  const scoreCodesNeedingPrice = isMarketOpen()
    ? scoreCodes.filter(c => !priceMap.has(c) && !(getCachedPriceMemory(c) ?? 0))
    : [];

  // 이름 보정 필요 코드
  const needNameCodes = allWatchCodes.filter(c => {
    const n = String(watchlistNameMap.get(c) ?? '') || String(chainNameMap.get(c) ?? '');
    return !n || n === c || /^\d{6}$/.test(n);
  });

  // 실제 API 호출 대상: 포지션 종목(chain) 우선, 이름 미확인 + score는 여유분만
  // KIS rate limit 방지: 총 5개 초과 금지 (marketDataRateLimiter 4/sec 기준 ~1.5초)
  const chainNeedingPrice = chainCodes.filter(c => !priceMap.has(c));
  const remaining = Math.max(0, 5 - chainNeedingPrice.length);
  const codesToFetch = [...new Set([
    ...chainNeedingPrice,
    ...needNameCodes.slice(0, Math.ceil(remaining / 2)),
    ...scoreCodesNeedingPrice.slice(0, Math.floor(remaining / 2)),
  ])].slice(0, 8);

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
          "UPDATE transaction_chains SET stock_name = $1 WHERE stock_code = $2 AND (stock_name IS NULL OR stock_name = $2 OR stock_name ~ '^[0-9]{6}$' OR stock_name !~ '[A-Za-z가-힣]')",
          [name, code]
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
    const isCode = (n: any) => !n || String(n) === ch.stock_code || /^\d{6}$/.test(String(n));
    const known = getKnownStockName(ch.stock_code);
    const resolvedName = [nameMap.get(ch.stock_code), watchlistNameMap.get(ch.stock_code), ch.stock_name, known]
      .find(n => !isCode(n) && !isInvalidStockName(n, ch.stock_code)) ?? ch.stock_code;
    const isParking = defensePark?.isActive && ch.stock_code === defensePark?.parkStockCode;
    return { ...ch, stock_name: resolvedName, currentPrice, unrealizedPnl, unrealizedPnlPct, invested, isParking };
  });

  // 🔄 LIVE 뷰: KIS 실계좌 포지션 중 체인이 없는 종목을 가상 체인으로 표시
  if (!viewIsPaper && balance.positions?.length > 0) {
    const chainCodeSet = new Set(enrichedChains.map((ch: any) => ch.stock_code));
    for (const pos of balance.positions as any[]) {
      if (pos.quantity > 0 && !chainCodeSet.has(pos.stockCode)) {
        const invested = pos.avgBuyPrice * pos.quantity;
        totalChainInvested += invested;
        totalChainPnl += pos.profitLoss ?? 0;
        enrichedChains.push({
          id: `KIS_SYNC_${pos.stockCode}`,
          stock_code: pos.stockCode,
          stock_name: pos.stockName || pos.stockCode,
          status: 'OPEN',
          strategy_mode: 'SWING',
          avg_buy_price: pos.avgBuyPrice,
          total_quantity: pos.quantity,
          total_invested: invested,
          realized_pnl: 0,
          current_averaging_count: 0,
          max_averaging_count: 0,
          is_paper: false,
          trigger_source: 'KIS_SYNC',
          currentPrice: pos.currentPrice,
          unrealizedPnl: pos.profitLoss ?? 0,
          unrealizedPnlPct: pos.profitLossPct ?? 0,
          invested,
          isParking: false,
          opened_at: null,
        });
      }
    }
  }

  // 투자금/손익 계산 — 모드별 분기
  const rawCash = balance.orderableCash ?? 10000000;

  let totalInvested: number;
  let totalPnl: number;
  let actualCash: number;

  if (viewIsPaper) {
    totalInvested = totalChainInvested;
    totalPnl = totalChainPnl + (balance.totalProfitLoss ?? 0);
    actualCash = rawCash;
  } else {
    // Live: purchaseCost(원가) 사용, 없으면 체인 원가 합산
    totalInvested = (balance as any).purchaseCost > 0
      ? (balance as any).purchaseCost
      : totalChainInvested;
    totalPnl = balance.totalProfitLoss ?? 0;
    actualCash = rawCash;
  }

  const totalPnlPct = viewIsPaper
    ? (PAPER_INITIAL_CAPITAL > 0 ? (totalPnl / PAPER_INITIAL_CAPITAL) * 100 : 0)
    : (balance.totalProfitLossPct ?? 0);

  // ── 해외 보유종목 (별도 표시용, 국내 총자산에 합산하지 않음) ──
  let overseasHoldings: Array<{
    stock_code: string; quantity: number; avg_price: number; bought_at: string; last_price: number;
    sector: string; tp_pct: number; sl_pct: number; trail_pct: number;
    trail_active: boolean; trail_stop_pct: number; max_pnl_pct: number;
    partial_tp_stage: number; next_partial_tp_pct: number | null;
    is_scalp: boolean; scalp_tp: number | null; scalp_sl: number | null;
  }> = [];
  let overseasTotalInvested = 0;
  let overseasMarketValueUsd = 0;
  let overseasCash = 0;
  let osCashAge = Infinity; // 스테일 가드용: overseas_state.cash 경과 초 (try 블록 밖 선언)
  try {
    const pfx = viewIsPaper ? 'p_' : 'l_';

    // Paper: orders 기반 실시간 계산 (USD), Live: DB에서 KRW 읽기
    const { rows: osRows } = await safeQuery(
      'SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1', [viewIsPaper]);
    if (viewIsPaper) {
      overseasCash = await computePaperCash(); // USD (결정론적 — orders 기반)
    } else {
      const { rows: osCashRows } = await safeQuery(
        `SELECT value, EXTRACT(EPOCH FROM (NOW() - COALESCE(updated_at, NOW() - INTERVAL '999 hours'))) AS age_sec
         FROM overseas_state WHERE key = 'cash'`);
      osCashAge = osCashRows.length > 0 ? Number(osCashRows[0].age_sec) : Infinity;
      overseasCash = osCashRows.length > 0 ? Number(osCashRows[0].value) : 0; // KRW
    }

    // 종목별 고점/부분익절단계/동적TP·SL 일괄 조회
    const codes = osRows.map((r: any) => String(r.stock_code));
    const stateKeys = codes.flatMap(c => [
      `${pfx}maxprice_${c}`, `${pfx}partial_tp_stage_${c}`, `${pfx}dynamic_tpsl_${c}`,
    ]);
    const stateMap = new Map<string, string>();
    if (stateKeys.length > 0) {
      const { rows: stRows } = await safeQuery(
        'SELECT key, value FROM overseas_state WHERE key = ANY($1)', [stateKeys]);
      for (const sr of stRows) stateMap.set(sr.key, sr.value);
    }

    // last_price=0인 종목: 인메모리 캐시 → KIS API 조회 (최대 3종목)
    const needPrice = osRows.filter((r: any) => Number(r.last_price ?? 0) <= 0).slice(0, 3);
    for (const r of needPrice) {
      // 인메모리 캐시 우선 조회 (Paper/Live 공통)
      const memP = cacheGet<{ price: number }>(`overseas:lastprice:${r.stock_code}`)?.price ?? 0;
      if (memP > 0) { r.last_price = memP; continue; }
      // Live 모드: KIS API 폴백
      if (!viewIsPaper) {
        try {
          const p = await withTimeout(getOverseasPrice(String(r.stock_code), String(r.exchange)), 3000, null as any);
          if (p?.currentPrice > 0) {
            r.last_price = p.currentPrice;
            safeQuery(
              'UPDATE overseas_holdings SET last_price = $1, last_price_at = NOW() WHERE stock_code = $2 AND is_paper = false',
              [p.currentPrice, r.stock_code],
            ).catch(() => {});
          }
        } catch { /* 시세 조회 실패 시 기존 폴백 사용 */ }
      }
    }

    for (const r of osRows) {
      const code = String(r.stock_code);
      const qty = Number(r.quantity);
      const avgP = Number(r.avg_price);
      // last_price 우선순위: DB last_price → 인메모리 가격 캐시 → avg_price 폴백
      const dbLastP = Number(r.last_price ?? 0);
      const memPrice = cacheGet<{ price: number }>(`overseas:lastprice:${code}`)?.price ?? 0;
      const lastP = dbLastP > 0 ? dbLastP : (memPrice > 0 ? memPrice : avgP);
      const curP = lastP;
      overseasTotalInvested += avgP * qty;
      overseasMarketValueUsd += curP * qty;

      const wItem = GLOBAL_WATCHLIST.find(w => w.code === code);
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
          } catch { /* skip */ }
        }
      }
      // 섹터 기반 폴백 SL (동적 값 없을 때만)
      const fallbackSl = isHighBeta ? -8.0 : isMediumBeta ? -5.0 : isDefense ? -4.0 : -5.0;
      const baseSl = dynSl != null && isFinite(dynSl) ? dynSl : fallbackSl;

      // ── 부분익절 단계: risk-intelligence.ts 함수 사용 (동기화) ──
      const partialStageNum = Number(stateMap.get(`${pfx}partial_tp_stage_${code}`) ?? 0);
      const tpStages = getPartialTpStages(sector);
      // 다음 부분익절 목표
      const nextPartialStage = tpStages.find(s => s.stage > partialStageNum);
      const nextPartialTpPct = nextPartialStage?.triggerPct ?? null;
      // 동적 Hard TP (매매엔진 값 우선, 없으면 섹터 기반 폴백)
      const fallbackHardTp = isHighBeta ? 25.0 : isDefense ? 18.0 : 20.0;
      const hardTp = dynTp != null && isFinite(dynTp) ? dynTp : fallbackHardTp;
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
      const trailStopPct = trailActive && maxPrice > 0 && avgP > 0
        ? ((maxPrice * (1 + dynTrailDrop / 100) - avgP) / avgP) * 100
        : baseSl;
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
  } catch { /* overseas table may not exist */ }

  // ── 국내 + 해외 합산 ──
  let FX_RATE = await getFxRate();
  if (FX_RATE <= 0) FX_RATE = 1420; // 비상 폴백 (환율 조회 실패 시)
  const overseasInvestedKrw = (isNaN(overseasTotalInvested) ? 0 : overseasTotalInvested) * FX_RATE;
  const overseasMarketValueKrw = (isNaN(overseasMarketValueUsd) ? 0 : overseasMarketValueUsd) * FX_RATE;

  // overseas_state: Live=KRW 저장, Paper=USD 저장 → 통합증거금 KRW 변환
  const rawOverseasCash = isNaN(overseasCash) ? 0 : overseasCash;
  const overseasCashKrw = viewIsPaper ? rawOverseasCash * FX_RATE : rawOverseasCash;

  // ── KIS 권위 데이터 (실전모드: 체인 DB 대신 KIS 실계좌 수치 사용) ──
  const kisDomEval = balance.totalEvalAmount ?? 0;       // 국내 증권 시가평가 (KIS)
  const kisPurchaseCost = (balance as any).purchaseCost ?? 0; // 국내 매입원가 (KIS)

  // 국내 투자원가: Live=KIS purchaseCost 우선
  const domesticInvested = !viewIsPaper && kisPurchaseCost > 0
    ? kisPurchaseCost : (totalInvested || 0);
  // 국내 시가평가: Live=KIS totalEvalAmount 우선 (DB 체인보다 KIS가 정확)
  const domesticMarketValue = !viewIsPaper && kisDomEval > 0
    ? kisDomEval : (totalChainInvested + totalChainPnl);

  // ══ 통합증거금: 현금 계산 ══
  if (viewIsPaper) {
    // Paper: 국내 현금(rawCash) + 해외 현금(USD→KRW) = 통합 현금
    actualCash = (actualCash || 0) + overseasCashKrw;
  } else {
    // Live: overseas_state.cash 우선 (KIS psamount 기반, KRW)
    // 스테일 가드: 6시간 초과 시 국내 잔고 API 폴백, 없으면 overseas_state 유지
    const STALE_SEC = 6 * 60 * 60;
    if (overseasCashKrw > 0 && osCashAge < STALE_SEC) {
      actualCash = overseasCashKrw;
    } else if (rawCash > 0) {
      actualCash = rawCash;
      if (overseasCashKrw > 0 && osCashAge >= STALE_SEC) {
        logger.warn(`대시보드: overseas_state.cash 스테일 (${Math.round(osCashAge / 60)}분) → 국내 잔고 API 폴백`, { component: 'DASHBOARD' });
      }
    } else if (overseasCashKrw > 0) {
      // 스테일이지만 다른 소스 없음 → overseas_state 값 그대로 사용 (0보다 나음)
      actualCash = overseasCashKrw;
    } else {
      // 전부 실패 → netAsset 기반 추정
      const netAsset = (balance as any).netAsset ?? 0;
      if (netAsset > 0) {
        actualCash = Math.max(0, netAsset - domesticMarketValue);
        if (overseasInvestedKrw > 0) {
          actualCash = Math.max(0, actualCash - overseasInvestedKrw);
        }
      }
    }
  }

  // 총자산 = 통합현금 + 국내 시가 + 해외 시가 (NaN 가드)
  const safeCash = isNaN(actualCash) || !actualCash ? 0 : actualCash;
  const safeDomestic = isNaN(domesticMarketValue) ? 0 : domesticMarketValue;
  const safeOverseasMV = isNaN(overseasMarketValueKrw) ? 0 : overseasMarketValueKrw;
  const grandTotalValue = safeCash + safeDomestic + safeOverseasMV;

  // 비중(weight) 계산 — grandTotalValue 기준 시가 기반 통합 비중
  for (const ch of enrichedChains as any[]) {
    const marketVal = ch.currentPrice > 0
      ? ch.currentPrice * Number(ch.total_quantity || 0)
      : ch.invested; // 시세 없으면 원가 폴백
    ch.weight = grandTotalValue > 0 ? Math.round((marketVal / grandTotalValue) * 1000) / 10 : 0;
  }
  for (const h of overseasHoldings as any[]) {
    const marketKrw = (h.last_price * h.quantity) * FX_RATE;
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
    const totalInv = group.reduce((s: number, c: any) => s + (c.invested || 0), 0);
    const weightedAvg = totalQty > 0 ? totalInv / totalQty : 0;
    const cp = primary.currentPrice;
    const mergedPnl = cp > 0 ? (cp - weightedAvg) * totalQty : 0;
    const mergedPnlPct = cp > 0 && weightedAvg > 0 ? ((cp - weightedAvg) / weightedAvg) * 100 : 0;
    const totalWeight = group.reduce((s: number, c: any) => s + (c.weight || 0), 0);
    return {
      ...primary,
      avg_buy_price: weightedAvg,
      total_quantity: totalQty,
      invested: totalInv,
      unrealizedPnl: mergedPnl,
      unrealizedPnlPct: mergedPnlPct,
      weight: totalWeight,
      status: group.some((c: any) => c.status === 'PROFIT_TAKING') ? 'PROFIT_TAKING' : primary.status,
      chainIds: group.map((c: any) => c.id),
      _mergedCount: group.length,
    };
  });

  const grandTotalInvested = domesticInvested + overseasInvestedKrw;

  // 통합증거금: 현금은 하나 (Live/Paper 모두 portfolio.cash = overseas.cashKrw = 동일)
  const unifiedCash = Math.round(actualCash);
  const unifiedCashUsd = FX_RATE > 0 ? Math.round((actualCash / FX_RATE) * 100) / 100 : 0;

  const dashPayload = {
    portfolio: {
      totalValue: Math.round(grandTotalValue),
      cash: unifiedCash,
      invested: Math.round(grandTotalInvested),
      domesticInvested: Math.round(domesticInvested),
      domesticEval: Math.round(domesticMarketValue), // 국내 증권 시가평가 (비중 계산용)
      domesticCash: unifiedCash, // 통합증거금: 국내/해외 구분 없음
      unrealizedPnl: Math.round(viewIsPaper ? totalChainPnl : (balance.totalProfitLoss || totalChainPnl)), // 국내 전용 (해외는 overseas.unrealizedPnlKrw)
      realizedPnl: viewIsPaper ? Math.round(balance.totalProfitLoss ?? 0) : 0,
      pnl: Math.round(totalPnl + (isNaN(overseasMarketValueKrw - overseasInvestedKrw) ? 0 : (overseasMarketValueKrw - overseasInvestedKrw))),
      pnlPct: Math.round(totalPnlPct * 100) / 100,
      positions: balance.positions ?? [],
    },
    overseas: {
      holdings: overseasHoldings,
      totalInvestedUsd: overseasTotalInvested,
      totalInvestedKrw: overseasInvestedKrw,
      totalMarketValueUsd: overseasMarketValueUsd,
      totalMarketValueKrw: overseasMarketValueKrw,
      unrealizedPnlKrw: Math.round(overseasMarketValueKrw - overseasInvestedKrw),
      unrealizedPnlPct: overseasInvestedKrw > 0 ? Math.round((overseasMarketValueKrw - overseasInvestedKrw) / overseasInvestedKrw * 10000) / 100 : 0,
      cashUsd: unifiedCashUsd,
      cashKrw: unifiedCash, // 통합증거금: cash = 주문가능원화
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
    killSwitch: getKillSwitchStatusAll(),
    cooldown: await getCooldownStatus().catch(() => ({ active: false, consecutive: 0, remainingMinutes: 0, reason: '' })),
    tradingMode: config.tradingMode,
    viewMode: viewIsPaper ? 'paper' : 'live',
    riskLimits: (() => {
      // 통합증거금: 전체 포트폴리오 기준 일일손실한도
      const limit = calcDailyLossLimit(Math.round(grandTotalValue));
      // 해외: 현금(KRW) + 보유종목 시가평가(KRW) 기준
      const osPortfolioKrw = (actualCash || 0) + (isNaN(overseasMarketValueKrw) ? 0 : overseasMarketValueKrw);
      const osPortfolioUsd = FX_RATE > 0 ? osPortfolioKrw / FX_RATE : 0;
      return {
        maxDailyDrawdownKrw: limit.limitAmount,
        dailyDrawdownPct: limit.pct,
        basis: limit.basis,
        overseasLimitUsd: Math.round(osPortfolioUsd * 0.30),
        overseasBasisUsd: Math.round(osPortfolioUsd),
      };
    })(),
    insights: insightRows.rows,
    defensePark,

    // ── 오늘의 추천 액션 ──
    suggestedActions: (() => {
      const actions: Array<{ type: string; priority: 'high' | 'medium' | 'low'; message: string; detail?: string }> = [];

      // 해외 보유종목: 부분익절 임박 + 트레일링 스톱 알림 (단일 루프)
      for (const h of overseasHoldings as any[]) {
        if (h.last_price <= 0 || h.avg_price <= 0) continue;
        const curPnlPct = ((h.last_price - h.avg_price) / h.avg_price) * 100;

        if (h.next_partial_tp_pct != null) {
          const gap = h.next_partial_tp_pct - curPnlPct;
          if (gap > 0 && gap <= 3) {
            actions.push({
              type: 'partial_tp_near',
              priority: 'high',
              message: `${h.stock_code} 부분익절 ${h.partial_tp_stage + 1}단계 임박`,
              detail: `현재 +${curPnlPct.toFixed(1)}% → 목표 +${h.next_partial_tp_pct}% (${gap.toFixed(1)}% 남음)`,
            });
          }
        }

        if (h.trail_active) {
          actions.push({
            type: 'trail_active',
            priority: 'medium',
            message: `${h.stock_code} 트레일링 스톱 가동 중`,
            detail: `고점 대비 +${h.max_pnl_pct.toFixed(1)}% / 현재 +${curPnlPct.toFixed(1)}% / 스톱 ${h.trail_stop_pct.toFixed(1)}%`,
          });
        }
      }

      // 현금 비중 과다 (60%↑) → 투자 여력 있음
      const cashRatio = grandTotalValue > 0 ? ((actualCash || 0) / grandTotalValue) * 100 : 0;
      if (cashRatio > 60 && grandTotalValue > 100000) {
        actions.push({
          type: 'high_cash',
          priority: 'low',
          message: `현금 비중 ${Math.round(cashRatio)}% — 자동매매가 기회 탐색 중`,
          detail: `유휴 자금 ₩${Math.round(actualCash || 0).toLocaleString()} 대기`,
        });
      }

      // 국내 체인 중 큰 손실 종목 경고
      for (const ch of displayChains as any[]) {
        const pnlPct = ch.unrealizedPnlPct ?? 0;
        if (pnlPct < -10) {
          actions.push({
            type: 'deep_loss',
            priority: 'high',
            message: `${ch.stock_name || ch.stock_code} 손실 ${pnlPct.toFixed(1)}%`,
            detail: '자동 손절 조건 모니터링 중',
          });
        }
      }

      return actions.slice(0, 8);
    })(),

    // ── 월간 목표 진행률 ──
    monthlyGoal: (() => {
      const monthlyTargetPct = 50; // 월 50% 목표 (6Phase 업그레이드 후 공격적 타겟)
      const seedKr = grandTotalValue > 0 ? grandTotalValue : 10_000_000;
      const targetAmount = Math.round(seedKr * monthlyTargetPct / 100);
      const overseasUnrealizedForGoal = isNaN(overseasMarketValueKrw - overseasInvestedKrw) ? 0 : (overseasMarketValueKrw - overseasInvestedKrw);
      const currentPnl = Math.round(totalPnl + overseasUnrealizedForGoal);
      const progressPct = targetAmount > 0 ? Math.min(200, Math.round((currentPnl / targetAmount) * 100)) : 0;
      return {
        targetPct: monthlyTargetPct,
        targetAmount,
        currentPnl,
        progressPct,
        remaining: Math.max(0, targetAmount - currentPnl),
      };
    })(),

    // ── 환율 영향 분석 ──
    fxImpact: (() => {
      if (overseasTotalInvested <= 0 || FX_RATE <= 0) return null;
      const impactPer10Won = Math.round(overseasMarketValueUsd * 10); // ₩10 변동 시 원화 영향
      const overseasPnlUsd = overseasMarketValueUsd - overseasTotalInvested;
      const overseasPnlKrw = Math.round(overseasPnlUsd * FX_RATE);
      return {
        fxRate: FX_RATE,
        exposureUsd: Math.round(overseasMarketValueUsd * 100) / 100,
        exposureKrw: Math.round(overseasMarketValueUsd * FX_RATE),
        impactPer10Won,
        overseasPnlUsd: Math.round(overseasPnlUsd * 100) / 100,
        overseasPnlKrw,
      };
    })(),
  };
  return dashPayload;
}
