'use client';

import React from 'react';
import type { Dashboard, Health, KillSwitch, Trade, UsDashboard, WithdrawConfig, WatchlistItem, Strategy, AllocConfig, ViewMode, ToastFn, ConfirmFn, UsHolding, UsWatchlistItem, Chain, MpData, SystemEvent, TradingStatus, AiStatus, LoopStatus, TodayStats } from '../types';
import { api, fmtWon, pc, FALLBACK_FX_RATE, toKST, getKSTMinutes } from '../lib/utils';
import { useCountUp } from '../lib/hooks';
import { toDisplayName } from '../lib/helpers';
import MoneyStatsPanel from '../panels/MoneyStatsPanel';
import { RiskGaugePanel, PnlBreakdownPanel, PerformanceVsKospiPanel, ShortSellingPanel, CorrelationWarningPanel, HighScannerPanel, SectorHeatmapPanel, TaxEstimatePanel } from '../panels/SmallPanels';
import OverseasScorePanel from '../panels/OverseasScorePanel';
import AiTransparencyPanel from '../panels/AiTransparencyPanel';
import PerformancePanel from '../panels/PerformancePanel';
import InsightsPanel from '../panels/InsightsPanel';
import InvestorFlowPanel from '../panels/InvestorFlowPanel';

// SSE 가격 틱(3초)마다 불필요한 리렌더 방지 — props 변경 없으면 skip
const MemoMoneyStats = React.memo(MoneyStatsPanel);
const MemoRiskGauge = React.memo(RiskGaugePanel);
const MemoPnlBreakdown = React.memo(PnlBreakdownPanel);
const MemoPerformanceVsKospi = React.memo(PerformanceVsKospiPanel);
const MemoShortSelling = React.memo(ShortSellingPanel);
const MemoCorrelation = React.memo(CorrelationWarningPanel);
const MemoHighScanner = React.memo(HighScannerPanel);
const MemoSectorHeatmap = React.memo(SectorHeatmapPanel);
const MemoTaxEstimate = React.memo(TaxEstimatePanel);
const MemoAiTransparency = React.memo(AiTransparencyPanel);
const MemoPerformance = React.memo(PerformancePanel);
const MemoInsights = React.memo(InsightsPanel);
const MemoInvestorFlow = React.memo(InvestorFlowPanel);
const MemoOverseasScore = React.memo(OverseasScorePanel);
import { Panel } from '@/components/ui';
import StatusBanners from './home/StatusBanners';
import PortfolioSection from './home/PortfolioSection';
import MarketProgressBar from './home/MarketProgressBar';
import HeroPnlCard from './home/HeroPnlCard';
import KrHoldingsTab from './home/KrHoldingsTab';
import UsHoldingsTab from './home/UsHoldingsTab';
import RecentTradesPanel from './home/RecentTradesPanel';
import KrAiScorePanel from './home/KrAiScorePanel';
import SuggestedActionsPanel from '../panels/SuggestedActionsPanel';

interface HomeViewProps {
  dash: Dashboard | null;
  health: Health | null;
  killSwitch: KillSwitch | null;
  trades: Trade[];
  usDash: UsDashboard | null;
  withdrawConfig: WithdrawConfig | null;
  watchlist: WatchlistItem[];
  strategy: Strategy | null;
  setStrategy: (s: Strategy) => void;
  toast: ToastFn;
  confirm: ConfirmFn;
  onRefresh: (forceStatic?: boolean) => void;
  allocConfig: AllocConfig | null;
  setAllocConfig: (c: AllocConfig) => void;
  onGoToSettings: () => void;
  viewMode?: ViewMode;
  onMarketTabChange?: (tab: 'KR' | 'US') => void;
  mpData: MpData | null;
  loopStatus?: LoopStatus | null;
  todayStats?: TodayStats | null;
  tradingStatus?: TradingStatus | null;
  aiStatus?: AiStatus | null;
}

function HomeView({ dash, health, killSwitch, trades, usDash, withdrawConfig, watchlist, strategy, setStrategy, toast, confirm, onRefresh, allocConfig, setAllocConfig, onGoToSettings, viewMode = 'live', onMarketTabChange, mpData, loopStatus, todayStats, tradingStatus: tradingStatusProp, aiStatus: aiStatusProp }: HomeViewProps) {
  const [holdingsTab, setHoldingsTab] = React.useState<'KR' | 'US'>('KR');
  const [userPickedTab, setUserPickedTab] = React.useState(false);
  const [usInsights, setUsInsights] = React.useState('');
  const [insightsDraft, setInsightsDraft] = React.useState('');
  const [insightsSaving, setInsightsSaving] = React.useState(false);
  // tradingStatus/aiStatus: hook(폴링)에서 내려오는 prop 우선, 로컬 초기 fetch는 폴백
  const [localTradingStatus, setLocalTradingStatus] = React.useState<TradingStatus | null>(null);
  const [localAiStatus, setLocalAiStatus] = React.useState<AiStatus | null>(null);
  const tradingStatus = tradingStatusProp ?? localTradingStatus;
  const aiStatus = aiStatusProp ?? localAiStatus;
  const [privacyMode, setPrivacyMode] = React.useState(false);
  const [showAllKRScores, setShowAllKRScores] = React.useState(false);
  const [expandedTradeIdx, setExpandedTradeIdx] = React.useState<number | null>(null);
  const [buyingStock, setBuyingStock] = React.useState<string | null>(null);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [favorites, setFavorites] = React.useState<Set<string>>(new Set());
  const [blacklist, setBlacklist] = React.useState<Set<string>>(new Set());
  const busyRef = React.useRef<string | null>(null);
  const logContainerRef = React.useRef<HTMLDivElement>(null);
  const firstLogTs = health?.recentEvents?.[0]?.timestamp ?? '';
  React.useEffect(() => {
    const el = logContainerRef.current;
    if (!el) return;
    // 사용자가 이미 아래로 스크롤 중이면 강제 리셋 하지 않음
    if (el.scrollTop < 48) el.scrollTop = 0;
  }, [firstLogTs]);
  const guard = React.useCallback((key: string, fn: () => Promise<void>) => {
    return async () => {
      if (busyRef.current) return;
      busyRef.current = key;
      setBusyAction(key);
      try { await fn(); } finally { busyRef.current = null; setBusyAction(null); }
    };
  }, []);
  React.useEffect(() => {
    api('/overseas/insights').then((r: Record<string, unknown>) => {
      if (r?.insights != null) { setUsInsights(r.insights as string); setInsightsDraft(r.insights as string); }
    }).catch(() => {});
    api(`/trading-status?viewMode=${viewMode}`).then((r: Record<string, unknown>) => setLocalTradingStatus(r)).catch(() => {});
    api('/ai-status').then((r: Record<string, unknown>) => setLocalAiStatus(r)).catch(() => {});
    api('/overseas/favorites').then((r: any) => {
      if (r?.favorites) setFavorites(new Set(r.favorites));
      if (r?.blacklist) setBlacklist(new Set(r.blacklist));
    }).catch(() => {});
  }, [viewMode]);
  const handleToggleFavorite = React.useCallback(async (code: string) => {
    try {
      const r = await api(`/overseas/favorites/toggle?viewMode=${viewMode}`, { method: 'POST', body: JSON.stringify({ code }) });
      setFavorites(prev => {
        const next = new Set(prev);
        if (r.favorite) next.add(code); else next.delete(code);
        return next;
      });
    } catch { toast?.('즐겨찾기 변경 실패', 'err'); }
  }, [toast]);
  const handleToggleBlacklist = React.useCallback(async (code: string) => {
    try {
      const r = await api(`/overseas/blacklist/toggle?viewMode=${viewMode}`, { method: 'POST', body: JSON.stringify({ code }) });
      setBlacklist(prev => {
        const next = new Set(prev);
        if (r.blacklisted) next.add(code); else next.delete(code);
        return next;
      });
      toast?.(r.blacklisted ? `${code} 블랙리스트 등록` : `${code} 블랙리스트 해제`, 'info');
    } catch { toast?.('블랙리스트 변경 실패', 'err'); }
  }, [toast]);
  React.useEffect(() => {
    if (!userPickedTab) {
      const newTab = health?.usMarketOpen ? 'US' : 'KR';
      setHoldingsTab(newTab);
      onMarketTabChange?.(newTab);
    }
  }, [health?.usMarketOpen, userPickedTab]);
  React.useEffect(() => { onMarketTabChange?.(holdingsTab); }, [holdingsTab]);

  // ── 파생값 ──
  const p = dash?.portfolio;
  const os = dash?.overseas;
  const stockNameMap = new Map((watchlist ?? []).map((w: WatchlistItem) => [w.stock_code, w.stock_name]));
  const getStockName = (code: string): string => toDisplayName(stockNameMap.get(code), code);
  const chains = dash?.chains || [];
  const usW = usDash?.watchlist || [];
  const usHoldings = (dash?.overseas?.holdings?.length ? dash.overseas.holdings : usDash?.holdings) ?? [];
  const filled = trades.filter((t: Trade) => t.status === 'FILLED' || t.status === 'PENDING')
    .sort((a: Trade, b: Trade) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const kstToday = new Date(Date.now() + 9 * 3600_000).toISOString().split('T')[0];
  const todayTrades = filled.filter((t: Trade) => new Date(new Date(t.created_at).getTime() + 9 * 3600_000).toISOString().split('T')[0] === kstToday);

  const unrealizedPnl = p?.unrealizedPnl ?? 0;
  const realizedPnl   = p?.realizedPnl ?? 0;
  const totalPnl      = p?.pnl ?? 0;
  const totalPnlPct   = p?.pnlPct ?? 0;
  const domesticInvested = p?.domesticInvested ?? 0;
  const domesticEval = p?.domesticEval ?? domesticInvested; // KIS 시가평가 (비중 계산용)
  const totalInvested    = p?.invested ?? domesticInvested;
  const overseasInvestedUsd = os?.totalInvestedUsd ?? 0;
  const overseasInvestedKrw = os?.totalInvestedKrw ?? 0;
  const overseasMarketKrw = os?.totalMarketValueKrw ?? overseasInvestedKrw;
  const overseasCashUsd = os?.cashUsd ?? 0;
  const overseasCashKrw = os?.cashKrw ?? (overseasCashUsd * (os?.fxRate ?? FALLBACK_FX_RATE));
  const fxRate = os?.fxRate ?? FALLBACK_FX_RATE;
  const dailyLossLimit = dash?.riskLimits?.maxDailyDrawdownKrw ?? 200000;
  const overseasLimitUsd = dash?.riskLimits?.overseasLimitUsd ?? 0;
  const totalValue = Number(p?.totalValue ?? 0);
  // 총현금 (비중 계산용): 국내실현금 + 해외현금
  const domesticCash = Number(p?.cash ?? 0);
  // KIS 국내 주문가능금액 (대용 포함, KIS max_buy_amt)
  const domesticOrderable = Number(p?.domesticCash ?? p?.cash ?? 0);
  // 실제 보유 증권 시가 기준 (HeroPnlCard와 동일 산식, T+1 미결제는 현금으로 분류)
  const investedPctExact = totalValue > 0
    ? Math.min(100, ((domesticEval + overseasMarketKrw) / totalValue) * 100)
    : 0;
  const cashPctExact = Math.max(0, 100 - investedPctExact);
  const investedPct = Math.round(investedPctExact);
  const overseasCashPctExact = 0; // 통합증거금: 별도 해외현금 없음

  const overseasPnlUsd = usHoldings.reduce((sum: number, h: UsHolding) => {
    const priceData = usW.find((s: UsWatchlistItem) => s.code === h.stock_code);
    const curPrice = (priceData?.price ?? 0) > 0 ? priceData!.price! : (h.last_price ?? 0);
    if (curPrice <= 0 || h.avg_price <= 0) return sum;
    return sum + (curPrice! - h.avg_price) * h.quantity;
  }, 0);
  const overseasPnlKrw = Math.round(overseasPnlUsd * fxRate);
  const showOnlyKr = holdingsTab === 'KR';
  const showOnlyUs = holdingsTab === 'US';
  // 통합증거금: 탭에 따라 해당 시장 PnL만 표시 (현금/비중은 통합)
  const combinedPnl = showOnlyKr ? unrealizedPnl : (usHoldings.length > 0 ? overseasPnlKrw : 0);
  const combinedInvested = showOnlyKr
    ? (domesticInvested > 0 ? domesticInvested : 0)
    : (overseasInvestedKrw > 0 ? overseasInvestedKrw : 0);
  const combinedPnlPct = combinedInvested > 0 ? (combinedPnl / combinedInvested) * 100 : 0;
  const hasOverseasHoldings = usHoldings.length > 0;

  // 서버 KST 기준 todayStats 우선 사용 (클라이언트 TZ 의존 제거)
  const _krTodaySells = todayTrades.filter((t: Trade) => t.side === 'SELL' && t.trigger_source !== 'OVERSEAS');
  const _krRealizedPnl = _krTodaySells.reduce((sum: number, t: Trade) => {
    if (t.realized_pnl != null) return sum + Number(t.realized_pnl);
    const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.filled_quantity ?? t.quantity) || 0;
    if (avgBuy <= 0 || filledPx <= 0 || qty <= 0) return sum;
    const grossPnl = (filledPx - avgBuy) * qty;
    return sum + grossPnl - Math.round(avgBuy * qty * 0.00015) - Math.round(filledPx * qty * 0.00195); // 수수료0.015%+거래세0.18%
  }, 0);
  const krTabPnl = todayStats ? todayStats.krRealizedPnl : _krRealizedPnl;
  const krTabHasData = todayStats ? todayStats.krSellCount > 0 : _krTodaySells.length > 0;
  const krSellsCostBasis = _krTodaySells.reduce((sum: number, t: Trade) => {
    const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
    const qty = Number(t.filled_quantity ?? t.quantity) || 0;
    return avgBuy > 0 ? sum + avgBuy * qty : sum;
  }, 0);
  const krTabPct = krSellsCostBasis > 0 ? (krTabPnl / krSellsCostBasis) * 100 : null;
  const _usTodaySells = trades.filter((t: Trade) =>
    t.status === 'FILLED' && t.side === 'SELL' && t.trigger_source === 'OVERSEAS' &&
    !/^[0-9]/.test(t.stock_code) &&
    new Date(new Date(t.created_at).getTime() + 9 * 3600_000).toISOString().split('T')[0] === kstToday
  );
  const usTodaySells = _usTodaySells;
  const _usTabPnlUsd = _usTodaySells.reduce((sum: number, t: Trade) => {
    const reasoningMatch = String(t.ai_reasoning ?? '').match(/\[avgBuy:([\d.]+)\]/);
    const avgBuy = reasoningMatch ? Number(reasoningMatch[1]) : (Number(t.transaction_chains?.avg_buy_price) || 0);
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.quantity) || 0;
    return avgBuy > 0 && filledPx > 0 ? sum + (filledPx - avgBuy) * qty : sum;
  }, 0);
  const usTabPnlUsd = todayStats ? todayStats.usRealizedPnlUsd : _usTabPnlUsd;
  const usTabPnlKrw = Math.round(usTabPnlUsd * fxRate);

  const kstNow = toKST(new Date());
  const marketStart = 9 * 60;
  const marketEnd = 15 * 60 + 30;
  const currentMin = getKSTMinutes();
  const marketProgress = health?.marketOpen ? Math.min(100, Math.max(0, ((currentMin - marketStart) / (marketEnd - marketStart)) * 100)) : 0;
  const usMarketProgress = (() => {
    const cur = currentMin;
    const adj = cur < 6 * 60 ? cur + 24 * 60 : cur;
    return Math.min(100, Math.max(0, ((adj - (23 * 60 + 30)) / (6 * 60 + 24 * 60 - (23 * 60 + 30))) * 100));
  })();
  const currentTimeStr = `${kstNow.getUTCHours().toString().padStart(2,'0')}:${kstNow.getUTCMinutes().toString().padStart(2,'0')}`;
  const defensePark = dash?.defensePark;

  const animCombined = useCountUp(combinedPnl);
  const todayRealizedPnl = krTabPnl + usTabPnlKrw;
  const todayTradesCount = todayStats ? todayStats.totalTrades : todayTrades.length;
  const animToday = useCountUp(todayRealizedPnl);

  return (
    <div className="space-y-4 sm:space-y-5">
      <StatusBanners dash={dash} busyAction={busyAction} guard={guard} toast={toast} confirm={confirm} onRefresh={onRefresh} tradingStatus={tradingStatus} aiStatus={aiStatus} defensePark={defensePark} viewMode={viewMode} />

      <SuggestedActionsPanel suggestedActions={dash?.suggestedActions} monthlyGoal={dash?.monthlyGoal} fxImpact={dash?.fxImpact} />

      <MarketProgressBar health={health} holdingsTab={holdingsTab} currentTimeStr={currentTimeStr} marketProgress={marketProgress} usMarketProgress={usMarketProgress} unrealizedPnl={unrealizedPnl} overseasPnlUsd={overseasPnlUsd} dailyLossLimit={dailyLossLimit} overseasLimitUsd={overseasLimitUsd} />

      <HeroPnlCard holdingsTab={holdingsTab} combinedPnl={combinedPnl} animCombined={animCombined} combinedPnlPct={combinedPnlPct} overseasPnlUsd={overseasPnlUsd} overseasInvestedUsd={overseasInvestedUsd} showOnlyKr={showOnlyKr} showOnlyUs={showOnlyUs} hasOverseasHoldings={hasOverseasHoldings} privacyMode={privacyMode} setPrivacyMode={setPrivacyMode} krTabHasData={krTabHasData} usTodaySells={usTodaySells} krTabPnl={krTabPnl} krTabPct={krTabPct} usTabPnlUsd={usTabPnlUsd} todayRealizedPnl={todayRealizedPnl} animToday={animToday} domesticCash={domesticCash} domesticOrderable={domesticOrderable} overseasCashUsd={overseasCashUsd} domesticInvested={domesticInvested} domesticEval={domesticEval} overseasMarketKrw={overseasMarketKrw} chainsLength={chains.length} usHoldingsLength={usHoldings.length} withdrawConfig={withdrawConfig} todayTradesLength={todayTradesCount} totalValue={totalValue} totalInvested={totalInvested} fxRate={fxRate} cashSource={dash?.cashSource} prevDayTotalValue={p?.prevDayTotalValue} dailyChangePct={p?.dailyChangePct} />

      {/* 보유종목 (국내/해외 탭) */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
        <div className="flex items-center border-b border-white/[0.04]">
          <button onClick={() => { setHoldingsTab('KR'); setUserPickedTab(true); }}
            className={`flex-1 py-2.5 px-2 sm:px-4 text-sm font-bold transition-all relative ${holdingsTab === 'KR' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-400'}`}>
            {holdingsTab === 'KR' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />}
            <div className="flex flex-col items-center gap-0.5">
              <span className="flex items-center gap-1">
                국내주식 {chains.length > 0 && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">{chains.length}</span>}
              </span>
              {krTabHasData && (
                <span className={`text-[10px] font-semibold tabular-nums leading-tight ${krTabPnl > 0 ? 'text-emerald-400' : krTabPnl < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                  {krTabPnl > 0 ? '+' : ''}{Math.round(krTabPnl).toLocaleString('ko-KR')}원{krTabPct != null ? ` (${krTabPct > 0 ? '+' : ''}${krTabPct.toFixed(1)}%)` : ''}
                </span>
              )}
            </div>
          </button>
          <button onClick={() => { setHoldingsTab('US'); setUserPickedTab(true); }}
            className={`flex-1 py-2.5 px-2 sm:px-4 text-sm font-bold transition-all relative ${holdingsTab === 'US' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-400'}`}>
            {holdingsTab === 'US' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />}
            <div className="flex flex-col items-center gap-0.5">
              <span className="flex items-center gap-1">
                해외주식 {usHoldings.length > 0 && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">{usHoldings.length}</span>}
              </span>
              {(todayStats ? todayStats.usSellCount : usTodaySells.length) > 0 && (
                <span className={`text-[10px] font-semibold tabular-nums leading-tight ${usTabPnlUsd > 0 ? 'text-emerald-400' : usTabPnlUsd < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                  {usTabPnlUsd > 0 ? '+' : ''}${usTabPnlUsd.toFixed(2)} (₩{usTabPnlKrw > 0 ? '+' : ''}{usTabPnlKrw.toLocaleString('ko-KR')})
                </span>
              )}
            </div>
          </button>
        </div>
        {holdingsTab === 'KR' && <KrHoldingsTab chains={chains} dash={dash} busyAction={busyAction} guard={guard} getStockName={getStockName} onRefresh={onRefresh} toast={toast} confirm={confirm} viewMode={viewMode} />}
        {holdingsTab === 'US' && <UsHoldingsTab usHoldings={usHoldings} usW={usW} dash={dash} busyAction={busyAction} guard={guard} onRefresh={onRefresh} toast={toast} confirm={confirm} insightsDraft={insightsDraft} setInsightsDraft={setInsightsDraft} insightsSaving={insightsSaving} setInsightsSaving={setInsightsSaving} usInsights={usInsights} setUsInsights={setUsInsights} viewMode={viewMode} loopStatus={loopStatus} favorites={favorites} blacklist={blacklist} onToggleFavorite={handleToggleFavorite} onToggleBlacklist={handleToggleBlacklist} />}
      </div>

      <MemoMoneyStats key={`${viewMode}-${holdingsTab}`} market={holdingsTab} viewMode={viewMode} totalValue={holdingsTab === 'KR' ? totalValue : undefined} />

      {(() => {
        const dailyLossPct = unrealizedPnl < 0 ? Math.min(100, Math.round((Math.abs(unrealizedPnl) / dailyLossLimit) * 100)) : 0;
        const maxInvested = chains.reduce((mx: number, ch: Chain) => Math.max(mx, Number(ch.total_invested) || 0), 0);
        const concPct = totalInvested > 0 ? Math.round((maxInvested / totalInvested) * 100) : 0;
        return <MemoRiskGauge investedPct={investedPct} dailyLossPct={dailyLossPct} concentrationPct={concPct} />;
      })()}

      <div className="grid grid-cols-1 xl:grid-cols-2 items-start gap-4 sm:gap-5">
        {holdingsTab === 'KR'
          ? <KrAiScorePanel dash={dash} showAllKRScores={showAllKRScores} setShowAllKRScores={setShowAllKRScores} buyingStock={buyingStock} setBuyingStock={setBuyingStock} busyAction={busyAction} guard={guard} getStockName={getStockName} toast={toast} confirm={confirm} viewMode={viewMode} />
          : <MemoOverseasScore usDash={usDash} toast={toast} viewMode={viewMode} />}
        <RecentTradesPanel filled={filled} holdingsTab={holdingsTab} expandedTradeIdx={expandedTradeIdx} setExpandedTradeIdx={setExpandedTradeIdx} getStockName={getStockName} />
      </div>

      <MemoPnlBreakdown chains={chains} trades={trades} />
      {holdingsTab === 'KR' && <MemoPerformanceVsKospi viewMode={viewMode} />}
      {holdingsTab === 'KR' && <MemoInvestorFlow />}
      {holdingsTab === 'KR' && <MemoShortSelling viewMode={viewMode} />}
      {holdingsTab === 'KR' && <MemoCorrelation viewMode={viewMode} />}
      {holdingsTab === 'KR' && <MemoHighScanner />}
      {holdingsTab === 'KR' && <MemoSectorHeatmap />}
      {holdingsTab === 'KR' && <MemoTaxEstimate viewMode={viewMode} />}
      <MemoAiTransparency watchlist={watchlist} tab={holdingsTab} usDash={usDash} viewMode={viewMode} />
      <MemoPerformance trades={trades} strategy={strategy} setStrategy={setStrategy} toast={toast} fxRate={fxRate} />
      <MemoInsights insights={dash?.insights ?? []} trades={trades} onRefresh={onRefresh} toast={toast} viewMode={viewMode} />

      {(health?.recentEvents?.length ?? 0) > 0 && (
        <Panel title="시스템 로그" badge={`${health!.recentEvents!.length}건`}>
          <div ref={logContainerRef} className="max-h-56 overflow-y-auto divide-y divide-slate-800/20">
            {health!.recentEvents!.map((ev: SystemEvent, i: number) => (
              <div key={ev.timestamp + ev.component + i} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ev.status === 'success' ? 'bg-emerald-400' : ev.status === 'error' ? 'bg-rose-400' : 'bg-blue-400'}`} />
                <span className="text-slate-500 shrink-0 w-12">{new Date(ev.timestamp).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                <span className="text-slate-400 font-medium shrink-0">[{ev.component}]</span>
                <span className="text-slate-300 truncate" title={ev.message}>{ev.message}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <PortfolioSection allocConfig={allocConfig} setAllocConfig={setAllocConfig} onGoToSettings={onGoToSettings} dash={dash} chains={chains} usHoldings={usHoldings} usW={usW} totalValue={totalValue} totalInvested={totalInvested} domesticInvested={domesticInvested} domesticEval={domesticEval} domesticCash={domesticCash} domesticOrderable={domesticOrderable} overseasInvestedUsd={overseasInvestedUsd} overseasInvestedKrw={overseasInvestedKrw} overseasMarketKrw={overseasMarketKrw} overseasCashUsd={overseasCashUsd} overseasCashKrw={overseasCashKrw} overseasPnlUsd={overseasPnlUsd} fxRate={fxRate} investedPctExact={investedPctExact} cashPctExact={cashPctExact} overseasCashPctExact={overseasCashPctExact} strategy={strategy} getStockName={getStockName} mpData={mpData} viewMode={viewMode} />
    </div>
  );
}

export default HomeView;
