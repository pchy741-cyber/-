'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui';
import { api, pc, fmtWon, fmtTime, fmtPct } from '../lib/utils';
import type { StrategyLabOverview, StrategyGraduation, StrategyInsightRow, TuningStatus } from '../types';
import { STRATEGY_LABELS, SIM_AMOUNTS } from './strategy-lab/constants';
import { StrategyCard } from './strategy-lab/StrategyCard';
import { PipelineRow } from './strategy-lab/PipelineRow';
import { ApprovalCard } from './strategy-lab/ApprovalCard';
import { InsightChip } from './strategy-lab/InsightChip';
import { HistoryRow } from './strategy-lab/HistoryRow';
import { TuningPanel } from './strategy-lab/TuningPanel';

interface Props {
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  viewMode: 'paper' | 'live';
  confirm: (opts: { title: string; description?: string; confirmLabel?: string; confirmVariant?: 'danger' | 'primary' }) => Promise<boolean>;
}

export default function StrategyLabView({ toast, viewMode, confirm }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<StrategyLabOverview[]>([]);
  const [pending, setPending] = useState<StrategyGraduation[]>([]);
  const [history, setHistory] = useState<StrategyGraduation[]>([]);
  const [insights, setInsights] = useState<StrategyInsightRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [simAmount, setSimAmount] = useState(1000);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [tuning, setTuning] = useState<TuningStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, ap, ins, tun] = await Promise.all([
        api('/strategy-lab/overview'),
        api('/strategy-lab/approvals'),
        api('/strategy-lab/insights'),
        api('/strategy-lab/tuning-status').catch(() => null),
      ]);
      setStrategies(ov.strategies || []);
      setPending(ap.pending || []);
      setHistory(ap.history || []);
      setInsights(ins.insights || []);
      if (tun) setTuning(tun);
    } catch (e: any) {
      const msg = e.message || '로딩 실패';
      setError(msg);
      toast(msg, 'err');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const handleApprove = async (id: number) => {
    if (!await confirm({ title: '졸업 승인', description: '이 전략을 실전 적용하시겠습니까?', confirmLabel: '승인', confirmVariant: 'primary' })) return;
    try {
      await api(`/strategy-lab/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      toast('승인 완료', 'ok');
      load();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const handleReject = async (id: number) => {
    if (!await confirm({ title: '졸업 거부', description: '추가 Paper 테스트가 필요합니까?', confirmLabel: '거부', confirmVariant: 'danger' })) return;
    try {
      await api(`/strategy-lab/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'CEO 판단' }) });
      toast('거부 완료', 'ok');
      load();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const handleRefreshInsights = async () => {
    setRefreshing(true);
    try {
      await api('/strategy-lab/refresh-insights', { method: 'POST' });
      toast('인사이트 분석 시작 (1~2분 후 새로고침)', 'info');
    } catch (e: any) { toast(e.message, 'err'); }
    setRefreshing(false);
  };

  const activeStrategies = useMemo(() =>
    strategies.filter(s => {
      const perf = (viewMode === 'live' && s.live) ? s.live : s.paper;
      return perf && perf.totalTrades > 0;
    }),
    [strategies, viewMode]
  );

  const agg = useMemo(() =>
    activeStrategies.reduce((a, s) => {
      const p = (viewMode === 'live' && s.live && s.live.totalTrades > 0) ? s.live : s.paper!;
      a.trades += p.totalTrades;
      a.wins += p.wins;
      a.pnlKrw += p.totalPnlKrw;
      a.pnlPctSum += p.totalPnlPct * p.totalTrades;
      return a;
    }, { trades: 0, wins: 0, pnlKrw: 0, pnlPctSum: 0 }),
    [activeStrategies, viewMode]
  );

  const aggWinRate = agg.trades > 0 ? agg.wins / agg.trades : 0;
  const aggAvgPnlPct = agg.trades > 0 ? agg.pnlPctSum / agg.trades : 0;
  const monthlyReturnPct = aggAvgPnlPct;
  const capitalKrw = simAmount * 10000;

  const bestStrategy = useMemo(() => {
    if (!activeStrategies.length) return null;
    return activeStrategies.reduce((best, s) => {
      const sPnl = ((viewMode === 'live' && s.live) ? s.live : s.paper)?.totalPnlKrw ?? -Infinity;
      const bestPnl = ((viewMode === 'live' && best.live) ? best.live : best.paper)?.totalPnlKrw ?? -Infinity;
      return sPnl > bestPnl ? s : best;
    }, activeStrategies[0]);
  }, [activeStrategies, viewMode]);

  const actionableInsights = useMemo(() =>
    insights.filter(i => i.is_actionable).slice(0, 3),
    [insights]
  );

  if (loading) return (
    <div className="flex justify-center items-center py-20">
      <div className="relative">
        <div className="w-10 h-10 border-2 border-cyan-500/30 rounded-full animate-spin" style={{ borderTopColor: 'rgb(6 182 212)' }} />
        <div className="absolute inset-0 w-10 h-10 border-2 border-transparent rounded-full animate-spin" style={{ borderRightColor: 'rgb(6 182 212 / 0.2)', animationDirection: 'reverse', animationDuration: '1.5s' }} />
      </div>
    </div>
  );

  if (error) return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="rounded-2xl border border-rose-500/20 bg-rose-950/20 p-6 text-center space-y-3">
        <div className="text-2xl">⚠️</div>
        <div className="text-sm font-semibold text-rose-400">전략 Lab 로딩 실패</div>
        <div className="text-xs text-slate-500">{error}</div>
        <button onClick={() => load()} className="mt-2 px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-xs text-slate-300 transition-colors">
          다시 시도
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {/* ─── Paper 모드 경고 배너 ─── */}
      {viewMode === 'paper' && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-950/15 text-amber-400">
          <span className="text-sm shrink-0">⚠️</span>
          <span className="text-xs font-medium">연습 모드 보기 중 — 아래 성과는 Paper Trading 결과이며 실전 손익과 다릅니다</span>
        </div>
      )}
      {/* ─── Hero Stats Bar ─── */}
      <div className="grid grid-cols-3 gap-2">
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] px-3 py-3 bg-gradient-to-br from-slate-900/80 to-slate-950/40">
          <div className="text-[9px] text-slate-500 font-medium tracking-wider mb-0.5">P&L</div>
          <div className={`text-base sm:text-xl font-black tracking-tight truncate ${pc(agg.pnlKrw)}`}>
            {agg.trades > 0 ? fmtWon(agg.pnlKrw) : '-'}
          </div>
          <div className="text-[9px] text-slate-600 mt-0.5">{agg.trades}건</div>
        </div>

        <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] px-3 py-3 bg-gradient-to-br from-slate-900/80 to-slate-950/40">
          <div className="text-[9px] text-slate-500 font-medium tracking-wider mb-0.5">BEST</div>
          {bestStrategy ? (
            <>
              <div className="text-base sm:text-lg font-black text-emerald-400 truncate">
                {STRATEGY_LABELS[bestStrategy.mode] || bestStrategy.mode}
              </div>
              <div className="text-[9px] text-emerald-500/70 mt-0.5 truncate">
                {fmtPct((bestStrategy[viewMode] ?? bestStrategy.paper)?.totalPnlPct)}
              </div>
            </>
          ) : <div className="text-base text-slate-600">-</div>}
        </div>

        <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] px-3 py-3 bg-gradient-to-br from-slate-900/80 to-slate-950/40">
          <div className="text-[9px] text-slate-500 font-medium tracking-wider mb-0.5">승률</div>
          <div className={`text-base sm:text-xl font-black ${aggWinRate >= 0.55 ? 'text-emerald-400' : aggWinRate >= 0.45 ? 'text-amber-400' : 'text-rose-400'}`}>
            {agg.trades > 0 ? `${(aggWinRate * 100).toFixed(0)}%` : '-'}
          </div>
          <div className="text-[9px] text-slate-600 mt-0.5">{agg.wins}W/{agg.trades - agg.wins}L</div>
        </div>
      </div>

      {/* ─── AI 자동 튜닝 ─── */}
      {tuning && <TuningPanel tuning={tuning} />}

      {/* ─── AI Recommendation Card ─── */}
      {actionableInsights.length > 0 && (
        <div className="relative overflow-hidden rounded-2xl border border-cyan-500/15 bg-gradient-to-r from-cyan-950/30 via-slate-900/40 to-transparent p-4">
          <div className="absolute -top-6 -right-6 w-24 h-24 bg-cyan-500/[0.04] rounded-full blur-xl" />
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded-lg bg-cyan-500/15 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-400">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span className="text-xs font-bold text-cyan-400 tracking-wide">AI 추천</span>
          </div>
          <div className="space-y-2">
            {actionableInsights.map(i => (
              <div key={i.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                <div className={`w-1.5 h-8 rounded-full shrink-0 ${Number(i.avg_pnl_pct) >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-slate-200 truncate">{i.insight_text}</div>
                  <div className="text-[10px] text-slate-500">{STRATEGY_LABELS[i.strategy_mode] || i.strategy_mode} / {i.condition_label}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-xs font-bold ${pc(Number(i.avg_pnl_pct))}`}>{fmtPct(Number(i.avg_pnl_pct))}</div>
                  <div className="text-[9px] text-slate-500">{i.sample_count}건</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── CEO Approval Queue ─── */}
      {pending.length > 0 && (
        <div className="rounded-2xl border border-amber-500/20 bg-gradient-to-r from-amber-950/20 to-transparent p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-xs font-bold text-amber-400">승인 대기 {pending.length}건</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {pending.map(g => (
              <ApprovalCard key={g.id} g={g} onApprove={handleApprove} onReject={handleReject} />
            ))}
          </div>
        </div>
      )}

      {/* ─── Strategy Cards ─── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-200">전략 ({activeStrategies.length})</h3>
            {activeStrategies.length === 0 && (
              <span className="text-[10px] text-slate-600">Paper 루프 가동 중</span>
            )}
          </div>
          <button onClick={() => load()} className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors px-2 py-1 rounded-lg hover:bg-white/[0.04]">
            새로고침
          </button>
        </div>

        {activeStrategies.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.04] p-10 text-center">
            <div className="text-2xl mb-3 opacity-30">⏳</div>
            <div className="text-sm text-slate-500">AI가 자동으로 Paper 매매 중</div>
            <div className="text-[10px] text-slate-600 mt-1">데이터 수집 완료 시 자동 표시</div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeStrategies.map(s => (
              <StrategyCard
                key={s.mode}
                s={s}
                expanded={expandedCard === s.mode}
                onToggle={() => setExpandedCard(expandedCard === s.mode ? null : s.mode)}
                viewMode={viewMode}
              />
            ))}
          </div>
        )}
      </div>

      {/* ─── Graduation Pipeline ─── */}
      {strategies.some(s => s.graduation) && (
        <div className="rounded-2xl border border-white/[0.04] bg-slate-900/30 p-4">
          <h3 className="text-xs font-bold text-slate-400 tracking-wider mb-4">GRADUATION PIPELINE</h3>
          <div className="space-y-2.5">
            {strategies.filter(s => s.graduation || (s.paper && s.paper.totalTrades > 0)).map(s => (
              <PipelineRow key={s.mode} s={s} />
            ))}
          </div>
        </div>
      )}

      {/* ─── Profit Simulator ─── */}
      <div className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-slate-900/60 to-slate-950/30 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-200">수익 시뮬레이터</h3>
          <div className="text-[9px] text-slate-600 bg-white/[0.03] px-2 py-0.5 rounded-full">Paper 기반</div>
        </div>

        <div className="flex gap-1.5">
          {SIM_AMOUNTS.map(a => (
            <button key={a} onClick={() => setSimAmount(a)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                simAmount === a
                  ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/25 shadow-sm shadow-cyan-500/10'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'
              }`}>
              {a >= 10000 ? `${a / 10000}억` : `${a}만`}
            </button>
          ))}
        </div>

        {agg.trades > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <ProjCard label="1개월" capital={capitalKrw} returnPct={monthlyReturnPct} />
              <ProjCard label="6개월" capital={capitalKrw} returnPct={monthlyReturnPct * 6} />
              <ProjCard label="1년" capital={capitalKrw} returnPct={monthlyReturnPct * 12} />
            </div>
            <div className="text-[9px] text-slate-600 text-center pt-1">
              Paper {agg.trades}건 기준 / 승률 {(aggWinRate * 100).toFixed(0)}% / 월 {monthlyReturnPct >= 0 ? '+' : ''}{monthlyReturnPct.toFixed(1)}% · 과거 실적 기반 추정
            </div>
          </>
        ) : (
          <div className="text-center text-slate-500 text-sm py-6">데이터 수집 중...</div>
        )}
      </div>

      {/* ─── Fact Insights (chips) ─── */}
      {insights.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200">팩트 인사이트</h3>
            <button
              onClick={handleRefreshInsights}
              disabled={refreshing}
              className="text-[10px] text-slate-500 hover:text-cyan-400 transition-colors px-2 py-1 rounded-lg hover:bg-white/[0.04] disabled:opacity-40"
            >
              {refreshing ? '분석 중...' : '재분석'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {insights.map(i => <InsightChip key={i.id} i={i} />)}
          </div>
        </div>
      )}

      {/* ─── History (compact) ─── */}
      {history.length > 0 && (
        <div className="rounded-2xl border border-white/[0.04] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.04]">
            <h3 className="text-xs font-bold text-slate-400 tracking-wider">졸업 이력</h3>
          </div>
          <div className="divide-y divide-white/[0.03]">
            {history.slice(0, 5).map(h => <HistoryRow key={h.id} h={h} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── ProjCard (tiny, kept inline) ───────────────────────────────── */

function ProjCard({ label, capital, returnPct }: { label: string; capital: number; returnPct: number }) {
  const profit = capital * returnPct / 100;
  const isPos = profit >= 0;
  return (
    <div className="rounded-xl border border-white/[0.04] p-3 text-center bg-white/[0.01]">
      <div className="text-[9px] text-slate-500 font-medium tracking-wider mb-1">{label}</div>
      <div className={`text-base font-black ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
        {isPos ? '+' : ''}{fmtWon(profit)}
      </div>
      <div className={`text-[10px] font-bold mt-0.5 ${isPos ? 'text-emerald-500/60' : 'text-rose-500/60'}`}>
        {isPos ? '+' : ''}{returnPct.toFixed(1)}%
      </div>
    </div>
  );
}
