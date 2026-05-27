/**
 * 대시보드 페이로드 빌더 — buildDashPayload + getOrBuildDashPayload
 */
import { getCachedScores, getScoresWithFallback, cachePrice, getLastKnownPrices } from '../../../cache/redis.js';
import { cachePriceMemory, getLastKnownPricesMemory, getCachedPriceMemory } from '../../../cache/memory.js';
import { config, baseIsPaper } from '../../../config/index.js';
import { getActiveStrategy, getActiveWatchlist, getOpenChains, getPool, getTodayStartSnapshot } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import { getCurrentPrice, getBatchPrices, isMarketOpen } from '../../../kis/market.js';
import { getDefenseParkState } from '../../../ai/track-b/defense-park.js';
import { getPaperBalance } from '../../../risk/engine.js';
import { PAPER_INITIAL_CAPITAL } from '../../../risk/paper-balance.js';
import { getKillSwitchStatusAll } from '../../../risk/kill-switch.js';
import { calcDailyLossLimit } from '../../../risk/seed-capital.js';
import { getCooldownStatus } from '../../../risk/trade-gate.js';
import { getOverseasScores } from '../../../cache/overseas-scores.js';
import { SECTOR_CLASS } from '../../../config/constants.js';
import { GLOBAL_WATCHLIST } from '../../../scheduler/overseas/watchlist.js';
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

  const balanceFn = viewIsPaper ? getPaperBalance : () => getAccountBalance(true);
  const [balanceResult, chains, strategy, insightRows, defensePark] = await Promise.all([
    balanceFn().catch(() => defaultBalance),
    getOpenChains(viewIsPaper).catch(() => []),
    getActiveStrategy().catch(() => null),
    getPool().query(
      `SELECT id, category, insight, confidence, sample_count, last_updated, is_manual,
              recommendation, param_change, is_applied, applied_at, is_paper
       FROM learned_insights ORDER BY is_manual DESC, confidence DESC LIMIT 30`
    ).catch(() => ({ rows: [] as any[] })),
    getDefenseParkState().catch(() => ({ isActive: false, parkStockCode: '069500', parkStockName: 'KODEX 200', entryReason: null, enteredAt: null })),
  ]);
  const balance = balanceResult ?? defaultBalance;

  const watchlist = await getActiveWatchlist().catch(() => []);
  const stockCodes = watchlist.map((w) => w.stock_code);

  const scores = await getScoresWithFallback(stockCodes);

  // chains + scores에 현재가 매칭 — KIS API 우선 (신선한 가격), 실패 시 캐시 폴백
  const posMap = new Map((balance.positions ?? []).map((p: any) => [p.stockCode, p]));
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

  // 실제 API 호출 대상: 포지션 종목(chain) + 이름 미확인 + 캐시 없는 score(최대 10개)
  const chainNeedingPrice = chainCodes.filter(c => !priceMap.has(c));
  const codesToFetch = [...new Set([
    ...chainNeedingPrice,
    ...needNameCodes,
    ...scoreCodesNeedingPrice.slice(0, 10),
  ])];

  // 병렬 배치 조회 (체인+이름보정 위주 — 대폭 축소)
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
    totalInvested = balance.totalEvalAmount ?? 0;
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
  try {
    const isPaperQuery = viewIsPaper;
    const osCashKey = viewIsPaper ? 'cash_paper' : 'cash';
    const pfx = viewIsPaper ? 'p_' : 'l_';
    const { rows: osRows } = await getPool().query(
      'SELECT * FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1', [isPaperQuery]);
    const { rows: osCashRows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = $1", [osCashKey]);
    overseasCash = osCashRows.length > 0 ? Number(osCashRows[0].value) : (viewIsPaper ? 10000 : 0);

    // 종목별 고점/부분익절단계 일괄 조회
    const codes = osRows.map((r: any) => String(r.stock_code));
    const stateKeys = codes.flatMap(c => [`${pfx}maxprice_${c}`, `${pfx}partial_tp_stage_${c}`]);
    const stateMap = new Map<string, string>();
    if (stateKeys.length > 0) {
      const { rows: stRows } = await getPool().query(
        'SELECT key, value FROM overseas_state WHERE key = ANY($1)', [stateKeys]);
      for (const sr of stRows) stateMap.set(sr.key, sr.value);
    }

    for (const r of osRows) {
      const code = String(r.stock_code);
      const qty = Number(r.quantity);
      const avgP = Number(r.avg_price);
      const lastP = Number(r.last_price ?? 0);
      const curP = lastP > 0 ? lastP : avgP;
      overseasTotalInvested += avgP * qty;
      overseasMarketValueUsd += (lastP > 0 ? lastP : avgP) * qty;

      const wItem = GLOBAL_WATCHLIST.find(w => w.code === code);
      const sector = wItem?.sector ?? '';
      const isHighBeta = SECTOR_CLASS.HIGH_BETA.includes(sector);
      const isMediumBeta = SECTOR_CLASS.MEDIUM_BETA.includes(sector);
      const isDefense = SECTOR_CLASS.DEFENSE.includes(sector);

      // ── 동적 SL: ATR 기반 (overseas_state에 저장안됨 → 섹터/변동성 기반 추정) ──
      // 현재 변동성 = abs(pnlPct) 반영하여 유연하게 설정
      const pnlPct = avgP > 0 ? ((curP - avgP) / avgP) * 100 : 0;
      const baseSl = isHighBeta ? -8.0 : isMediumBeta ? -5.0 : isDefense ? -4.0 : -5.0;

      // ── 동적 TP: 부분익절 3단계 기반 실제 다음 목표 ──
      const partialStageNum = Number(stateMap.get(`${pfx}partial_tp_stage_${code}`) ?? 0);
      // 부분익절 단계별 트리거 (risk-intelligence.ts와 동일)
      const tpStages = isHighBeta
        ? [{ stage: 1, pct: 8.0 }, { stage: 2, pct: 15.0 }]
        : [{ stage: 1, pct: 6.0 }, { stage: 2, pct: 12.0 }];
      const hardTp = isHighBeta ? 20.0 : 15.0;
      // 다음 부분익절 목표
      const nextPartialStage = tpStages.find(s => s.stage > partialStageNum);
      const nextPartialTpPct = nextPartialStage?.pct ?? null;
      // 실질적 TP = 부분익절을 이미 달성했으면 다음 단계, 아니면 1단계 목표
      const effectiveTpPct = nextPartialTpPct ?? hardTp;

      // ── 트레일링 스톱 계산 (고점 추적 데이터 활용) ──
      const maxPrice = Number(stateMap.get(`${pfx}maxprice_${code}`) ?? 0);
      const maxPnlPct = maxPrice > 0 && avgP > 0 ? ((maxPrice - avgP) / avgP) * 100 : 0;
      const trailActivatePct = isHighBeta ? 10.0 : isMediumBeta ? 8.0 : 5.0;
      const trailActive = maxPnlPct >= trailActivatePct;
      // ATR 동적 트레일 드랍 (sell-logic과 동일한 공식, ATR 기본 2.0%)
      const estAtr = isHighBeta ? 3.0 : isDefense ? 1.2 : 2.0;
      const atrTrail = -(estAtr * 2.5);
      const minTrail = isHighBeta ? -12.0 : isDefense ? -6.0 : -8.0;
      const maxTrail = isHighBeta ? -5.0 : isDefense ? -3.0 : -4.0;
      const dynTrailDrop = Math.max(minTrail, Math.min(maxTrail, atrTrail));
      // 트레일링 활성 시: 고점 대비 dynTrailDrop% = 매도, 이를 평단 기준 %로 변환
      const trailStopPct = trailActive && maxPrice > 0 && avgP > 0
        ? ((maxPrice * (1 + dynTrailDrop / 100) - avgP) / avgP) * 100
        : baseSl;
      // 실질 SL = 트레일링 활성이면 트레일스톱, 아니면 고정 SL
      const effectiveSlPct = trailActive ? Math.max(trailStopPct, baseSl) : baseSl;

      overseasHoldings.push({
        stock_code: code,
        quantity: qty,
        avg_price: avgP,
        bought_at: r.bought_at,
        last_price: lastP,
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
  const FX_RATE = await getFxRate();
  const overseasInvestedKrw = (isNaN(overseasTotalInvested) ? 0 : overseasTotalInvested) * FX_RATE;
  const overseasMarketValueKrw = (isNaN(overseasMarketValueUsd) ? 0 : overseasMarketValueUsd) * FX_RATE;

  // overseas_state: Live=KRW 저장, Paper=USD 저장 → 통합증거금 KRW 변환
  const rawOverseasCash = isNaN(overseasCash) ? 0 : overseasCash;
  const overseasCashKrw = viewIsPaper ? rawOverseasCash * FX_RATE : rawOverseasCash;

  const domesticInvested = totalInvested || 0;
  // 국내 시가평가 = 원가 + 미실현손익 (원가만 쓰면 수익/손실 반영 안 됨)
  const domesticMarketValue = totalChainInvested + totalChainPnl;

  // ══ 통합증거금: 국내+해외 단일 원화 풀 (Live/Paper 동일 구조) ══
  if (viewIsPaper) {
    // Paper: 국내 현금(rawCash) + 해외 현금(USD→KRW) = 통합 현금
    actualCash = (actualCash || 0) + overseasCashKrw;
  } else if (overseasCashKrw > 0) {
    // Live: overseas_state.cash(KRW) = KIS 주문가능원화 (해외투자 차감 완료)
    actualCash = overseasCashKrw;
  } else {
    // Live 초기: reconciliation 미실행 시 폴백
    const netAsset = (balance as any).netAsset ?? 0;
    if (netAsset > 0 && domesticInvested > 0) {
      actualCash = Math.max(0, netAsset - domesticInvested);
    }
    if (overseasInvestedKrw > 0) {
      actualCash = Math.max(0, actualCash - overseasInvestedKrw);
    }
  }

  // 총자산 = 통합현금 + 국내 시가 + 해외 시가 (모드 무관 동일 공식)
  const grandTotalValue = (actualCash || 0) + domesticMarketValue + overseasMarketValueKrw;

  // 비중(weight) 계산 — grandTotalValue 기준 통합 비중
  for (const ch of enrichedChains as any[]) {
    ch.weight = grandTotalValue > 0 ? Math.round((ch.invested / grandTotalValue) * 1000) / 10 : 0;
  }
  for (const h of overseasHoldings as any[]) {
    const investedKrw = (h.avg_price * h.quantity) * FX_RATE;
    h.weight = grandTotalValue > 0 ? Math.round((investedKrw / grandTotalValue) * 1000) / 10 : 0;
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

  const grandTotalInvested = totalChainInvested + overseasInvestedKrw;

  // 통합증거금: 현금은 하나 (Live/Paper 모두 portfolio.cash = overseas.cashKrw = 동일)
  const unifiedCash = Math.round(actualCash);
  const unifiedCashUsd = FX_RATE > 0 ? Math.round((actualCash / FX_RATE) * 100) / 100 : 0;

  const dashPayload = {
    portfolio: {
      totalValue: Math.round(grandTotalValue),
      cash: unifiedCash,
      invested: Math.round(grandTotalInvested),
      domesticInvested: Math.round(totalChainInvested),
      domesticCash: unifiedCash, // 통합증거금: 국내/해외 구분 없음
      unrealizedPnl: Math.round(viewIsPaper ? totalChainPnl : (balance.totalProfitLoss || totalChainPnl)),
      realizedPnl: viewIsPaper ? Math.round(balance.totalProfitLoss ?? 0) : 0,
      pnl: Math.round(totalPnl),
      pnlPct: Math.round(totalPnlPct * 100) / 100,
      positions: balance.positions ?? [],
    },
    overseas: {
      holdings: overseasHoldings,
      totalInvestedUsd: overseasTotalInvested,
      totalInvestedKrw: overseasInvestedKrw,
      totalMarketValueUsd: overseasMarketValueUsd,
      totalMarketValueKrw: overseasMarketValueKrw,
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
  };
  return dashPayload;
}
