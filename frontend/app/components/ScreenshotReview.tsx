'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../lib/utils';
import { Spinner } from '@/components/ui';
import type { ScreenshotProps, CopilotData, XrayData } from './screenshot/screenshot-types';
import { CopilotResultPanel } from './screenshot/CopilotResultPanel';
import { AutoPilotButton } from './screenshot/AutoPilotButton';
import { timeAgo } from './screenshot/screenshot-utils';

// sessionStorage 키 — 결과 영속화 (페이지 이탈 후 복귀 시 유지)
const SS_KEY = 'aab_capture_result';

function loadCache(): { copilot: CopilotData | null; xray: XrayData | null; time: string | null } {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return { copilot: null, xray: null, time: null };
    const parsed = JSON.parse(raw);
    if (parsed.time && Date.now() - new Date(parsed.time).getTime() > 30 * 60_000) {
      sessionStorage.removeItem(SS_KEY);
      return { copilot: null, xray: null, time: null };
    }
    return parsed;
  } catch { return { copilot: null, xray: null, time: null }; }
}

function saveCache(copilot: CopilotData | null, xray: XrayData | null, time: string | null) {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify({ copilot, xray, time })); } catch {}
}

// copilot-lite → CopilotData 변환
const RISK_META: Record<string, { max: number; unit: string }> = {
  mdd: { max: 10, unit: '%' },
  loss_streak: { max: 10, unit: '연패' },
  kill_switch: { max: 1, unit: '' },
  old_holdings: { max: 5, unit: '종목' },
  concentration: { max: 100, unit: '%' },
  no_trades: { max: 7, unit: '일' },
  high_volatility: { max: 5, unit: '%' },
};

function buildCopilotFromLite(lite: any, mode: string): CopilotData {
  return {
    timestamp: lite.timestamp || new Date().toISOString(),
    mode,
    integrity: [],
    risk: (lite.issues || []).map((issue: any) => {
      const num = Number((issue.label.match(/[\d.]+/) ?? ['0'])[0]) || 0;
      const meta = RISK_META[issue.id] ?? { max: 100, unit: '' };
      return {
        id: issue.id,
        label: issue.label,
        value: issue.id === 'kill_switch' ? 1 : issue.id === 'no_trades' ? 7 : num,
        max: meta.max,
        unit: meta.unit,
        level: issue.level as 'ok' | 'warn' | 'danger',
      };
    }),
    actions: (lite.actions || []).map((a: any) => {
      const parts = (a.action || '').split('—');
      return {
        type: a.level === 'danger' ? 'cut_loss' : a.level === 'warn' ? 'anomaly' : 'rebalance',
        icon: a.level === 'danger' ? '!' : '?',
        title: parts[0]?.trim() || a.action,
        detail: a.apiHint ? `${a.action}\n힌트: ${a.apiHint}` : a.action,
        urgency: (a.level === 'danger' ? 'high' : 'mid') as 'high' | 'mid' | 'low',
      };
    }),
  };
}

// QA Report → XrayData 변환
function buildXrayFromQA(qa: any): XrayData | null {
  if (!qa) return null;
  const issues = qa.issues ?? [];
  if (issues.length === 0 && !qa.score) return null;
  const sev = (s: string) => s === 'CRITICAL' ? 'danger' : s === 'WARNING' ? 'warn' : 'ok';
  return {
    ts: qa.runAt || new Date().toISOString(),
    mode: 'QA Watchdog',
    summary: {
      danger: qa.critical || 0,
      warn: qa.warning || 0,
      ok: Math.max(0, issues.length - (qa.critical || 0) - (qa.warning || 0)),
      total: issues.length,
    },
    checks: issues.map((issue: any, i: number) => ({
      id: `qa_${i}`,
      status: sev(issue.severity) as 'ok' | 'warn' | 'danger',
      label: `[${issue.category}] ${issue.title}`,
      detail: issue.detail,
    })),
  };
}

export default function ScreenshotReview(props: ScreenshotProps) {
  const { viewMode } = props;
  const [checking, setChecking] = useState(false);
  const [copilot, setCopilot] = useState<CopilotData | null>(null);
  const [xray, setXray] = useState<XrayData | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [lastCheckTime, setLastCheckTime] = useState<string | null>(null);

  // 캐시 복원
  useEffect(() => {
    const cached = loadCache();
    if (cached.copilot || cached.xray) {
      setCopilot(cached.copilot);
      setXray(cached.xray);
      setLastCheckTime(cached.time);
    }
  }, []);

  // 경량 건강도 검사 — copilot-lite(~200ms) + QA 최신 리포트
  const runHealthCheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const [liteRes, qaRes] = await Promise.all([
        api(`/review/copilot-lite?viewMode=${viewMode}`, { timeout: 10_000 }).catch(() => null),
        api('/qa/latest', { timeout: 5_000 }).catch(() => null),
      ]);

      const newCopilot = liteRes ? buildCopilotFromLite(liteRes, viewMode) : null;
      const newXray = qaRes ? buildXrayFromQA(qaRes) : null;
      const newTime = new Date().toISOString();

      if (newCopilot) setCopilot(newCopilot);
      if (newXray) setXray(newXray);
      setShowPanel(true);
      setLastCheckTime(newTime);
      saveCache(newCopilot ?? copilot, newXray ?? xray, newTime);
    } catch {
      props.toast?.('건강도 검사 실패', 'err');
    } finally {
      setChecking(false);
    }
  }, [checking, viewMode, copilot, xray, props]);

  const copyDiag = useCallback(() => {
    if (!copilot && !xray) return;
    const lines: string[] = [];
    if (copilot) {
      lines.push(`Health Check ${copilot.timestamp}`, `Mode: ${copilot.mode}`, '');
      if (copilot.risk.length > 0) {
        lines.push('=== RISK ===');
        lines.push(...copilot.risk.map(r => `${r.label}: ${r.value}${r.unit} / ${r.max}${r.unit} [${r.level}]`));
      }
      if (copilot.actions.length > 0) {
        lines.push('', '=== ACTIONS ===');
        lines.push(...copilot.actions.map(a => `[${a.urgency}] ${a.title} — ${a.detail}`));
      }
    }
    if (xray) {
      lines.push('', '=== QA Watchdog ===');
      lines.push(`danger:${xray.summary.danger} warn:${xray.summary.warn} ok:${xray.summary.ok}`);
      lines.push(...xray.checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`));
    }
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
  }, [copilot, xray]);

  // 건강도 점수
  const healthScore = (copilot || xray) ? (() => {
    let s = 100;
    if (copilot) {
      for (const r of copilot.risk) { if (r.level === 'danger') s -= 15; else if (r.level === 'warn') s -= 5; }
      for (const a of copilot.actions) { if (a.urgency === 'high') s -= 10; else if (a.urgency === 'mid') s -= 3; }
    }
    if (xray) {
      for (const c of xray.checks) { if (c.status === 'danger') s -= 20; else if (c.status === 'warn') s -= 7; }
    }
    return Math.max(0, Math.min(100, s));
  })() : 0;

  const scoreColor = (s: number) => s >= 80 ? 'text-emerald-400' : s >= 50 ? 'text-amber-400' : 'text-red-400';
  const scoreBg = (s: number) => s >= 80 ? 'from-emerald-500/20 to-emerald-700/10 border-emerald-500/30' : s >= 50 ? 'from-amber-500/20 to-amber-700/10 border-amber-500/30' : 'from-red-500/20 to-red-700/10 border-red-500/30';

  const sseScore = props.sseHealthScore ?? 0;
  const dangerCount = (copilot ? copilot.risk.filter(r => r.level === 'danger').length : 0) + (xray?.summary.danger ?? 0);
  const highActions = copilot?.actions.filter(a => a.urgency === 'high').length ?? 0;

  return (
    <>
      <AutoPilotButton loopStatusProp={props.loopStatus ?? null} capturing={checking} toast={props.toast} />

      {/* 플로팅 헬스 버튼 */}
      <button
        data-html2canvas-ignore="true"
        onClick={runHealthCheck}
        disabled={checking}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg shadow-black/50 flex items-center justify-center transition-all duration-300 group ${
          checking
            ? 'bg-blue-600 animate-pulse cursor-wait ring-2 ring-blue-400/50'
            : copilot
              ? `bg-gradient-to-br ${scoreBg(healthScore)} backdrop-blur-sm border`
              : sseScore > 0
                ? `bg-gradient-to-br ${scoreBg(sseScore)} backdrop-blur-sm border`
                : 'bg-slate-800/90 hover:bg-slate-700 hover:scale-110 hover:shadow-xl hover:shadow-blue-500/20 border border-white/10'
        }`}
        title={`Health Check — QA + 리스크 진단${lastCheckTime ? ` (${timeAgo(lastCheckTime)})` : ''}`}
      >
        {checking ? (
          <Spinner size="xl" color="white" />
        ) : (copilot || xray) ? (
          <div className="flex flex-col items-center leading-none">
            <span className={`text-[11px] font-black ${scoreColor(healthScore)}`}>{healthScore}</span>
            <span className="text-[9px] text-slate-400 mt-0.5">SCORE</span>
            {lastCheckTime && <span className="text-[8px] text-slate-500">{timeAgo(lastCheckTime)}</span>}
          </div>
        ) : sseScore > 0 ? (
          <div className="flex flex-col items-center leading-none">
            <span className={`text-[11px] font-black ${scoreColor(sseScore)}`}>{sseScore}</span>
            <span className="text-[8px] text-slate-500 mt-0.5">LIVE</span>
          </div>
        ) : (
          <div className="relative">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300 group-hover:text-blue-300 transition-colors">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
            <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-blue-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        )}
      </button>

      {/* 알림 뱃지 */}
      {(copilot || xray) && !showPanel && (dangerCount > 0 || highActions > 0) && (
        <div data-html2canvas-ignore="true" className="fixed bottom-[82px] right-6 z-50 flex gap-1">
          {dangerCount > 0 && <span className="bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full animate-pulse">{dangerCount}</span>}
          {highActions > 0 && <span className="bg-amber-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{highActions}</span>}
        </div>
      )}

      {(copilot || xray) && !showPanel && (
        <button
          data-html2canvas-ignore="true"
          onClick={() => setShowPanel(true)}
          className="fixed bottom-[82px] right-[76px] z-50 bg-slate-900/95 border border-white/10 rounded-lg px-3 py-1.5 shadow-xl cursor-pointer hover:bg-slate-800 transition-colors"
        >
          <span className="text-[10px] text-slate-400">결과 보기</span>
        </button>
      )}

      {showPanel && (copilot || xray) && (
        <CopilotResultPanel
          copilot={copilot}
          xray={xray}
          healthScore={healthScore}
          screenshotCount={0}
          onDownload={() => {}}
          onCopy={copyDiag}
          onClose={() => setShowPanel(false)}
        />
      )}
    </>
  );
}
