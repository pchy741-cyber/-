'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../lib/utils';
import type { ScreenshotProps, Tab, CopilotData, XrayData } from './screenshot/screenshot-types';
import { CaptureOverlay } from './screenshot/CaptureOverlay';
import { CopilotResultPanel } from './screenshot/CopilotResultPanel';
import { AutoPilotButton } from './screenshot/AutoPilotButton';
import { waitForStable, captureTab, downloadPng, timeAgo } from './screenshot/screenshot-utils';

// sessionStorage 키 — 캡쳐 결과 영속화 (페이지 이탈 후 복귀 시 유지)
const SS_KEY = 'aab_capture_result';

function loadCaptureCache(): { copilot: CopilotData | null; xray: XrayData | null; time: string | null } {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return { copilot: null, xray: null, time: null };
    const parsed = JSON.parse(raw);
    // 30분 이상 된 캐시는 폐기
    if (parsed.time && Date.now() - new Date(parsed.time).getTime() > 30 * 60_000) {
      sessionStorage.removeItem(SS_KEY);
      return { copilot: null, xray: null, time: null };
    }
    return parsed;
  } catch { return { copilot: null, xray: null, time: null }; }
}

function saveCaptureCache(copilot: CopilotData | null, xray: XrayData | null, time: string | null) {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify({ copilot, xray, time }));
  } catch { /* quota 초과 무시 */ }
}

const CORE_TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: '대시보드' },
  { id: 'trades', label: '매매내역' },
  { id: 'journal', label: '매매일지' },
  { id: 'watchlist', label: '감시목록' },
  { id: 'strategy-lab', label: '전략실험실' },
  { id: 'news', label: '뉴스' },
  { id: 'settings', label: '설정' },
  { id: 'dividend', label: '배당' },
  { id: 'futures', label: '선물' },
];
const OPTIONAL_TABS: { id: Tab; label: string }[] = [];
const DUAL_MODE_TABS: Tab[] = ['home', 'trades', 'journal', 'watchlist'];

export default function ScreenshotReview(props: ScreenshotProps) {
  const { currentTab, setTab, viewMode, switchViewMode } = props;
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState('');
  const [step, setStep] = useState(0);
  const [total, setTotal] = useState(0);
  const [copilot, setCopilot] = useState<CopilotData | null>(null);
  const [xray, setXray] = useState<XrayData | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [lastCaptureTime, setLastCaptureTime] = useState<string | null>(null);
  const capturedScreenshots = useRef<{ tab: string; base64: string }[]>([]);

  // 마운트 시 sessionStorage에서 캡쳐 결과 복원
  useEffect(() => {
    const cached = loadCaptureCache();
    if (cached.copilot || cached.xray) {
      setCopilot(cached.copilot);
      setXray(cached.xray);
      setLastCaptureTime(cached.time);
    }
  }, []);

  const captureAllTabs = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    setCopilot(null);
    setXray(null);
    setShowPanel(false);

    const originalTab = currentTab;
    const originalMode = viewMode;
    const otherMode = viewMode === 'live' ? 'paper' : 'live';
    // PAPER_ONLY 서버: live 캡쳐 스킵 (live 잔고 14만원 수준 — 혼동 방지)
    const serverIsPaper = props.health?.tradingMode === 'paper';
    const skipDualCapture = serverIsPaper && otherMode === 'live';
    const screenshots: { tab: string; base64: string }[] = [];

    const TAB_LIST = [...CORE_TABS];

    const dualCount = skipDualCapture ? 0 : DUAL_MODE_TABS.length;
    const totalSteps = TAB_LIST.length + dualCount + 1;
    setTotal(totalSteps);

    let failedTabs: string[] = [];
    try {
      for (let i = 0; i < TAB_LIST.length; i++) {
        const { id, label } = TAB_LIST[i];
        setStep(i + 1);
        setProgress(`[${originalMode.toUpperCase()}] ${label}`);
        setTab(id);
        const mainEl = document.querySelector('main');
        if (mainEl) await waitForStable(mainEl, 300, 3000);
        try {
          const base64 = await captureTab(label, props, originalMode);
          if (base64) screenshots.push({ tab: `${label} [${originalMode.toUpperCase()}]`, base64 });
          else failedTabs.push(label);
        } catch {
          failedTabs.push(label);
          props.toast?.(`캡쳐 실패: ${label}`, 'err');
          document.getElementById('__diag_banner__')?.remove();
        }
      }

      if (!skipDualCapture) {
        setProgress(`${otherMode.toUpperCase()} 전환`);
        switchViewMode(otherMode);
        await new Promise((r) => setTimeout(r, 3000));

        for (let i = 0; i < DUAL_MODE_TABS.length; i++) {
          const tabId = DUAL_MODE_TABS[i];
          const tabInfo = TAB_LIST.find((t) => t.id === tabId)!;
          setStep(TAB_LIST.length + i + 1);
          setProgress(`[${otherMode.toUpperCase()}] ${tabInfo.label}`);
          setTab(tabId);
          const mainEl = document.querySelector('main');
          if (mainEl) await waitForStable(mainEl, 300, 3000);
          try {
            const base64 = await captureTab(tabInfo.label, props, otherMode);
            if (base64) screenshots.push({ tab: `${tabInfo.label} [${otherMode.toUpperCase()}]`, base64 });
            else failedTabs.push(`${tabInfo.label}[${otherMode}]`);
          } catch {
            failedTabs.push(`${tabInfo.label}[${otherMode}]`);
            props.toast?.(`캡쳐 실패: ${tabInfo.label} [${otherMode}]`, 'err');
            document.getElementById('__diag_banner__')?.remove();
          }
        }

        switchViewMode(originalMode);
        await new Promise((r) => setTimeout(r, 500));
      }

      setTab(originalTab);

      setStep(totalSteps);
      setProgress('AI Copilot + X-Ray 분석');
      const [, copilotRes, xrayRes] = await Promise.all([
        api('/review/capture', { method: 'POST', body: JSON.stringify({ screenshots }) }),
        api(`/review/copilot?viewMode=${viewMode}`).catch(() => null),
        api(`/review/xray?viewMode=${viewMode}`).catch(() => null),
      ]);

      capturedScreenshots.current = screenshots;
      const newCopilot = copilotRes as CopilotData | null;
      const newXray = xrayRes as XrayData | null;
      const newTime = new Date().toISOString();
      if (newCopilot) setCopilot(newCopilot);
      if (newXray) setXray(newXray);
      setShowPanel(true);
      setLastCaptureTime(newTime);
      // sessionStorage에 결과 저장 (페이지 이탈 후 복귀 시 유지)
      saveCaptureCache(newCopilot, newXray, newTime);
      if (failedTabs.length > 0) {
        props.toast?.(`${screenshots.length}/${screenshots.length + failedTabs.length} 탭 캡쳐 완료, ${failedTabs.length}개 실패`, 'info');
      }
      setProgress('');
    } catch (err) {
      console.error('캡처 실패:', err);
      document.getElementById('__diag_banner__')?.remove();
      switchViewMode(originalMode);
      setTab(originalTab);
      setProgress('');
    } finally {
      setCapturing(false);
      setStep(0);
    }
  }, [capturing, currentTab, setTab, props, viewMode, switchViewMode]);

  const downloadAll = useCallback(() => {
    const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    capturedScreenshots.current.forEach((s, i) => {
      const safeName = s.tab.replace(/[\s[\]]/g, '_');
      downloadPng(s.base64, `aab_${ts}_${i}_${safeName}.png`);
    });
  }, []);

  const copyDiag = useCallback(() => {
    if (!copilot && !xray) return;
    const lines: string[] = [];
    if (copilot) {
      lines.push(`AI Bot Copilot ${copilot.timestamp}`, `Mode: ${copilot.mode}`, '');
      lines.push('=== INTEGRITY ===');
      lines.push(...copilot.integrity.map(i => `[${i.status.toUpperCase()}] ${i.label}: ${i.detail}`));
      lines.push('', '=== RISK ===');
      lines.push(...copilot.risk.map(r => `${r.label}: ${r.value}${r.unit} / ${r.max}${r.unit} [${r.level}]`));
      lines.push('', '=== ACTIONS ===');
      lines.push(...copilot.actions.map(a => `[${a.urgency}] ${a.title} — ${a.detail}`));
    }
    if (xray) {
      lines.push('', `=== X-RAY (${xray.mode.toUpperCase()}) ===`);
      lines.push(`danger:${xray.summary.danger} warn:${xray.summary.warn} ok:${xray.summary.ok}`);
      lines.push(...xray.checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`));
    }
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
  }, [copilot, xray]);

  // 건강도 점수
  const healthScore = (copilot || xray) ? (() => {
    let s = 100;
    if (copilot) {
      for (const i of copilot.integrity) { if (i.status === 'danger') s -= 25; else if (i.status === 'warn') s -= 10; }
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

  const dangerCount = (copilot ? copilot.integrity.filter(i => i.status === 'danger').length + copilot.risk.filter(r => r.level === 'danger').length : 0)
    + (xray?.summary.danger ?? 0);
  const highActions = copilot?.actions.filter(a => a.urgency === 'high').length ?? 0;

  return (
    <>
      <AutoPilotButton loopStatusProp={props.loopStatus ?? null} capturing={capturing} toast={props.toast} />

      {/* 플로팅 버튼 */}
      <button
        onClick={captureAllTabs}
        disabled={capturing}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg shadow-black/50 flex items-center justify-center transition-all duration-300 group ${
          capturing
            ? 'bg-blue-600 animate-pulse cursor-wait ring-2 ring-blue-400/50'
            : copilot
              ? `bg-gradient-to-br ${scoreBg(healthScore)} backdrop-blur-sm border`
              : sseScore > 0
                ? `bg-gradient-to-br ${scoreBg(sseScore)} backdrop-blur-sm border`
                : 'bg-slate-800/90 hover:bg-slate-700 hover:scale-110 hover:shadow-xl hover:shadow-blue-500/20 border border-white/10'
        }`}
        title={`Copilot — 전체 캡처 + AI 진단${lastCaptureTime ? ` (${timeAgo(lastCaptureTime)})` : ''}`}
      >
        {capturing ? (
          <div className="relative">
            <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-blue-400 rounded-full animate-ping" />
          </div>
        ) : (copilot || xray) ? (
          <div className="flex flex-col items-center leading-none">
            <span className={`text-[11px] font-black ${scoreColor(healthScore)}`}>{healthScore}</span>
            <span className="text-[9px] text-slate-400 mt-0.5">SCORE</span>
            {lastCaptureTime && <span className="text-[8px] text-slate-500">{timeAgo(lastCaptureTime)}</span>}
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
        <div className="fixed bottom-[82px] right-6 z-50 flex gap-1">
          {dangerCount > 0 && <span className="bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full animate-pulse">{dangerCount}</span>}
          {highActions > 0 && <span className="bg-amber-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{highActions}</span>}
        </div>
      )}

      {(copilot || xray) && !showPanel && (
        <button
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
          screenshotCount={capturedScreenshots.current.length}
          onDownload={downloadAll}
          onCopy={copyDiag}
          onClose={() => setShowPanel(false)}
        />
      )}

      {capturing && <CaptureOverlay step={step} total={total} progress={progress} />}
    </>
  );
}
