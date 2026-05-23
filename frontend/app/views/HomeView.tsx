'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Panel, Indicator, SideBadge, EmptyMsg } from '@/components/ui';
import { api, fmt, fmtPct, fmtWon, fmtUsd, fmtTime, pc, pbg } from '../lib/utils';
import { KNOWN_STOCK_NAMES, getKnownStockName } from '../lib/stock-names';
import { useCountUp } from '../lib/hooks';
import { toDisplayName, isUnresolvedStockName } from '../lib/helpers';
import MoneyStatsPanel from '../panels/MoneyStatsPanel';
import { RiskGaugePanel, PnlBreakdownPanel, PerformanceVsKospiPanel, ShortSellingPanel, CorrelationWarningPanel, HighScannerPanel, SectorHeatmapPanel, TaxEstimatePanel } from '../panels/SmallPanels';
import OverseasScorePanel from '../panels/OverseasScorePanel';
import AiTransparencyPanel from '../panels/AiTransparencyPanel';
import PerformancePanel from '../panels/PerformancePanel';
import InsightsPanel from '../panels/InsightsPanel';
import InvestorFlowPanel from '../panels/InvestorFlowPanel';
import VisionScalpPanel from '../panels/VisionScalpPanel';

function HomeView({ dash, health, killSwitch, trades, usDash, withdrawConfig, watchlist, strategy, setStrategy, toast, onRefresh, allocConfig, setAllocConfig, onGoToSettings }: any) {
  const [showPortfolio, setShowPortfolio] = React.useState(false);
  const [holdingsTab, setHoldingsTab] = React.useState<'KR' | 'US'>('KR');
  const [userPickedTab, setUserPickedTab] = React.useState(false); // 사용자가 직접 탭 변경했는지
  const [usInsights, setUsInsights] = React.useState('');
  const [insightsDraft, setInsightsDraft] = React.useState('');
  const [insightsSaving, setInsightsSaving] = React.useState(false);
  const [tradingStatus, setTradingStatus] = React.useState<any>(null);
  const [aiStatus, setAiStatus] = React.useState<any>(null);
  const [privacyMode, setPrivacyMode] = React.useState(false);
  const [showAllKRScores, setShowAllKRScores] = React.useState(false);
  const [expandedTradeIdx, setExpandedTradeIdx] = React.useState<number | null>(null);
  const [buyingStock, setBuyingStock] = React.useState<string | null>(null);
  React.useEffect(() => {
    api('/overseas/insights').then((r: any) => {
      if (r?.insights != null) { setUsInsights(r.insights); setInsightsDraft(r.insights); }
    }).catch(() => {});
    api('/trading-status').then((r: any) => setTradingStatus(r)).catch(() => {});
    api('/ai-status').then((r: any) => setAiStatus(r)).catch(() => {});
  }, []);
  // 미국장 열리면 자동으로 US 탭으로 전환 (사용자가 직접 변경하지 않은 경우만)
  React.useEffect(() => {
    if (!userPickedTab) {
      setHoldingsTab(health?.usMarketOpen ? 'US' : 'KR');
    }
  }, [health?.usMarketOpen, userPickedTab]);
  const p = dash?.portfolio;
  const os = dash?.overseas; // 해외 보유 데이터
  const stockNameMap = new Map((watchlist ?? []).map((w: any) => [w.stock_code, w.stock_name]));
  const getStockName = (code: string): string => {
    return toDisplayName(stockNameMap.get(code), code);
  };
  const chains = dash?.chains || [];
  const usW = usDash?.watchlist || [];
  const usHoldings = usDash?.holdings || (dash?.overseas?.holdings ?? []); // 해외 보유종목 (usDash 미로드시 main dash 폴백)
  // 국내+해외 체결 모두 포함 (시간 역순) — PENDING 해외주문도 포함
  const filled = trades.filter((t: any) => t.status === 'FILLED' || (t.status === 'PENDING' && t.trigger_source === 'OVERSEAS'))
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const todayTrades = filled.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());

  // API에서 내려오는 손익 분리 값 사용
  // unrealizedPnl: p.pnl로 폴백 금지 — pnl은 실현+미실현 합산이라 미실현 전용 카드에 사용하면 안 됨
  const unrealizedPnl = p?.unrealizedPnl ?? 0;             // 국내 미실현손익만
  const realizedPnl   = p?.realizedPnl ?? 0;               // 실현손익 (매도 완료분)
  const totalPnl      = p?.pnl ?? 0;                       // 국내 미실현+실현 합산
  const totalPnlPct   = p?.pnlPct ?? 0;
  const domesticInvested = p?.domesticInvested ?? 0;       // 국내 투자 원금
  const totalInvested    = p?.invested ?? domesticInvested; // 국내+해외 투자 원금
  const overseasInvestedUsd = os?.totalInvestedUsd ?? 0;
  const overseasInvestedKrw = os?.totalInvestedKrw ?? 0;           // 원가 (투자금 표시용)
  const overseasMarketKrw = os?.totalMarketValueKrw ?? overseasInvestedKrw; // 시가 (비중 계산용)
  const overseasCashUsd = os?.cashUsd ?? 0;
  const overseasCashKrw = os?.cashKrw ?? (overseasCashUsd * (os?.fxRate ?? 1420));
  const fxRate = os?.fxRate ?? 1420;
  const dailyLossLimit = dash?.riskLimits?.maxDailyDrawdownKrw ?? 200000;
  const totalValue = Number(p?.totalValue ?? 0);
  const domesticCash = Number(p?.cash ?? 0);
  const pctClamp = (v: number) => Math.max(0, Math.min(100, v));
  const investedPct = totalValue > 0 ? Math.round((totalInvested / totalValue) * 100) : 0;
  // 포트폴리오 비중 바 차트용 — totalValue는 이미 국내+해외 합산 grandTotalValue (해외는 시가 기준)
  const investedPctExact = totalValue > 0 ? ((domesticInvested + overseasMarketKrw) / totalValue) * 100 : 0;
  const cashPctExact = totalValue > 0 ? (domesticCash / totalValue) * 100 : 0;
  const overseasCashPctExact = totalValue > 0 ? (overseasCashKrw / totalValue) * 100 : 0;

  // 통합 미실현 손익 — 국내(미실현만) + 해외 미실현 합산
  // last_price fallback: 장 마감 후 priceData.price=0이어도 DB 저장 시세 사용
  const overseasPnlUsd = usHoldings.reduce((sum: number, h: any) => {
    const priceData = usW.find((s: any) => s.code === h.stock_code);
    const curPrice = (priceData?.price ?? 0) > 0 ? priceData!.price : (h.last_price ?? 0);
    if (curPrice <= 0 || h.avg_price <= 0) return sum;
    return sum + (curPrice - h.avg_price) * h.quantity;
  }, 0);
  const overseasPnlKrw = Math.round(overseasPnlUsd * fxRate);
  // 탭 기반 손익 표시 — 국내 탭이면 국내, 해외 탭이면 해외
  const showOnlyKr = holdingsTab === 'KR';
  const showOnlyUs = holdingsTab === 'US';
  const combinedPnl = showOnlyKr
    ? unrealizedPnl
    : (usHoldings.length > 0 ? overseasPnlKrw : 0);
  const combinedInvested = showOnlyKr
    ? (domesticInvested > 0 ? domesticInvested : 0)
    : (overseasInvestedKrw > 0 ? overseasInvestedKrw : 0);
  const combinedPnlPct = combinedInvested > 0 ? (combinedPnl / combinedInvested) * 100 : (domesticInvested > 0 ? totalPnlPct : 0);
  const hasOverseasHoldings = usHoldings.length > 0;

  // 탭별 금일 손익 = 오늘 매도한 종목 기준 실현손익만 표시 (미실현 제외)
  const todayStr = new Date().toDateString();
  // 해외(OVERSEAS) 제외: usTodaySells와 중복 집계 방지
  const krTodaySells = todayTrades.filter((t: any) => t.side === 'SELL' && t.trigger_source !== 'OVERSEAS');
  const krRealizedPnl = krTodaySells.reduce((sum: number, t: any) => {
    if (t.realized_pnl != null) return sum + Number(t.realized_pnl);
    const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.filled_quantity ?? t.quantity) || 0;
    if (avgBuy <= 0 || filledPx <= 0 || qty <= 0) return sum;
    const grossPnl = (filledPx - avgBuy) * qty;
    const buyFee = Math.round(avgBuy * qty * 0.00015);
    const sellFee = Math.round(filledPx * qty * 0.00245);
    return sum + grossPnl - buyFee - sellFee;
  }, 0);
  const krTabPnl = krRealizedPnl; // 매도 실현손익만
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
    // overseas orders have chain_id=null so transaction_chains is always null.
    // avg_buy_price is encoded in ai_reasoning as "[avgBuy:123.4567] ..."
    const reasoningMatch = String(t.ai_reasoning ?? '').match(/\[avgBuy:([\d.]+)\]/);
    const avgBuy = reasoningMatch ? Number(reasoningMatch[1]) : (Number(t.transaction_chains?.avg_buy_price) || 0);
    const filledPx = Number(t.filled_price) || 0;
    const qty = Number(t.quantity) || 0;
    return avgBuy > 0 && filledPx > 0 ? sum + (filledPx - avgBuy) * qty : sum;
  }, 0);
  const usTabPnlKrw = Math.round(usTabPnlUsd * fxRate);

  // 로봇 일과 타임라인 계산
  const now = new Date();
  const marketStart = 9 * 60; // 09:00
  const marketEnd = 15 * 60 + 30; // 15:30
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

  // ── 롤업 애니메이션 값 ──
  const animCombined = useCountUp(combinedPnl);
  const todayRealizedPnl = krTabPnl + usTabPnlKrw;
  const animToday = useCountUp(todayRealizedPnl);
  const animTotal = useCountUp(totalValue);

  return (
    <div className="space-y-4 sm:space-y-5">


      {/* ── 연속손실 쿨다운 배너 ── */}
      {dash?.cooldown?.active && (
        <div className="rounded-2xl border border-orange-500/50 bg-orange-500/10 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-base shrink-0">🔒</span>
            <span className="text-sm font-bold text-orange-300">매수 쿨다운 중</span>
            <span className="text-[11px] text-orange-200/70 ml-1">{dash.cooldown.reason}</span>
            <button
              onClick={async () => {
                if (!confirm(`${dash.cooldown.consecutive}연패 쿨다운을 수동으로 해제할까요?\n(나는 이 결정에 책임집니다)`)) return;
                try {
                  await api('/cooldown/reset', { method: 'POST' });
                  toast?.('쿨다운 해제 완료 — 다음 루프에서 매수 재개', 'ok');
                  onRefresh();
                } catch (e: any) { toast?.('실패: ' + (e as any).message, 'error'); }
              }}
              className="ml-auto px-3 py-1.5 text-xs rounded-xl bg-orange-500/20 hover:bg-orange-500/40 text-orange-200 font-semibold transition-colors shrink-0"
            >🔓 쿨다운 수동 해제</button>
          </div>
        </div>
      )}

      {/* ── 매매 상태 배너 ── */}
      {tradingStatus && tradingStatus.overallStatus !== 'ACTIVE' && (
        <div className={`rounded-2xl border px-4 py-3 ${
          tradingStatus.overallStatus === 'BLOCKED'
            ? 'border-rose-500/40 bg-rose-500/10'
            : 'border-amber-500/30 bg-amber-500/[0.07]'
        }`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
            <span className="text-base shrink-0">{tradingStatus.overallStatus === 'BLOCKED' ? '🚫' : '👀'}</span>
            <span className={`text-sm font-bold whitespace-nowrap ${tradingStatus.overallStatus === 'BLOCKED' ? 'text-rose-300' : 'text-amber-300'}`}>
              {tradingStatus.overallStatus === 'BLOCKED' ? '매수 완전 차단 중' : '관망 중'}
            </span>
            <span className="text-[10px] text-slate-500 ml-auto whitespace-nowrap">{tradingStatus.mode} · {tradingStatus.buyThreshold}점</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(tradingStatus.blocks ?? []).map((b: any, i: number) => (
              <div key={i} className={`flex items-center gap-1.5 text-[11px] rounded-lg px-2.5 py-1 ${
                b.severity === 'warn' ? 'bg-amber-500/15 text-amber-300' : 'bg-white/[0.04] text-slate-400'
              }`}>
                <span className="font-semibold">{b.reason}</span>
                <span className="text-[10px] opacity-70">— {b.detail}</span>
              </div>
            ))}
          </div>
          {tradingStatus.topScore > 0 && (
            <div className="mt-2 text-[10px] text-slate-500">
              감시종목 최고점수 <b className="text-slate-300">{tradingStatus.topScore}점</b> / 기준 <b className="text-slate-300">{tradingStatus.buyThreshold}점</b>
              {tradingStatus.candidateCount > 0 && <span className="ml-2 text-emerald-400">→ {tradingStatus.candidateCount}종목 후보 있음</span>}
            </div>
          )}
          {tradingStatus.mode === 'DEFENSE' && (
            <div className="mt-2 flex justify-end">
              <button
                onClick={async () => {
                  if (!confirm('DEFENSE 모드를 해제하고 SWING 매매(기준 70점)로 복귀할까요?')) return;
                  try {
                    const r = await api('/defense-mode/deactivate', { method: 'POST' });
                    toast?.(r?.message ?? 'DEFENSE 모드 해제 완료', 'ok');
                    onRefresh();
                  } catch (e: any) { toast?.('실패: ' + (e as any).message, 'error'); }
                }}
                className="px-3 py-1.5 text-xs rounded-xl bg-rose-500/20 hover:bg-rose-500/40 text-rose-200 font-semibold transition-colors"
              >🔓 DEFENSE 모드 수동 해제</button>
            </div>
          )}
        </div>
      )}
      {tradingStatus && tradingStatus.overallStatus === 'ACTIVE' && (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="text-xs font-semibold text-emerald-300 whitespace-nowrap">자동매매 정상 운영 중</span>
          {tradingStatus.candidateCount > 0 && (
            <span className="text-xs text-emerald-400/70">— {tradingStatus.candidateCount}종목 대기</span>
          )}
          <span className="text-[10px] text-slate-500 whitespace-nowrap">{tradingStatus.mode} · {tradingStatus.buyThreshold}점</span>
        </div>
      )}

      {/* ── 방어 파킹 배너 ── */}
      {defensePark?.isActive && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <span className="text-xl shrink-0">🛡️</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-300">방어 파킹 중 — {defensePark.parkStockName} 보유</p>
            <p className="text-xs text-amber-400/80 mt-0.5 truncate">진입 사유: {defensePark.entryReason ?? '하락세 감지'}</p>
            <p className="text-xs text-amber-400/60 mt-0.5">시장 회복 감지 시 자동으로 정상 매매 복귀합니다.</p>
          </div>
          <button
            onClick={async () => {
              if (!confirm('파킹 강제 해제 + 보유 ETF 즉시 매도를 실행할까요?')) return;
              try {
                const r = await api('/release-defense-park', { method: 'POST' });
                alert(r?.message ?? '파킹 해제 완료');
                onRefresh();
              } catch (e: any) { alert('실패: ' + (e as any).message); }
            }}
            className="px-3 py-1.5 text-xs rounded-xl bg-amber-500/30 hover:bg-amber-500/50 text-amber-200 font-semibold transition-colors whitespace-nowrap shrink-0"
          >강제 해제</button>
        </div>
      )}

      {/* ── AI 엔진 상태 배너 (크레딧/쿼터/오류 시 표시) ── */}
      {aiStatus && (aiStatus.claude === 'no_credit' || aiStatus.claude === 'error' || aiStatus.gemini === 'quota' || aiStatus.gemini === 'error') && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm">⚠️</span>
            <span className="text-xs font-bold text-amber-300">AI 엔진 경고 — 안정 모드로 운영 중 (신규 매수 중단)</span>
            {aiStatus.claude === 'no_credit' && (
              <span className="text-[11px] bg-rose-500/20 text-rose-300 rounded px-2 py-0.5">Claude 크레딧 소진</span>
            )}
            {aiStatus.claude === 'error' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Claude 오류</span>
            )}
            {aiStatus.gemini === 'quota' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Gemini 무료 한도 초과 — 30분 후 자동 재시도</span>
            )}
            {aiStatus.gemini === 'error' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Gemini 오류 — 30분 후 자동 재시도</span>
            )}
            <span className="ml-auto text-[10px] text-slate-500">
              {aiStatus.activeEngine === 'technical' ? '기술 지표 모드' : aiStatus.activeEngine === 'none' ? '매매 대기' : ''}
            </span>
          </div>
        </div>
      )}

      {/* ── 상태 한 줄 바 (손실 한도 + 장 진행도 통합) ── */}
      <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* 장 상태 표시 */}
        {health?.marketOpen ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] text-slate-400">한국장 {currentTimeStr}</span>
          </div>
        ) : health?.usMarketOpen ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[11px] text-blue-400">🇺🇸 미국장중 {currentTimeStr}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-slate-600" />
            <span className="text-[11px] text-slate-500">장 외 — 미국장 대기중</span>
          </div>
        )}
        {/* 장 진행 바 — 한국장중에만 표시, 미국장중엔 미국 시간 표시 */}
        <div className="flex-1 relative">
          {health?.marketOpen ? (
            <>
              <div className="relative">
                <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-1000" style={{ width: `${marketProgress}%` }} />
                </div>
                {/* 황금 구간 마커: 10:20 (20.5%), 13:00 (61.5%) */}
                <div className="absolute top-0 w-px h-1.5 bg-emerald-400/60" style={{ left: '20.5%' }} />
                <div className="absolute top-0 w-px h-1.5 bg-emerald-400/60" style={{ left: '61.5%' }} />
              </div>
              <div className="flex justify-between mt-0.5 text-[9px] text-slate-600 relative">
                <span>09:00</span>
                <span className="absolute text-emerald-700" style={{ left: '20.5%', transform: 'translateX(-50%)' }}>10:20</span>
                <span className="absolute text-emerald-700" style={{ left: '61.5%', transform: 'translateX(-50%)' }}>13:00</span>
                <span>15:30</span>
              </div>
            </>
          ) : health?.usMarketOpen ? (
            <>
              <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-600 to-indigo-500 rounded-full transition-all duration-1000" style={{ width: `${usMarketProgress}%` }} />
              </div>
              <div className="flex justify-between mt-0.5 text-[9px] text-slate-600">
                <span>23:30</span><span>06:00</span>
              </div>
            </>
          ) : (
            <div className="text-[9px] text-slate-700 text-center">한국장 09:00 · 미국장 23:30</div>
          )}
        </div>
        {/* 손실 한도 */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-slate-500">손실 한도</span>
          <div className={`text-[11px] font-bold ${totalPnl < -(dailyLossLimit * 0.6) ? 'text-rose-400' : totalPnl < 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {totalPnl < 0
              ? `${Math.min(100, Math.round((Math.abs(totalPnl) / dailyLossLimit) * 100))}% (${fmtWon(Math.abs(totalPnl))}/${fmtWon(dailyLossLimit)} · 총자산 30%)`
              : `0% / ${fmtWon(dailyLossLimit)} (총자산 30%)`}
          </div>
        </div>
      </div>

      {/* ── 토스형 Hero 손익 카드 ── */}
      {(() => {
        const domesticTotal = domesticCash + domesticInvested;
        const domesticPct = domesticTotal > 0 ? Math.round((domesticInvested / domesticTotal) * 100) : 0;
        const mask = (v: string) => privacyMode ? '••••••' : v;
        return (
          <div className={`rounded-2xl border p-5 ${combinedPnl > 0 ? 'bg-gradient-to-br from-emerald-950/60 via-emerald-900/20 to-transparent border-emerald-500/20' : combinedPnl < 0 ? 'bg-gradient-to-br from-rose-950/60 via-rose-900/20 to-transparent border-rose-500/20' : 'glass border-white/[0.06]'}`}>
            {/* 상단 헤더 */}
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-semibold text-slate-400 tracking-wide">미실현 손익{showOnlyKr ? ' 🇰🇷 국내' : showOnlyUs ? ' 🇺🇸 해외' : hasOverseasHoldings ? ' (국내+해외)' : ''}</span>
              <button onClick={() => setPrivacyMode(v => !v)} className="text-slate-500 hover:text-slate-300 transition-colors p-1 -m-1 rounded-lg">
                {privacyMode ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                )}
              </button>
            </div>
            {/* 메인 수치 */}
            <div className="flex items-end gap-4 mb-5">
              <div className="flex-1">
                {showOnlyUs ? (
                  <>
                    <div className={`text-4xl sm:text-5xl font-black tracking-tight tabular-nums ${pc(overseasPnlUsd)}`}>
                      {privacyMode ? '••••••' : `${overseasPnlUsd > 0 ? '+' : ''}$${Math.round(overseasPnlUsd).toLocaleString('en-US')}`}
                    </div>
                    <div className={`text-sm font-bold mt-1 ${pc(overseasPnlUsd)}`}>
                      {overseasInvestedUsd > 0 ? `${((overseasPnlUsd / overseasInvestedUsd) * 100) > 0 ? '+' : ''}${((overseasPnlUsd / overseasInvestedUsd) * 100).toFixed(2)}%` : '0.00%'}
                    </div>
                  </>
                ) : (
                  <>
                    <div className={`text-4xl sm:text-5xl font-black tracking-tight tabular-nums ${pc(combinedPnl)}`}>
                      {privacyMode ? '••••••원' : `${combinedPnl > 0 ? '+' : ''}${Math.round(animCombined).toLocaleString('ko-KR')}원`}
                    </div>
                    <div className={`text-sm font-bold mt-1 ${pc(combinedPnl)}`}>
                      {combinedPnlPct !== 0 ? `${combinedPnlPct > 0 ? '+' : ''}${combinedPnlPct.toFixed(2)}%` : '0.00%'}
                    </div>
                  </>
                )}
              </div>
              {(krTabHasData || usTodaySells.length > 0) && (
                <div className="text-right shrink-0 border-l border-white/[0.06] pl-4">
                  <div className="text-[10px] text-slate-500 mb-0.5">오늘 실현</div>
                  <div className={`text-xl font-black tabular-nums ${pc(showOnlyUs ? usTabPnlUsd : todayRealizedPnl)}`}>
                    {privacyMode ? '••••' : showOnlyUs
                      ? `${usTabPnlUsd > 0 ? '+' : ''}$${Math.round(usTabPnlUsd).toLocaleString('en-US')}`
                      : `${todayRealizedPnl > 0 ? '+' : ''}${Math.round(animToday).toLocaleString('ko-KR')}원`}
                  </div>
                </div>
              )}
            </div>
            {/* 미니 스탯 3개 */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-white/[0.04] rounded-xl px-3 py-2">
                <div className="text-[9px] text-slate-500 mb-0.5">{showOnlyUs ? '해외현금' : '현금잔고'}</div>
                {showOnlyUs ? (
                  <div className="text-sm font-bold text-slate-200 tabular-nums truncate">{mask('$' + Math.round(overseasCashUsd).toLocaleString('en-US'))}</div>
                ) : (
                  <div className="text-sm font-bold text-slate-200 tabular-nums truncate">{mask(Math.round(domesticCash / 10000).toLocaleString('ko-KR') + '만원')}</div>
                )}
              </div>
              <div className="bg-white/[0.04] rounded-xl px-3 py-2">
                <div className="text-[9px] text-slate-500 mb-0.5">투자비중</div>
                {showOnlyUs ? (() => {
                  const usTotalUsd = overseasInvestedUsd + overseasCashUsd;
                  const usPct = usTotalUsd > 0 ? Math.round((overseasInvestedUsd / usTotalUsd) * 100) : 0;
                  return <div className={`text-sm font-bold tabular-nums ${usPct > 60 ? 'text-amber-400' : 'text-blue-400'}`}>{usPct}% <span className="text-[9px] text-slate-600">({usHoldings.length}종목)</span></div>;
                })() : (
                  <div className={`text-sm font-bold tabular-nums ${domesticPct > 60 ? 'text-amber-400' : 'text-blue-400'}`}>{domesticPct}% <span className="text-[9px] text-slate-600">({chains.length}종목)</span></div>
                )}
              </div>
              <div className="bg-white/[0.04] rounded-xl px-3 py-2">
                <div className="text-[9px] text-slate-500 mb-0.5">{showOnlyUs ? '오늘미국' : withdrawConfig?.totalReserved > 0 ? '인출예약' : '오늘매매'}</div>
                {showOnlyUs ? (
                  <div className={`text-sm font-bold tabular-nums ${usTodaySells.length > 0 ? pc(usTabPnlUsd) : 'text-slate-200'}`}>{usTodaySells.length > 0 ? `${usTabPnlUsd > 0 ? '+' : ''}$${usTabPnlUsd.toFixed(0)}` : `${usTodaySells.length}건`}</div>
                ) : withdrawConfig?.totalReserved > 0 ? (
                  <div className="text-sm font-bold text-amber-400 truncate">{mask(fmtWon(withdrawConfig.totalReserved))}</div>
                ) : (
                  <div className="text-sm font-bold text-slate-200">{todayTrades.length}<span className="text-[9px] text-slate-500 ml-0.5">건</span></div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── 보유종목 (국내/해외 탭) ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
        {/* 탭 헤더 */}
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

        {/* 국내 탭 */}
        {holdingsTab === 'KR' && (
          chains.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-white/[0.03]">

              {chains.map((ch: any, i: number) => {
                const avgPrice = Number(ch.avg_buy_price) || 0;
                const qty = Number(ch.total_quantity) || 0;
                const invested = Number(ch.invested) || avgPrice * qty;
                const curAvg = Number(ch.current_averaging_count) || 0;
                const maxAvg = Number(ch.max_averaging_count) || 1;
                // 체인에 저장된 실제 TP/SL 우선 사용 (DB 값), 없을 때만 모드 기본값 폴백
                const STRATEGY_TP_SL: Record<string, [number, number]> = {
                  SWING: [5.5, -3.0], DEFENSE: [5.0, -2.0], SCALPING: [0.8, -0.8], DIVIDEND: [3.0, -1.5], SNIPER: [8.0, -4.0],
                };
                const [fallbackTp, fallbackSl] = STRATEGY_TP_SL[ch.strategy_mode as string] ?? [5.5, -3.0];
                const targetPct = Number(ch.target_profit_pct) || fallbackTp;
                const stopPct = Number(ch.stop_loss_pct) || fallbackSl;
                const pnl = ch.unrealizedPnl ?? 0;
                const pnlPct = ch.unrealizedPnlPct ?? 0;
                const resolvedName = toDisplayName(ch.stock_name, ch.stock_code);
                const displayName = isUnresolvedStockName(resolvedName, ch.stock_code)
                  ? getStockName(ch.stock_code)
                  : resolvedName;
                const isParking = ch.isParking === true;
                const weight = typeof ch.weight === 'number' ? ch.weight : null;

                /* ── 파킹 ETF 카드 ── */
                if (isParking) return (
                  <div key={`c${i}`} className="p-4 bg-sky-950/50 border-l-2 border-sky-500/60">
                    {/* 헤더: 종목명 + 배지 + 수익률 */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] bg-sky-500/25 text-sky-300 border border-sky-500/40 px-2 py-0.5 rounded-full font-bold shrink-0">💰 파킹중</span>
                        <span className="text-sm font-bold text-sky-100 truncate">{displayName}</span>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <div className="text-base font-black text-sky-300">{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                        <div className="text-[11px] text-sky-500">{pnl > 0 ? '+' : ''}{fmtWon(pnl)}</div>
                      </div>
                    </div>
                    {/* 3개 수치 */}
                    <div className="flex gap-4 mt-3">
                      <div>
                        <div className="text-[9px] text-slate-500">파킹금액</div>
                        <div className="text-[12px] font-bold text-sky-200">{fmtWon(invested)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500">평단 / 현재가</div>
                        <div className="text-[12px] font-bold text-slate-300">{fmtWon(avgPrice)} → {ch.currentPrice > 0 ? fmtWon(ch.currentPrice) : '-'}</div>
                      </div>
                      <div className="ml-auto text-right">
                        <div className="text-[9px] text-sky-600">자산비중</div>
                        <div className="text-[15px] font-black text-sky-400">{weight !== null ? `${weight}%` : '-'}</div>
                      </div>
                    </div>
                    {/* 매도 버튼 */}
                    <div className="flex justify-end mt-3">
                      <button onClick={async () => {
                        if (!confirm(`${displayName} ${qty}주 전량 매도하시겠습니까?\n(파킹 해제)`)) return;
                        try { const r = await api(`/sell-stock/${ch.stock_code}`, { method: 'POST', timeout: 40000 }); alert(r.message || '매도 완료'); onRefresh(); }
                        catch (err: any) { alert('매도 실패: ' + err.message); }
                      }} className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 transition-colors border border-white/[0.05]">
                        파킹 해제
                      </button>
                    </div>
                  </div>
                );

                /* ── 일반 종목 카드 ── */
                const isClaudeBought = ch.trigger_source === 'CLAUDE';
                const range = targetPct - stopPct;
                const barPos = Math.max(0, Math.min(100, ((pnlPct - stopPct) / range) * 100));
                return (
                  <div key={`c${i}`} className={`p-4 hover:bg-white/[0.01] transition-colors ${isClaudeBought ? 'bg-violet-950/40 border-l-2 border-violet-500/70' : 'bg-[#0f1320]'}`}>
                    {/* 헤더: 종목명 + 수익률 */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold truncate">{displayName}</span>
                          {isClaudeBought && <span className="text-[10px] bg-violet-500/20 text-violet-300 border border-violet-500/40 px-1.5 py-0.5 rounded font-bold shrink-0">AI픽</span>}
                          <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded font-medium shrink-0">{ch.strategy_mode}</span>
                          {ch.status === 'PROFIT_TAKING' && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold shrink-0">2단계↑</span>}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">평단 {fmtWon(avgPrice)} · {fmt(qty)}주{weight !== null ? ` · 비중 ${weight}%` : ''}</div>
                      </div>
                      <div className="text-right shrink-0">
                        {ch.currentPrice > 0 ? (
                          <>
                            <div className={`text-lg font-black ${pc(pnl)}`}>{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                            <div className={`text-[11px] ${pc(pnl)}`}>{pnl > 0 ? '+' : ''}{fmtWon(pnl)}</div>
                          </>
                        ) : <span className="text-xs text-slate-600">시세 로딩중</span>}
                      </div>
                    </div>
                    {/* P&L 진행 바 */}
                    {ch.currentPrice > 0 && avgPrice > 0 && (
                      <div className="mt-3">
                        <div className="relative h-1.5 bg-white/[0.05] rounded-full overflow-visible">
                          <div className={`absolute h-full rounded-full transition-all duration-700 ${pnlPct >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${barPos}%` }} />
                          <div className="absolute h-3 w-0.5 bg-white/20 rounded-full top-1/2 -translate-y-1/2" style={{ left: `${((0 - stopPct) / range) * 100}%` }} />
                        </div>
                        <div className="flex justify-between mt-0.5">
                          <span className="text-[9px] text-rose-500">{stopPct}%</span>
                          <span className="text-[9px] text-emerald-500">+{targetPct}%</span>
                        </div>
                      </div>
                    )}
                    {/* 투자금 · 현재가 · 목표가/손절가 */}
                    <div className="grid grid-cols-3 gap-2 mt-2">
                      <div>
                        <div className="text-[9px] text-slate-500 mb-0.5">투자금</div>
                        <div className="text-[11px] font-bold truncate">{fmtWon(invested)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500 mb-0.5">진입가 → 현재</div>
                        <div className="text-[10px] font-bold text-slate-300">{fmtWon(avgPrice)}</div>
                        <div className="text-[10px] font-bold">{ch.currentPrice > 0 ? fmtWon(ch.currentPrice) : '-'}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-500 mb-0.5">목표가 / 손절가</div>
                        <div className="text-[10px] font-bold text-emerald-400">{avgPrice > 0 ? fmtWon(Math.round(avgPrice * (1 + targetPct / 100))) : '-'} <span className="text-[9px] text-emerald-600">+{targetPct}%</span></div>
                        <div className="text-[10px] font-bold text-rose-400">{avgPrice > 0 ? fmtWon(Math.round(avgPrice * (1 + stopPct / 100))) : '-'} <span className="text-[9px] text-rose-700">{stopPct}%</span></div>
                      </div>
                    </div>
                    {/* 액션 버튼 */}
                    <div className="flex items-center gap-1.5 mt-3">
                      <div className="flex gap-0.5">
                        {Array.from({ length: maxAvg }, (_, j) => (
                          <span key={j} className={`w-3.5 h-3.5 rounded-full text-[7px] font-bold flex items-center justify-center ${j < curAvg ? 'bg-blue-500 text-white' : 'bg-white/[0.06] text-slate-600'}`}>{j + 1}</span>
                        ))}
                      </div>
                      <div className="ml-auto flex items-center gap-1">
                        {ch.escape_target_price ? (
                          <button onClick={async () => {
                            try { await api(`/escape/${ch.id}`, { method: 'DELETE' }); onRefresh(); }
                            catch (err: any) { alert('취소 실패: ' + err.message); }
                          }} className="text-xs px-2.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 font-bold border border-amber-500/30 animate-pulse whitespace-nowrap">
                            탈출대기
                          </button>
                        ) : (
                          <button onClick={async () => {
                            if (!confirm(`${displayName}\n현재가 기준 +0.5% 돌파 시 자동 전량 매도합니다.`)) return;
                            try {
                              const r = await api(`/escape/${ch.id}`, { method: 'POST' });
                              alert(`탈출가 설정: ${fmtWon(r.escape_target_price)}`);
                              onRefresh();
                            } catch (err: any) { alert('탈출 설정 실패: ' + err.message); }
                          }} className="text-xs px-2.5 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 font-bold border border-amber-500/20 whitespace-nowrap">
                            탈출
                          </button>
                        )}
                        <button onClick={async () => {
                          if (!confirm(`${displayName} ${qty}주 전량 시장가 매도하시겠습니까?`)) return;
                          try { const r = await api(`/sell-stock/${ch.stock_code}`, { method: 'POST', timeout: 40000 }); alert(r.message || '매도 완료'); onRefresh(); }
                          catch (err: any) { alert('매도 실패: ' + err.message); }
                        }} className="text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 font-medium border border-white/[0.04] whitespace-nowrap">
                          전량 매도
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-8 text-center space-y-3">
              <div className="text-2xl opacity-30">📦</div>
              <p className="text-sm text-slate-400">아직 투자 중인 종목이 없습니다</p>
              <p className="text-[11px] text-slate-600">장 중 10분 간격으로 자동 탐색 중</p>
            </div>
          )
        )}

        {/* 해외 탭 */}
        {holdingsTab === 'US' && (
          <div>
            {usHoldings.length > 0 && (
              <div className="divide-y divide-white/[0.03]">
                {usHoldings.map((h: any) => {
                  const priceData = usW.find((s: any) => s.code === h.stock_code);
                  const curPrice = (priceData?.price ?? 0) > 0 ? priceData!.price : (h.last_price ?? 0);
                  const isStale = (priceData?.price ?? 0) === 0 && curPrice > 0; // DB 저장 마지막 시세
                  const displayPrice = curPrice > 0 ? curPrice : (h.avg_price ?? 0); // 최후 폴백: 매수가
                  const isAvgFallback = curPrice === 0 && displayPrice > 0;
                  const invested = h.avg_price * h.quantity;
                  const pnl = displayPrice > 0 ? (displayPrice - h.avg_price) * h.quantity : 0;
                  const pnlPct = displayPrice > 0 && h.avg_price > 0 ? ((displayPrice - h.avg_price) / h.avg_price) * 100 : 0;
                  const usDisplayName = toDisplayName(priceData?.name, h.stock_code);
                  return (
                    <div key={h.stock_code} className="px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold">{usDisplayName}</span>
                          <span className="text-[10px] text-slate-500">{h.quantity}주</span>
                        </div>
                        <div className="text-[11px] text-slate-500">평단 ${h.avg_price.toFixed(2)} · 투자 ${invested.toFixed(0)}</div>
                      </div>
                      <div className="text-right">
                        {displayPrice > 0 ? (
                          <>
                            <div className={`text-base font-bold ${pc(pnl)}`}>{pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(1)}%</div>
                            <div className={`text-[11px] ${pc(pnl)}`}>${pnl.toFixed(0)}</div>
                            {isAvgFallback && <div className="text-[10px] text-slate-600">매수가 기준</div>}
                            {isStale && !isAvgFallback && <div className="text-[10px] text-slate-600">장마감 시세</div>}
                          </>
                        ) : <span className="text-xs text-slate-600">시세 없음</span>}
                      </div>
                      <button onClick={async () => {
                        if (!confirm(`${usDisplayName} ${h.quantity}주 전량 시장가 매도하시겠습니까?`)) return;
                        try {
                          const r = await api(`/sell-overseas/${h.stock_code}`, { method: 'POST', timeout: 40000 });
                          alert(r.message || '매도 완료');
                          onRefresh();
                        } catch (err: any) { alert('매도 실패: ' + err.message); }
                      }} className="text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-rose-500/10 hover:text-rose-400 text-slate-500 font-medium border border-white/[0.04] whitespace-nowrap shrink-0">
                        전량 매도
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {/* 제보 단타 */}
            <VisionScalpPanel toast={toast} />
            {usW.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3.5">
                {usW.map((s: any) => {
                  const held = usHoldings.find((h: any) => h.stock_code === s.code);
                  const usDisplayName = toDisplayName(s.name, s.code);
                  const hasPrice = s.price > 0;
                  return (
                    <div key={s.code} className={`rounded-xl border p-3 text-center transition-all hover:scale-[1.02] ${hasPrice ? pbg(s.changePct) : ''} ${held ? 'border-blue-500/40' : 'border-slate-700/30'}`}>
                      <div className="text-xs font-bold text-slate-300 truncate">{usDisplayName} {held ? '📌' : ''}</div>
                      <div className={`text-base font-bold mt-1 ${!hasPrice ? 'text-slate-600' : ''}`}>{hasPrice ? `$${s.price.toFixed(1)}` : '-'}</div>
                      <div className={`text-[11px] font-semibold mt-0.5 ${hasPrice ? pc(s.changePct) : 'text-slate-600'}`}>{hasPrice ? fmtPct(s.changePct) : '장마감'}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {usW.length === 0 && usHoldings.length === 0 && (
              <div className="p-8 text-center space-y-2">
                <div className="text-2xl opacity-30">🌏</div>
                <p className="text-sm text-slate-400">장 마감 — 다음 세션 시작 시 시세 자동 업데이트</p>
                <p className="text-[11px] text-slate-600">🇯🇵 09:00~15:00 · 🇹🇼 10:00~14:30 · 🇺🇸 22:30~06:30 (서머타임)</p>
              </div>
            )}
            {/* 운영자 인사이트 입력 */}
            <div className="border-t border-white/[0.04] px-4 py-3">
              <div className="text-[11px] text-slate-500 mb-1.5 font-medium">💡 AI 인사이트 메모 <span className="text-slate-600">(다음 사이클에 AI에게 전달됩니다)</span></div>
              <textarea
                value={insightsDraft}
                onChange={e => setInsightsDraft(e.target.value)}
                placeholder="예: 미국 연준 금리 동결 예상, 반도체 섹터 주목 등 시장 상황을 자유롭게 입력하세요"
                rows={2}
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 text-xs text-slate-300 placeholder:text-slate-600 focus:border-blue-500/50 focus:outline-none resize-none"
              />
              <div className="flex items-center justify-between mt-1.5">
                {usInsights && insightsDraft === usInsights
                  ? <span className="text-[10px] text-emerald-500/70">✓ 저장됨</span>
                  : <span className="text-[10px] text-slate-600">{insightsDraft.length > 0 ? '미저장' : ''}</span>}
                <button
                  disabled={insightsSaving || insightsDraft === usInsights}
                  onClick={async () => {
                    setInsightsSaving(true);
                    try {
                      await api('/overseas/insights', { method: 'PUT', body: JSON.stringify({ insights: insightsDraft }) });
                      setUsInsights(insightsDraft);
                      toast?.('인사이트 저장됨', 'ok');
                    } catch { toast?.('저장 실패', 'err'); }
                    setInsightsSaving(false);
                  }}
                  className="text-[11px] px-3 py-1 bg-blue-600/70 hover:bg-blue-500/70 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg transition-all"
                >
                  {insightsSaving ? '저장중...' : '저장'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── 머니 통계 (누적수익 + 월별 막대 + 목표 게이지) ── */}
      <MoneyStatsPanel key={`${dash?.tradingMode ?? 'paper'}-${holdingsTab}`} market={holdingsTab} />

      {/* ── 리스크 게이지 ── */}
      {(() => {
        const dailyLossPct = totalPnl < 0 ? Math.min(100, Math.round((Math.abs(totalPnl) / dailyLossLimit) * 100)) : 0;
        const maxInvested = chains.reduce((mx: number, ch: any) => Math.max(mx, Number(ch.invested) || 0), 0);
        const concPct = totalInvested > 0 ? Math.round((maxInvested / totalInvested) * 100) : 0;
        return (
          <RiskGaugePanel investedPct={investedPct} dailyLossPct={dailyLossPct} concentrationPct={concPct} />
        );
      })()}

      {/* ── AI 스코어 + 최근 매매 2컬럼 ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 items-start gap-4 sm:gap-5">
        {/* AI 스코어 — KR/US 탭 연동 */}
        {holdingsTab === 'KR' ? (
          <Panel title="AI가 보는 종목 점수" badge={dash?.scores?.length > 0 ? `${dash.scores.length}종목` : undefined} badgeColor="blue">
            {dash?.scores?.length > 0 ? (() => {
              const sorted = [...dash.scores].sort((a: any, b: any) => (b.composite_score ?? 0) - (a.composite_score ?? 0));
              const visible = showAllKRScores ? sorted : sorted.slice(0, 10);
              return (
                <div className="p-3.5">
                  {visible.map((sc: any) => {
                    const score = Number(sc.composite_score);
                    const barColor = score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-blue-500' : score >= 25 ? 'bg-amber-500' : 'bg-slate-600';
                    const textColor = score >= 75 ? 'text-emerald-400' : score >= 50 ? 'text-blue-400' : 'text-slate-500';
                    const signalLabel = score >= 85 ? '강력 추천' : score >= 70 ? '매수 추천' : score >= 50 ? '관망' : score >= 30 ? '위험' : '매도 추천';
                    const curP = Number(sc.currentPrice) || 0;
                    const aiTarget = Number(sc.target_price) || 0;
                    const aiStop = Number(sc.stop_loss_price) || 0;
                    const targetP = aiTarget > 0 ? aiTarget : (curP > 0 ? Math.round(curP * 1.16) : 0);
                    const stopP = aiStop > 0 ? aiStop : (curP > 0 ? Math.round(curP * 0.92) : 0);
                    const conf = sc.confidence != null ? Math.round(Number(sc.confidence) * 100) : null;
                    const fundScore = sc.fundamental_score != null ? Number(sc.fundamental_score) : null;
                    const techScore = sc.technical_score != null ? Number(sc.technical_score) : null;
                    const sentScore = sc.sentiment_score != null ? Number(sc.sentiment_score) : null;
                    const isBuying = buyingStock === sc.stock_code;
                    const stockLabel = sc.stock_name && sc.stock_name !== sc.stock_code ? sc.stock_name : getStockName(sc.stock_code);
                    return (
                      <div key={sc.stock_code} className="px-2 py-2.5 border-b border-white/[0.03] last:border-0">
                        {/* 상단: 종목명 + 스코어 바 + 점수 + 매수버튼 */}
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-300 w-20 shrink-0 truncate">{stockLabel}</span>
                          <div className="flex-1">
                            <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
                            </div>
                          </div>
                          <span className={`text-sm font-black w-8 text-right ${textColor}`}>{score}</span>
                          <span className={`text-[10px] font-medium w-14 text-right ${textColor}`}>{signalLabel}</span>
                          {curP > 0 && (
                            <button disabled={isBuying} onClick={async () => {
                              if (!confirm(`${stockLabel} 수동 매수 — 50만원?`)) return;
                              setBuyingStock(sc.stock_code);
                              try {
                                await api('/manual-buy', { method: 'POST', body: JSON.stringify({ stock_code: sc.stock_code, amount_krw: 500000, reasoning: `수동진입 AI${score}점 conf${conf}% 목표${fmtWon(targetP)}` }) });
                                toast?.('매수 접수', 'ok');
                              } catch (e: any) { toast?.(e.message, 'err'); }
                              setBuyingStock(null);
                            }} className="text-[10px] px-2 py-1 bg-blue-600/70 hover:bg-blue-500/70 disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0">
                              {isBuying ? '...' : '매수'}
                            </button>
                          )}
                        </div>
                        {/* 중단: 세부 점수 3종 */}
                        <div className="flex items-center gap-3 mt-1.5 pl-1 flex-wrap">
                          {fundScore !== null && <span className="text-[9px] text-slate-500">기본 <b className={fundScore >= 50 ? 'text-emerald-400' : fundScore >= 0 ? 'text-blue-400' : 'text-rose-400'}>{fundScore}</b></span>}
                          {techScore !== null && <span className="text-[9px] text-slate-500">기술 <b className={techScore >= 50 ? 'text-emerald-400' : techScore >= 0 ? 'text-blue-400' : 'text-rose-400'}>{techScore}</b></span>}
                          {sentScore !== null && <span className="text-[9px] text-slate-500">심리 <b className={sentScore >= 50 ? 'text-emerald-400' : sentScore >= 0 ? 'text-blue-400' : 'text-rose-400'}>{sentScore}</b></span>}
                          {conf !== null && <span className="text-[9px] text-blue-400/70">확신 {conf}%</span>}
                        </div>
                        {/* 하단: 진입가 → 목표가 → 손절가 */}
                        {curP > 0 && (
                          <div className="flex items-center gap-2 mt-1 pl-1 text-[9px] flex-wrap">
                            <span className="text-slate-500">진입 <b className="text-slate-300">{fmtWon(curP)}</b></span>
                            <span className="text-slate-600">→</span>
                            <span className="text-emerald-500">목표 {fmtWon(targetP)}</span>
                            <span className="text-slate-600">/</span>
                            <span className="text-rose-500">손절 {fmtWon(stopP)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {sorted.length > 10 && (
                    <button onClick={() => setShowAllKRScores(v => !v)}
                      className="w-full mt-1 py-1.5 text-[11px] text-slate-500 hover:text-blue-400 transition-colors">
                      {showAllKRScores ? '접기' : `+ ${sorted.length - 10}종목 더 보기`}
                    </button>
                  )}
                </div>
              );
            })() : (
              <div className="p-6 text-center space-y-3">
                <div className="text-2xl opacity-30">🤖</div>
                <p className="text-sm text-slate-500">AI 스코어가 아직 없습니다</p>
                <p className="text-[11px] text-slate-600">매일 오전 7:30 / 오후 6시에 자동 실행됩니다.</p>
                <p className="text-[10px] text-blue-400/60">스코어 없는 동안 기술적 지표 기반으로 자동매매가 동작합니다</p>
              </div>
            )}
          </Panel>
        ) : <OverseasScorePanel usDash={usDash} toast={toast} />}

        {/* 최근 매매 — KR/US 탭 연동 */}
        {(() => {
          const isUsTab = holdingsTab === 'US';
          const tabFiltered = filled.filter((t: any) => {
            const isOv = t.trigger_source === 'OVERSEAS' || Number(t.filled_price) < 1000;
            return isUsTab ? isOv : !isOv;
          });
          const todayTabTrades = tabFiltered.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString());
          return (
        <Panel title={isUsTab ? '최근 매매 (미국)' : '최근 매매'} badge={`오늘 ${todayTabTrades.length}건`} badgeColor={todayTabTrades.length > 0 ? 'emerald' : undefined}>
          {tabFiltered.length === 0 ? <EmptyMsg>매매 기록 없음</EmptyMsg> : (
            <div className="divide-y divide-white/[0.03]">
              {tabFiltered.slice(0, 10).map((t: any, i: number) => {
                const isOverseasTrade = t.trigger_source === 'OVERSEAS' || Number(t.filled_price) < 1000;
                const isExpanded = expandedTradeIdx === i;
                return (
                  <div key={i} onClick={() => setExpandedTradeIdx(isExpanded ? null : i)}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.02] cursor-pointer">
                    <SideBadge side={t.side} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-slate-200">
                          {(() => {
                            const resolved = toDisplayName(t.stock_name, t.stock_code);
                            return isUnresolvedStockName(resolved, t.stock_code) ? getStockName(t.stock_code) : resolved;
                          })()}
                        </span>
                        {isOverseasTrade && <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-md">🇺🇸</span>}
                        <span className="text-[10px] text-slate-600">{fmtTime(t.created_at)}</span>
                      </div>
                      <div className={`text-[11px] text-slate-500 mt-0.5 ${isExpanded ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
                        {t.ai_reasoning || '-'}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold">{isOverseasTrade ? fmtUsd(Number(t.filled_price)) : fmtWon(Number(t.filled_price))}</div>
                      <div className="text-[10px] text-slate-500">{fmt(t.quantity)}주</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
          );
        })()}
      </div>


      {/* ── 수익 구조 분해 ── */}
      <PnlBreakdownPanel chains={chains} trades={trades} />

      {/* ── 봇 vs KOSPI 비교 ── */}
      {holdingsTab === 'KR' && <PerformanceVsKospiPanel />}

      {/* ── 외국인/기관 수급 ── */}
      {holdingsTab === 'KR' && <InvestorFlowPanel />}

      {/* ── 보유종목 공매도 ── */}
      {holdingsTab === 'KR' && <ShortSellingPanel />}

      {/* ── 섹터 쏠림 경고 ── */}
      {holdingsTab === 'KR' && <CorrelationWarningPanel />}

      {/* ── 52주 신고가 스캐너 ── */}
      {holdingsTab === 'KR' && <HighScannerPanel />}

      {/* ── 업종 히트맵 ── */}
      {holdingsTab === 'KR' && <SectorHeatmapPanel />}

      {/* ── 세금 추정 ── */}
      {holdingsTab === 'KR' && <TaxEstimatePanel />}

      {/* ── AI 판단 근거 투명성 ── */}
      <AiTransparencyPanel watchlist={watchlist} tab={holdingsTab} usDash={usDash} />

      {/* ── 성과 종합 분석 ── */}
      <PerformancePanel trades={trades} strategy={strategy} setStrategy={setStrategy} toast={toast} />

      {/* ── 자기학습 인사이트 ── */}
      <InsightsPanel insights={dash?.insights ?? []} trades={trades} onRefresh={onRefresh} toast={toast} />

      {/* ── 시스템 로그 ── */}
      {(health?.recentEvents?.length > 0) && (
        <Panel title="시스템 로그" badge={`${health.recentEvents.length}건`}>
          <div className="max-h-32 overflow-y-auto divide-y divide-slate-800/20">
            {health.recentEvents.map((ev: any, i: number) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ev.status === 'success' ? 'bg-emerald-400' : ev.status === 'error' ? 'bg-rose-400' : 'bg-blue-400'}`} />
                <span className="text-slate-500 shrink-0 w-16">{fmtTime(ev.timestamp)}</span>
                <span className="text-slate-400 font-medium">[{ev.component}]</span>
                <span className="text-slate-300 truncate">{ev.message}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ── 포트폴리오 비중 ── */}
      {(() => {
        const krTarget = Number(allocConfig?.kr_pct ?? 70);
        const usTarget = Number(allocConfig?.us_pct ?? 30);
        const krActualPct = domesticInvested > 0
          ? (chains.reduce((s: number, ch: any) => s + (ch.unrealizedPnl ?? 0), 0) / domesticInvested) * 100
          : 0;
        const usActualPct = overseasInvestedUsd > 0 ? (overseasPnlUsd / overseasInvestedUsd) * 100 : 0;
        const krUnderperform = chains.length > 0 && usHoldings.length > 0 && krActualPct < usActualPct - 2;
        const applyPreset = async (kr: number, us: number) => {
          try {
            const upd = await api('/portfolio/allocation', { method: 'PUT', body: JSON.stringify({ ...allocConfig, kr_pct: kr, us_pct: us }) });
            setAllocConfig(upd);
          } catch {}
        };
        return (
          <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden">
            {/* 헤더 */}
            <div className="px-4 py-3 flex items-center justify-between">
              <button onClick={() => setShowPortfolio(v => !v)} className="flex items-center gap-2 flex-1 text-left hover:opacity-80 transition-opacity">
                <span className="text-sm font-semibold text-slate-200">포트폴리오 비중</span>
                {totalInvested > 0 && <span className="text-[10px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-md">투자 {((totalInvested / (p?.totalValue || 1)) * 100).toFixed(0)}%</span>}
                {krUnderperform && <span className="text-[10px] text-amber-400 animate-pulse ml-1">⚡ 국내 부진</span>}
              </button>
              <div className="flex items-center gap-3">
                <button onClick={() => onGoToSettings?.()} className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors">설정 →</button>
                <button onClick={() => setShowPortfolio(v => !v)} className="text-[11px] text-slate-500">{showPortfolio ? '접기 ▲' : '자세히 ▼'}</button>
              </div>
            </div>
            {/* 항상 보이는 영역 */}
            <div className="px-4 pb-4 space-y-3">
              {/* 자금 흐름 시각화 — 3칸: 한국주식 | 현금 | 미국주식 */}
              <div className="grid grid-cols-3 gap-2">
                <div className={`rounded-xl px-3 py-2.5 ${krActualPct >= 0 ? 'bg-blue-950/40 border border-blue-500/10' : 'bg-rose-950/30 border border-rose-500/10'}`}>
                  <div className="text-[9px] text-slate-500 mb-0.5">🇰🇷 한국주식</div>
                  <div className="text-sm font-bold tabular-nums text-blue-300">{fmtWon(domesticInvested)}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[9px] text-slate-600">{totalValue > 0 ? ((domesticInvested / totalValue) * 100).toFixed(0) : 0}%</span>
                    <span className={`text-[9px] font-medium ${krActualPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{krActualPct > 0 ? '+' : ''}{krActualPct.toFixed(1)}%</span>
                  </div>
                  <div className="text-[8px] text-slate-600 mt-0.5">{chains.length}종목</div>
                </div>
                <div className="rounded-xl px-3 py-2.5 bg-slate-800/40 border border-white/[0.06]">
                  <div className="text-[9px] text-slate-500 mb-0.5">현금</div>
                  <div className="text-sm font-bold tabular-nums text-slate-200">{fmtWon(domesticCash + overseasCashKrw)}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[9px] text-slate-600">{totalValue > 0 ? (((domesticCash + overseasCashKrw) / totalValue) * 100).toFixed(0) : 0}%</span>
                  </div>
                  <div className="text-[8px] text-slate-600 mt-0.5 space-y-0.5">
                    <div>KRW {fmt(Math.round(domesticCash))}</div>
                    {overseasCashUsd > 0 && <div>USD ${overseasCashUsd.toFixed(0)}</div>}
                  </div>
                </div>
                <div className={`rounded-xl px-3 py-2.5 ${usActualPct >= 0 ? 'bg-indigo-950/40 border border-indigo-500/10' : 'bg-rose-950/30 border border-rose-500/10'}`}>
                  <div className="text-[9px] text-slate-500 mb-0.5">🇺🇸 미국주식</div>
                  <div className="text-sm font-bold tabular-nums text-indigo-300">{fmtUsd(overseasInvestedUsd)}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[9px] text-slate-600">{totalValue > 0 ? ((overseasMarketKrw / totalValue) * 100).toFixed(0) : 0}%</span>
                    <span className={`text-[9px] font-medium ${usActualPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{usActualPct > 0 ? '+' : ''}{usActualPct.toFixed(1)}%</span>
                  </div>
                  <div className="text-[8px] text-slate-600 mt-0.5">{usHoldings.length}종목</div>
                </div>
              </div>
              {/* 시장 레짐 인디케이터 */}
              {strategy && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                    strategy.mode === 'DEFENSE' ? 'bg-amber-500/20 text-amber-300' :
                    strategy.mode === 'SNIPER' ? 'bg-violet-500/20 text-violet-300' :
                    'bg-emerald-500/20 text-emerald-300'
                  }`}>{strategy.mode ?? 'SWING'}</span>
                  <span className="text-[10px] text-slate-500">
                    {strategy.mode === 'DEFENSE' ? '방어 모드 — 자동 현금화 진행 중'
                      : strategy.mode === 'SNIPER' ? '저격 모드 — 급락 매수 대기'
                      : '일반 운용 중'}
                  </span>
                  {dash?.riskLimits?.targetCashRatio != null && (
                    <span className="text-[9px] text-slate-600 ml-auto">현금 목표 {Math.round(dash.riskLimits.targetCashRatio * 100)}%</span>
                  )}
                </div>
              )}
              {/* 목표 비중 바 */}
              <div>
                <div className="flex justify-between text-[9px] text-slate-500 mb-1">
                  <span>🇰🇷 국내 목표 {krTarget}%</span>
                  <span>🇺🇸 해외 목표 {usTarget}%</span>
                </div>
                <div className="h-2 rounded-full overflow-hidden bg-white/[0.04] flex">
                  <div className="h-full bg-blue-500/70 transition-all duration-500" style={{ width: `${krTarget}%` }} />
                  <div className="h-full bg-indigo-500/70 transition-all duration-500" style={{ width: `${usTarget}%` }} />
                </div>
              </div>
              {/* 프리셋 버튼 — 5개 */}
              <div className="flex gap-1.5 flex-wrap">
                {[
                  { label: '국내 70%', kr: 70, us: 30 },
                  { label: '반반 50%', kr: 50, us: 50 },
                  { label: '해외 70%', kr: 30, us: 70 },
                ].map(({ label, kr, us }) => (
                  <button key={label} onClick={() => applyPreset(kr, us)}
                    className={`flex-1 text-[10px] py-1.5 rounded-lg font-semibold transition-all ${krTarget === kr ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-slate-300'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* 접기/펼치기: 종목별 비중 */}
            {showPortfolio && (
              <div className="p-4 sm:p-5 space-y-4 border-t border-white/[0.04]">
                {/* 현금 vs 투자 비율 바 */}
                <div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mb-2">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-blue-500 to-cyan-500 shrink-0" />투자 중 {investedPctExact.toFixed(0)}%</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-slate-400/50 shrink-0" />국내 현금 {cashPctExact.toFixed(0)}%</span>
                    {overseasCashKrw > 0 && <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-400/70 shrink-0" />해외 현금 {overseasCashPctExact.toFixed(0)}%</span>}
                  </div>
                  <div className="h-3 bg-white/[0.04] rounded-full overflow-hidden">
                    <div className="h-full flex">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 transition-all duration-500" style={{ width: `${pctClamp(investedPctExact)}%` }} />
                      <div className="h-full bg-slate-400/50 transition-all duration-500" style={{ width: `${pctClamp(cashPctExact)}%` }} />
                      {overseasCashKrw > 0 && <div className="h-full bg-indigo-400/70 transition-all duration-500" style={{ width: `${pctClamp(overseasCashPctExact)}%` }} />}
                    </div>
                  </div>
                </div>
                {/* 종목별 비중 — 국내 */}
                {chains.length > 0 && (
                  <div className="space-y-2.5">
                    {domesticInvested > 0 && usHoldings.length > 0 && (
                      <div className="text-[10px] text-slate-500 font-medium">국내 ({fmtWon(domesticInvested)})</div>
                    )}
                    {chains.map((ch: any, i: number) => {
                      const inv = Number(ch.invested) || 0;
                      const pct = totalInvested > 0 ? (inv / totalInvested) * 100 : 0;
                      return (
                        <div key={`kr-${i}`}>
                          <div className="flex justify-between text-[11px] mb-1">
                            <span className="font-medium text-slate-300">
                              {(() => {
                                const resolved = toDisplayName(ch.stock_name, ch.stock_code);
                                return isUnresolvedStockName(resolved, ch.stock_code) ? getStockName(ch.stock_code) : resolved;
                              })()}
                            </span>
                            <span className="text-slate-500">{fmtWon(inv)} ({pct.toFixed(0)}%)</span>
                          </div>
                          <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${ch.unrealizedPnl >= 0 ? 'bg-emerald-500/60' : 'bg-rose-500/60'}`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* 종목별 비중 — 해외 */}
                {usHoldings.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-white/[0.04]">
                    <div className="text-[10px] text-slate-500 font-medium mb-2">해외 ({fmtWon(overseasInvestedKrw)})</div>
                    <div className="space-y-2">
                      {usHoldings.map((h: any, i: number) => {
                        const invUsd = h.avg_price * h.quantity;
                        const invKrw = invUsd * fxRate;
                        const pct = totalInvested > 0 ? (invKrw / totalInvested) * 100 : 0;
                        const priceData = usW.find((s: any) => s.code === h.stock_code);
                        const curPriceAlloc = (priceData?.price ?? 0) > 0 ? priceData!.price : (h.last_price ?? 0);
                        const curPnl = curPriceAlloc > 0 ? (curPriceAlloc - h.avg_price) * h.quantity : 0;
                        return (
                          <div key={`us-${i}`}>
                            <div className="flex justify-between text-[11px] mb-1">
                              <span className="font-medium text-blue-300">{toDisplayName(priceData?.name, h.stock_code)}</span>
                              <span className="text-slate-500">{fmtWon(invKrw)} ({pct.toFixed(0)}%)</span>
                            </div>
                            <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${curPnl >= 0 ? 'bg-blue-500/60' : 'bg-rose-500/60'}`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export default HomeView;
