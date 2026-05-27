'use client';

import React from 'react';
import { api, fmtWon, pc } from '../lib/utils';
import { useCountUp } from '../lib/hooks';
import { toDisplayName } from '../lib/helpers';
import MoneyStatsPanel from '../panels/MoneyStatsPanel';
import { RiskGaugePanel, PnlBreakdownPanel, PerformanceVsKospiPanel, ShortSellingPanel, CorrelationWarningPanel, HighScannerPanel, SectorHeatmapPanel, TaxEstimatePanel } from '../panels/SmallPanels';
import OverseasScorePanel from '../panels/OverseasScorePanel';
import AiTransparencyPanel from '../panels/AiTransparencyPanel';
import PerformancePanel from '../panels/PerformancePanel';
import InsightsPanel from '../panels/InsightsPanel';
import InvestorFlowPanel from '../panels/InvestorFlowPanel';
import { Panel } from '@/components/ui';
import StatusBanners from './home/StatusBanners';
import PortfolioSection from './home/PortfolioSection';
import MarketProgressBar from './home/MarketProgressBar';
import HeroPnlCard from './home/HeroPnlCard';
import KrHoldingsTab from './home/KrHoldingsTab';
import UsHoldingsTab from './home/UsHoldingsTab';
import RecentTradesPanel from './home/RecentTradesPanel';
import KrAiScorePanel from './home/KrAiScorePanel';

function HomeView({ dash, health, killSwitch, trades, usDash, withdrawConfig, watchlist, strategy, setStrategy, toast, onRefresh, allocConfig, setAllocConfig, onGoToSettings, viewMode = 'live', onMarketTabChange }: any) {
  const [holdingsTab, setHoldingsTab] = React.useState<'KR' | 'US'>('KR');
  const [userPickedTab, setUserPickedTab] = React.useState(false);
  const [usInsights, setUsInsights] = React.useState('');
  const [insightsDraft, setInsightsDraft] = React.useState('');
  const [insightsSaving, setInsightsSaving] = React.useState(false);
  const [tradingStatus, setTradingStatus] = React.useState<any>(null);
  const [aiStatus, setAiStatus] = React.useState<any>(null);
  const [privacyMode, setPrivacyMode] = React.useState(false);
  const [showAllKRScores, setShowAllKRScores] = React.useState(false);
  const [expandedTradeIdx, setExpandedTradeIdx] = React.useState<number | null>(null);
  const [buyingStock, setBuyingStock] = React.useState<string | null>(null);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const busyRef = React.useRef<string | null>(null);
  const guard = React.useCallback((key: string, fn: () => Promise<void>) => {
    return async () => {
      if (busyRef.current) return;
      busyRef.current = key;
      setBusyAction(key);
      try { await fn(); } finally { busyRef.current = null; setBusyAction(null); }
    };
  }, []);
  React.useEffect(() => {
    api('/overseas/insights').then((r: any) => {
      if (r?.insights != null) { setUsInsights(r.insights); setInsightsDraft(r.insights); }
    }).catch(() => {});
    api('/trading-status').then((r: any) => setTradingStatus(r)).catch(() => {});
    api('/ai-status').then((r: any) => setAiStatus(r)).catch(() => {});
  }, []);
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
  const stockNameMap = new Map((watchlist ?? []).map((w: any) => [w.stock_code, w.stock_name]));
  const getStockName = (code: string): string => toDisplayName(stockNameMap.get(code), code);
  const chains = dash?.chains || [];
  const usW = usDash?.watchlist || [];
  const usHoldings = usDash?.holdings || (dash?.overseas?.holdings ?? []);
  const filled = trades.filter((t: any) => t.status === 'FILLED' || (t.status === 'PENDING' && t.trigger_source === 'OVERSEAS'))
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const todayTrades = filled.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());

  const unrealizedPnl = p?.unrealizedPnl ?? 0;
  const realizedPnl   = p?.realizedPnl ?? 0;
  const totalPnl      = p?.pnl ?? 0;
  const totalPnlPct   = p?.pnlPct ?? 0;
  const domesticInvested = p?.domesticInvested ?? 0;
  const totalInvested    = p?.invested ?? domesticInvested;
  const overseasInvestedUsd = os?.totalInvestedUsd ?? 0;
  const overseasInvestedKrw = os?.totalInvestedKrw ?? 0;
  const overseasMarketKrw = os?.totalMarketValueKrw ?? overseasInvestedKrw;
  const overseasCashUsd = os?.cashUsd ?? 0;
  const overseasCashKrw = os?.cashKrw ?? (overseasCashUsd * (os?.fxRate ?? 1420));
  const fxRate = os?.fxRate ?? 1420;
  const dailyLossLimit = dash?.riskLimits?.maxDailyDrawdownKrw ?? 200000;
  const overseasLimitUsd = dash?.riskLimits?.overseasLimitUsd ?? 0;
  const totalValue = Number(p?.totalValue ?? 0);
  // 통합증거금: portfolio.cash = 통합 주문가능원화 (국내/해외 공용)
  const domesticCash = Number(p?.cash ?? 0);
  const investedPct = totalValue > 0 ? Math.round((totalInvested / totalValue) * 100) : 0;
  const investedPctExact = totalValue > 0 ? ((domesticInvested + overseasMarketKrw) / totalValue) * 100 : 0;
  // 통합증거금: 현금은 하나 (domesticCash = 통합 현금)
  const cashPctExact = totalValue > 0 ? (domesticCash / totalValue) * 100 : 0;
  const overseasCashPctExact = 0; // 통합증거금: 별도 해외현금 없음

  const overseasPnlUsd = usHoldings.reduce((sum: number, h: any) => {
    const priceData = usW.find((s: any) => s.code === h.stock_code);
    const curPrice = (priceData?.price ?? 0) > 0 ? priceData!.price : (h.last_price ?? 0);
    if (curPrice <= 0 || h.avg_price <= 0) return sum;
    return sum + (curPrice - h.avg_price) * h.quantity;
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

  const todayStr = new Date().toDateString();
  const krTodaySells = todayTrades.filter((t: any) => t.side === 'SELL' && t.trigger_source !== 'OVERSEAS');
  const krRealizedPnl = krTodaySells.reduce((sum: number, t: any) => {
    if (t.realized_pnl != null) return sum + Number(t.realized_pnl);
    const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.filled_quantity ?? t.quantity) || 0;
    if (avgBuy <= 0 || filledPx <= 0 || qty <= 0) return sum;
    const grossPnl = (filledPx - avgBuy) * qty;
    return sum + grossPnl - Math.round(avgBuy * qty * 0.00015) - Math.round(filledPx * qty * 0.00245);
  }, 0);
  const krTabPnl = krRealizedPnl;
  const krTabHasData = krTodaySells.length > 0;
  const krSellsCostBasis = krTodaySells.reduce((sum: number, t: any) => {
    const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
    const qty = Number(t.filled_quantity ?? t.quantity) || 0;
    return avgBuy > 0 ? sum + avgBuy * qty : sum;
  }, 0);
  const krTabPct = krSellsCostBasis > 0 ? (krTabPnl / krSellsCostBasis) * 100 : null;
  const usTodaySells = trades.filter((t: any) =>
    t.status === 'FILLED' && t.side === 'SELL' && t.trigger_source === 'OVERSEAS' &&
    new Date(t.created_at).toDateString() === todayStr
  );
  const usTabPnlUsd = usTodaySells.reduce((sum: number, t: any) => {
    const reasoningMatch = String(t.ai_reasoning ?? '').match(/\[avgBuy:([\d.]+)\]/);
    const avgBuy = reasoningMatch ? Number(reasoningMatch[1]) : (Number(t.transaction_chains?.avg_buy_price) || 0);
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.quantity) || 0;
    return avgBuy > 0 && filledPx > 0 ? sum + (filledPx - avgBuy) * qty : sum;
  }, 0);
  const usTabPnlKrw = Math.round(usTabPnlUsd * fxRate);

  const now = new Date();
  const marketStart = 9 * 60;
  const marketEnd = 15 * 60 + 30;
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const marketProgress = health?.marketOpen ? Math.min(100, Math.max(0, ((currentMin - marketStart) / (marketEnd - marketStart)) * 100)) : 0;
  const usMarketProgress = (() => {
    const h = now.getHours(); const m = now.getMinutes();
    const cur = h * 60 + m;
    const adj = cur < 6 * 60 ? cur + 24 * 60 : cur;
    return Math.min(100, Math.max(0, ((adj - (23 * 60 + 30)) / (6 * 60 + 24 * 60 - (23 * 60 + 30))) * 100));
  })();
  const currentTimeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
  const defensePark = dash?.defensePark;

  const animCombined = useCountUp(combinedPnl);
  const todayRealizedPnl = krTabPnl + usTabPnlKrw;
  const animToday = useCountUp(todayRealizedPnl);

  return (
    <div className="space-y-4 sm:space-y-5">
      <StatusBanners dash={dash} busyAction={busyAction} guard={guard} toast={toast} onRefresh={onRefresh} tradingStatus={tradingStatus} aiStatus={aiStatus} defensePark={defensePark} />

      <MarketProgressBar health={health} holdingsTab={holdingsTab} currentTimeStr={currentTimeStr} marketProgress={marketProgress} usMarketProgress={usMarketProgress} unrealizedPnl={unrealizedPnl} overseasPnlUsd={overseasPnlUsd} dailyLossLimit={dailyLossLimit} overseasLimitUsd={overseasLimitUsd} />

      <HeroPnlCard holdingsTab={holdingsTab} combinedPnl={combinedPnl} animCombined={animCombined} combinedPnlPct={combinedPnlPct} overseasPnlUsd={overseasPnlUsd} overseasInvestedUsd={overseasInvestedUsd} showOnlyKr={showOnlyKr} showOnlyUs={showOnlyUs} hasOverseasHoldings={hasOverseasHoldings} privacyMode={privacyMode} setPrivacyMode={setPrivacyMode} krTabHasData={krTabHasData} usTodaySells={usTodaySells} krTabPnl={krTabPnl} krTabPct={krTabPct} usTabPnlUsd={usTabPnlUsd} todayRealizedPnl={todayRealizedPnl} animToday={animToday} domesticCash={domesticCash} overseasCashUsd={overseasCashUsd} domesticInvested={domesticInvested} chainsLength={chains.length} usHoldingsLength={usHoldings.length} withdrawConfig={withdrawConfig} todayTradesLength={todayTrades.length} totalValue={totalValue} totalInvested={totalInvested} fxRate={fxRate} />

      {/* 보유종목 (국내/해외 탭) */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
        <div className="flex items-center border-b border-white/[0.04]">
          <button onClick={() => { setHoldingsTab('KR'); setUserPickedTab(true); }}
            className={`flex-1 py-3 px-4 text-sm font-bold transition-all relative ${holdingsTab === 'KR' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-400'}`}>
            {holdingsTab === 'KR' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />}
            <span className="flex items-center justify-center gap-1.5 flex-wrap">
              국내주식 {chains.length > 0 && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">{chains.length}</span>}
              {krTabHasData && <span className={`text-[10px] font-semibold ${krTabPnl > 0 ? 'text-emerald-400' : krTabPnl < 0 ? 'text-rose-400' : 'text-slate-500'}`}>{krTabPnl > 0 ? '+' : ''}{Math.round(krTabPnl).toLocaleString('ko-KR')}원{krTabPct != null ? ` (${krTabPct > 0 ? '+' : ''}${krTabPct.toFixed(2)}%)` : ''}</span>}
            </span>
          </button>
          <button onClick={() => { setHoldingsTab('US'); setUserPickedTab(true); }}
            className={`flex-1 py-3 px-4 text-sm font-bold transition-all relative ${holdingsTab === 'US' ? 'text-slate-100' : 'text-slate-500 hover:text-slate-400'}`}>
            {holdingsTab === 'US' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />}
            <span className="flex items-center justify-center gap-1.5 flex-wrap">
              해외주식 {usHoldings.length > 0 && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">{usHoldings.length}</span>}
              {usTodaySells.length > 0 && <span className={`text-[10px] font-semibold ${usTabPnlUsd > 0 ? 'text-emerald-400' : usTabPnlUsd < 0 ? 'text-rose-400' : 'text-slate-500'}`}>{usTabPnlUsd > 0 ? '+' : ''}${usTabPnlUsd.toFixed(2)} (₩{usTabPnlKrw > 0 ? '+' : ''}{usTabPnlKrw.toLocaleString('ko-KR')})</span>}
            </span>
          </button>
        </div>
        {holdingsTab === 'KR' && <KrHoldingsTab chains={chains} dash={dash} busyAction={busyAction} guard={guard} getStockName={getStockName} onRefresh={onRefresh} viewMode={viewMode} />}
        {holdingsTab === 'US' && <UsHoldingsTab usHoldings={usHoldings} usW={usW} dash={dash} busyAction={busyAction} guard={guard} onRefresh={onRefresh} toast={toast} insightsDraft={insightsDraft} setInsightsDraft={setInsightsDraft} insightsSaving={insightsSaving} setInsightsSaving={setInsightsSaving} usInsights={usInsights} setUsInsights={setUsInsights} viewMode={viewMode} />}
      </div>

      <MoneyStatsPanel key={`${viewMode}-${holdingsTab}`} market={holdingsTab} viewMode={viewMode} />

      {(() => {
        const dailyLossPct = unrealizedPnl < 0 ? Math.min(100, Math.round((Math.abs(unrealizedPnl) / dailyLossLimit) * 100)) : 0;
        const maxInvested = chains.reduce((mx: number, ch: any) => Math.max(mx, Number(ch.invested) || 0), 0);
        const concPct = totalInvested > 0 ? Math.round((maxInvested / totalInvested) * 100) : 0;
        return <RiskGaugePanel investedPct={investedPct} dailyLossPct={dailyLossPct} concentrationPct={concPct} />;
      })()}

      <div className="grid grid-cols-1 xl:grid-cols-2 items-start gap-4 sm:gap-5">
        {holdingsTab === 'KR'
          ? <KrAiScorePanel dash={dash} showAllKRScores={showAllKRScores} setShowAllKRScores={setShowAllKRScores} buyingStock={buyingStock} setBuyingStock={setBuyingStock} busyAction={busyAction} guard={guard} getStockName={getStockName} toast={toast} viewMode={viewMode} />
          : <OverseasScorePanel usDash={usDash} toast={toast} />}
        <RecentTradesPanel filled={filled} holdingsTab={holdingsTab} expandedTradeIdx={expandedTradeIdx} setExpandedTradeIdx={setExpandedTradeIdx} getStockName={getStockName} />
      </div>

      <PnlBreakdownPanel chains={chains} trades={trades} />
      {holdingsTab === 'KR' && <PerformanceVsKospiPanel viewMode={viewMode} />}
      {holdingsTab === 'KR' && <InvestorFlowPanel />}
      {holdingsTab === 'KR' && <ShortSellingPanel />}
      {holdingsTab === 'KR' && <CorrelationWarningPanel viewMode={viewMode} />}
      {holdingsTab === 'KR' && <HighScannerPanel />}
      {holdingsTab === 'KR' && <SectorHeatmapPanel />}
      {holdingsTab === 'KR' && <TaxEstimatePanel viewMode={viewMode} />}
      <AiTransparencyPanel watchlist={watchlist} tab={holdingsTab} usDash={usDash} viewMode={viewMode} />
      <PerformancePanel trades={trades} strategy={strategy} setStrategy={setStrategy} toast={toast} fxRate={fxRate} />
      <InsightsPanel insights={dash?.insights ?? []} trades={trades} onRefresh={onRefresh} toast={toast} />

      {(health?.recentEvents?.length > 0) && (
        <Panel title="시스템 로그" badge={`${health.recentEvents.length}건`}>
          <div className="max-h-32 overflow-y-auto divide-y divide-slate-800/20">
            {health.recentEvents.map((ev: any, i: number) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ev.status === 'success' ? 'bg-emerald-400' : ev.status === 'error' ? 'bg-rose-400' : 'bg-blue-400'}`} />
                <span className="text-slate-500 shrink-0 w-16">{(() => { const d = new Date(ev.timestamp); return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; })()}</span>
                <span className="text-slate-400 font-medium">[{ev.component}]</span>
                <span className="text-slate-300 truncate">{ev.message}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <PortfolioSection allocConfig={allocConfig} setAllocConfig={setAllocConfig} onGoToSettings={onGoToSettings} dash={dash} chains={chains} usHoldings={usHoldings} usW={usW} totalValue={totalValue} totalInvested={totalInvested} domesticInvested={domesticInvested} domesticCash={domesticCash} overseasInvestedUsd={overseasInvestedUsd} overseasInvestedKrw={overseasInvestedKrw} overseasMarketKrw={overseasMarketKrw} overseasCashUsd={overseasCashUsd} overseasCashKrw={overseasCashKrw} overseasPnlUsd={overseasPnlUsd} fxRate={fxRate} investedPctExact={investedPctExact} cashPctExact={cashPctExact} overseasCashPctExact={overseasCashPctExact} strategy={strategy} getStockName={getStockName} />
    </div>
  );
}

export default HomeView;
