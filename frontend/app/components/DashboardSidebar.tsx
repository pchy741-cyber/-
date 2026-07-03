'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Modal } from '@/components/ui';

type Tab = 'home' | 'trades' | 'journal' | 'watchlist' | 'news' | 'research' | 'settings' | 'dividend' | 'strategy-lab' | 'ai-cost';

interface QAIssue {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  category: string;
  title: string;
  detail: string;
}
interface QAReport {
  runAt: string;
  elapsedSec: number;
  issues: QAIssue[];
  critical: number;
  warning: number;
  info: number;
  status: 'pass' | 'warn' | 'fail';
}

export const DashboardSidebar = React.memo(function DashboardSidebar({ tab, setTab, mobileMenu, setMobileMenu, health, dash, viewMode, switchView, killSwitch, toggleKill, lastUpdate, load, featureFlags, isPaper, isUS, theme, loopStatus, newInsightCount }: {
  tab: Tab; setTab: (t: Tab) => void;
  mobileMenu: boolean; setMobileMenu: (v: boolean) => void;
  health: any; dash: any;
  viewMode: 'live' | 'paper'; switchView: (m: 'live' | 'paper') => void;
  killSwitch: any; toggleKill: (scope?: 'KR' | 'OVERSEAS') => Promise<void>;
  lastUpdate: Date; load: (force?: boolean) => void;
  featureFlags: Record<string, boolean>;
  isPaper: boolean; isUS: boolean; theme: any;
  loopStatus?: any;
  newInsightCount?: number;
}) {
  const isKillActive = killSwitch?.kr?.active || killSwitch?.overseas?.active;

  // QA Watchdog 상태
  const [qaReport, setQaReport] = useState<QAReport | null>(null);
  const [qaReports, setQaReports] = useState<QAReport[]>([]);
  const [qaModalOpen, setQaModalOpen] = useState(false);
  const [qaRunning, setQaRunning] = useState(false);

  const fetchQA = useCallback(async () => {
    try {
      const key = typeof window !== 'undefined' ? localStorage.getItem('api_key') : null;
      const headers: Record<string, string> = key ? { 'x-api-key': key } : {};
      const res = await fetch('/api/qa/latest', { headers });
      if (res.ok) { const data = await res.json(); if (data) setQaReport(data); }
    } catch { /* ignore */ }
  }, []);

  const fetchQAReports = useCallback(async () => {
    try {
      const key = typeof window !== 'undefined' ? localStorage.getItem('api_key') : null;
      const headers: Record<string, string> = key ? { 'x-api-key': key } : {};
      const res = await fetch('/api/qa/reports', { headers });
      if (res.ok) setQaReports(await res.json());
    } catch { /* ignore */ }
  }, []);

  const runQA = useCallback(async () => {
    setQaRunning(true);
    try {
      const key = typeof window !== 'undefined' ? localStorage.getItem('api_key') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) };
      await fetch('/api/qa/run', { method: 'POST', headers });
      // 5초 후 결과 가져오기
      setTimeout(() => { fetchQA(); fetchQAReports(); setQaRunning(false); }, 8000);
    } catch { setQaRunning(false); }
  }, [fetchQA, fetchQAReports]);

  useEffect(() => { fetchQA(); }, [fetchQA]);

  const allNavItems: { id: Tab; label: string; icon: string; paperOnly?: boolean }[] = [
    { id: 'home', label: '대시보드', icon: '📊' },
    { id: 'trades', label: '매매내역', icon: '📋' },
    { id: 'journal', label: '매매일지', icon: '📓' },
    { id: 'watchlist', label: '감시목록', icon: '👁' },
    { id: 'news', label: '뉴스', icon: '📰' },
    { id: 'research', label: '퀀트봇', icon: '🤖' },
    { id: 'dividend', label: '배당', icon: '💰' },
    { id: 'strategy-lab', label: '전략 Lab', icon: '🧪' },
    { id: 'ai-cost', label: 'AI 비용', icon: '🤖' },
    { id: 'settings', label: '설정', icon: '⚙️' },
  ];
  const navItems = allNavItems.filter(item => !item.paperOnly || isPaper);

  return (
    <>
      {mobileMenu && <div className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setMobileMenu(false)} />}
      <aside className={`fixed lg:static inset-y-0 left-0 z-50 w-[220px] backdrop-blur-xl flex flex-col shrink-0 transform transition-all duration-500 bg-[var(--theme-side-95)] border-r border-[var(--theme-border)] ${mobileMenu ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="px-5 py-5 border-b border-white/[0.04]">
          <h1 className="text-lg font-black tracking-tight bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">AI Bot</h1>
          <p className="text-[10px] text-slate-600 mt-0.5 font-medium">Auto Bot v10.9</p>
        </div>

        <div className="px-4 py-3.5 space-y-2.5 border-b border-white/[0.04]">
          {[
            { ok: health?.status === 'ok', label: health?.status === 'ok' ? '정상 작동' : '오류 발생' },
            { ok: health?.marketOpen, label: `한국 ${health?.marketOpen ? '거래 중' : '쉬는 중'}` },
            { ok: health?.usMarketOpen, label: `미국 ${health?.usMarketOpen ? '거래 중' : '쉬는 중'}` },
            { ok: dash?.tradingMode !== 'paper', label: dash?.tradingMode === 'paper' ? '연습 거래 중' : '실전 거래 중', amber: dash?.tradingMode === 'paper' },
            { ok: viewMode === 'live', label: viewMode === 'paper' ? '연습 보기 중' : '실전 보기', amber: viewMode === 'paper' },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-2.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${s.amber ? 'bg-amber-400' : s.ok ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="text-slate-500 font-medium">{s.label}</span>
            </div>
          ))}
        </div>

        {/* AI Loop 상태 패널 */}
        {loopStatus?.active && (
          <div className="mx-3 mt-3 rounded-xl bg-gradient-to-br from-emerald-500/10 via-cyan-500/5 to-transparent border border-emerald-500/20 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-[11px] font-bold text-emerald-400">AI Loop 연결됨</span>
            </div>
            <div className="space-y-1.5 text-[10px] text-slate-400">
              <div className="flex justify-between">
                <span>실행</span>
                <span className="text-slate-300 font-medium">{loopStatus.totalRuns}회</span>
              </div>
              {loopStatus.brief && (
                <div className="flex justify-between">
                  <span>전략</span>
                  <span className="text-cyan-400 font-medium">{loopStatus.brief.regime}/{loopStatus.brief.risk}</span>
                </div>
              )}
              {loopStatus.autoPilot?.overridesSet > 0 && (
                <div className="flex justify-between">
                  <span>AP 조절</span>
                  <span className="text-amber-400 font-medium">{loopStatus.autoPilot.overridesSet}건</span>
                </div>
              )}
              {loopStatus.autoPilot?.decisions?.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-white/5 space-y-0.5">
                  {loopStatus.autoPilot.decisions.slice(0, 3).map((d: string, i: number) => (
                    <div key={i} className="text-[9px] text-slate-500 truncate" title={d}>
                      {d}
                    </div>
                  ))}
                </div>
              )}
              {loopStatus.lastRunResult === 'error' && (
                <div className="text-red-400 font-medium">오류 {loopStatus.consecutiveErrors}회</div>
              )}
            </div>
          </div>
        )}

        {/* QA Watchdog 상태 패널 */}
        <button
          className={`mx-3 mt-2 w-[calc(100%-24px)] text-left rounded-xl border p-3 space-y-1.5 transition-all hover:brightness-110 ${
            !qaReport ? 'bg-slate-500/5 border-slate-500/15'
            : qaReport.status === 'pass' ? 'bg-emerald-500/[0.06] border-emerald-500/20'
            : qaReport.status === 'warn' ? 'bg-amber-500/[0.08] border-amber-500/25'
            : 'bg-red-500/[0.08] border-red-500/30'
          }`}
          onClick={() => { setQaModalOpen(true); fetchQAReports(); }}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm">🔍</span>
            <span className={`text-[11px] font-bold ${!qaReport ? 'text-slate-500' : qaReport.status === 'pass' ? 'text-emerald-400' : qaReport.status === 'warn' ? 'text-amber-400' : 'text-red-400'}`}>
              QA {!qaReport ? '대기' : qaReport.status === 'pass' ? '통과' : `${qaReport.critical + qaReport.warning}건`}
            </span>
            {qaReport && (qaReport as any).score != null && (
              <span className={`ml-auto text-[11px] font-black ${(qaReport as any).score >= 80 ? 'text-emerald-400' : (qaReport as any).score >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                {(qaReport as any).score}
              </span>
            )}
          </div>
          {qaReport && (
            <div className="flex items-center gap-3 text-[10px] text-slate-500">
              {qaReport.critical > 0 && <span className="text-red-400">{qaReport.critical} CRITICAL</span>}
              {qaReport.warning > 0 && <span className="text-amber-400">{qaReport.warning} WARN</span>}
              {qaReport.status === 'pass' && <span className="text-emerald-400">이상 없음</span>}
              <span className="ml-auto">{new Date(qaReport.runAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          )}
        </button>

        <nav className="flex-1 p-2.5 space-y-0.5">
          {navItems.map(item => (
            <button key={item.id} onClick={() => { setTab(item.id); setMobileMenu(false); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl text-[13px] flex items-center gap-3 transition-all duration-150 ${tab === item.id ? 'bg-blue-500/10 text-blue-400 font-semibold ring-1 ring-blue-500/20' : 'text-slate-500 hover:bg-white/[0.03] hover:text-slate-300'}`}>
              <span className="text-sm">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === 'settings' && (newInsightCount ?? 0) > 0 && tab !== 'settings' && (
                <span className="ml-auto bg-blue-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center animate-pulse">
                  {newInsightCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-white/[0.04] space-y-2">
          <Button
            variant={isKillActive ? 'danger' : 'success'}
            size="md"
            className={`w-full py-3 ${isKillActive ? 'shadow-lg shadow-rose-600/30' : ''}`}
            onClick={() => toggleKill()}
          >
            {isKillActive ? '⏸ 매매 중단 중' : '▶ 자동매매 중'}
          </Button>
          {isKillActive && (
            <div className="flex gap-1">
              {killSwitch?.kr?.active && (
                <Button variant="amber" size="sm" className="flex-1 py-1.5 text-[10px]" onClick={() => toggleKill('KR')}>
                  국내 해제
                </Button>
              )}
              {killSwitch?.overseas?.active && (
                <Button variant="violet" size="sm" className="flex-1 py-1.5 text-[10px]" onClick={() => toggleKill('OVERSEAS')}>
                  해외 해제
                </Button>
              )}
            </div>
          )}
          <Button variant="ghost" size="sm" className="w-full py-2 text-[10px] text-slate-600 hover:text-slate-400" onClick={() => load(true)}>
            새로고침 · {lastUpdate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </Button>
        </div>
      </aside>

      {/* QA Watchdog 상세 모달 */}
      <Modal open={qaModalOpen} onClose={() => setQaModalOpen(false)} maxWidth="max-w-lg">
        <div className="p-5 max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              🔍 QA Watchdog 감시 로그
            </h2>
            <button
              className={`text-[10px] px-3 py-1.5 rounded-lg font-bold transition-all ${qaRunning ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'}`}
              disabled={qaRunning}
              onClick={runQA}
            >
              {qaRunning ? '검사 중...' : '수동 실행'}
            </button>
          </div>

          {qaReports.length === 0 && (
            <p className="text-slate-500 text-xs text-center py-8">아직 QA 실행 기록 없음</p>
          )}

          {qaReports.map((report, idx) => {
            const statusColor = report.status === 'pass' ? 'emerald' : report.status === 'warn' ? 'amber' : 'red';
            const statusLabel = report.status === 'pass' ? '통과' : report.status === 'warn' ? '경고' : '실패';
            const time = new Date(report.runAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

            return (
              <div key={idx} className="mb-3 rounded-xl border border-white/[0.06] overflow-hidden">
                {/* 리포트 헤더 */}
                <div className={`px-4 py-2.5 flex items-center gap-3 border-b border-white/[0.04] ${
                  report.status === 'pass' ? 'bg-emerald-500/5' : report.status === 'warn' ? 'bg-amber-500/5' : 'bg-red-500/5'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${
                    report.status === 'pass' ? 'bg-emerald-500' : report.status === 'warn' ? 'bg-amber-500' : 'bg-red-500'
                  }`} />
                  <span className={`text-[11px] font-bold ${
                    report.status === 'pass' ? 'text-emerald-500' : report.status === 'warn' ? 'text-amber-500' : 'text-red-500'
                  }`}>
                    {statusLabel}
                  </span>
                  <span className="text-[10px] text-slate-500 ml-auto">{time} · {report.elapsedSec.toFixed(1)}s</span>
                </div>

                {/* 이슈 목록 */}
                {report.issues.length === 0 ? (
                  <div className="px-4 py-3 text-[11px] text-emerald-400/70">전수조사 통과 — 이상 없음</div>
                ) : (
                  <div className="px-3 py-2 space-y-1.5">
                    {report.issues.map((issue, j) => {
                      const sevColor = issue.severity === 'CRITICAL' ? '#ef4444' : issue.severity === 'WARNING' ? '#f59e0b' : '#3b82f6';
                      const sevDot = issue.severity === 'CRITICAL' ? '🔴' : issue.severity === 'WARNING' ? '🟡' : '🔵';
                      return (
                        <div key={j} className={`rounded-lg px-3 py-2 bg-white/[0.02] border-l-2 ${
                          issue.severity === 'CRITICAL' ? 'border-l-red-500' : issue.severity === 'WARNING' ? 'border-l-amber-500' : 'border-l-blue-500'
                        }`}>
                          <div className="text-[11px] font-medium text-slate-200">
                            {sevDot} <span className="text-slate-500">[{issue.category}]</span> {issue.title}
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">{issue.detail}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Modal>
    </>
  );
});
