'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import html2canvas from 'html2canvas';
import { api } from '../lib/utils';

type Tab = 'home' | 'trades' | 'journal' | 'watchlist' | 'news' | 'settings';

const TAB_LIST: { id: Tab; label: string }[] = [
  { id: 'home', label: '대시보드' },
  { id: 'trades', label: '매매내역' },
  { id: 'journal', label: '매매일지' },
  { id: 'watchlist', label: '감시목록' },
  { id: 'news', label: '뉴스' },
  { id: 'settings', label: '설정' },
];

const DUAL_MODE_TABS: Tab[] = ['home', 'trades'];

interface LoopStatus {
  active: boolean;
  totalRuns: number;
  lastRunAt: string | null;
  lastRunResult: 'ok' | 'error' | 'skipped' | null;
}

interface Props {
  currentTab: Tab;
  setTab: (tab: Tab) => void;
  viewMode: 'live' | 'paper';
  switchViewMode: (mode: 'live' | 'paper') => void;
  dash?: any;
  health?: any;
  trades?: any[];
  killSwitch?: any;
  strategy?: any;
  loopStatus?: LoopStatus | null;
}

interface CopilotData {
  timestamp: string;
  mode: string;
  integrity: { id: string; status: 'ok' | 'warn' | 'danger'; label: string; detail: string }[];
  risk: { id: string; label: string; value: number; max: number; unit: string; level: 'ok' | 'warn' | 'danger' }[];
  actions: { type: string; icon: string; title: string; detail: string; urgency: 'high' | 'mid' | 'low' }[];
}

/** 캡처 시 상단 배너 */
function buildDiagBanner(tabLabel: string, props: Props): HTMLDivElement {
  const { viewMode, dash, health, trades, killSwitch, strategy } = props;
  const el = document.createElement('div');
  el.id = '__diag_banner__';
  el.style.cssText = 'background:#111827;border-bottom:2px solid #1e3a5f;padding:10px 16px;font-family:monospace;font-size:12px;color:#94a3b8;display:flex;flex-wrap:wrap;gap:12px;align-items:center;';
  const pill = (label: string, value: string, color = '#64748b') =>
    `<span style="background:${color}22;border:1px solid ${color}44;border-radius:6px;padding:2px 8px;color:${color};font-weight:600;font-size:11px;">${label}: ${value}</span>`;
  const vmColor = viewMode === 'paper' ? '#f59e0b' : '#10b981';
  const tradingMode = dash?.tradingMode ?? health?.tradingMode ?? '?';
  const tmColor = tradingMode === 'paper' ? '#f59e0b' : '#10b981';
  const parts: string[] = [
    pill('TAB', tabLabel, '#3b82f6'),
    pill('VIEW', viewMode.toUpperCase(), vmColor),
    pill('TRADE', tradingMode.toUpperCase(), tmColor),
  ];
  if (viewMode !== tradingMode && tradingMode !== '?') {
    parts.push(`<span style="color:#ef4444;font-weight:bold;font-size:11px;">!! VIEW/TRADE 불일치</span>`);
  }
  const now = new Date();
  parts.push(pill('TIME', now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
  const mode = strategy?.mode ?? dash?.strategy?.mode;
  if (mode) parts.push(pill('MODE', mode, '#8b5cf6'));
  if (killSwitch?.kr?.active || killSwitch?.overseas?.active) {
    const scopes = [killSwitch?.kr?.active && 'KR', killSwitch?.overseas?.active && 'US'].filter(Boolean).join('+');
    parts.push(`<span style="color:#ef4444;font-weight:bold;">KILL ${scopes}</span>`);
  }
  const pv = dash?.portfolio?.totalValue;
  if (pv != null) parts.push(pill('자산', `${Math.round(pv).toLocaleString()}원`));
  el.innerHTML = parts.join('');
  return el;
}

async function captureTab(tabLabel: string, props: Props, modeOverride?: 'live' | 'paper'): Promise<string | null> {
  const mainEl = document.querySelector('main');
  if (!mainEl) return null;
  const effectiveMode = modeOverride ?? props.viewMode;
  const bannerProps = modeOverride ? { ...props, viewMode: modeOverride } : props;
  const banner = buildDiagBanner(tabLabel, bannerProps);
  mainEl.insertBefore(banner, mainEl.firstChild);
  mainEl.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 100));
  try {
    const fullHeight = Math.max(mainEl.scrollHeight, mainEl.offsetHeight, 800);
    const bgColor = effectiveMode === 'paper' ? '#0d0a06' : '#06080f';
    const cappedHeight = Math.min(fullHeight, 4000); // 최대 4000px — 메모리 폭주 방지
    const canvas = await html2canvas(mainEl as HTMLElement, {
      backgroundColor: bgColor, scale: 1.5, useCORS: true, logging: false,
      windowWidth: 1200, windowHeight: cappedHeight, height: cappedHeight, y: 0, scrollY: 0,
      onclone: (doc: Document) => {
        const clonedMain = doc.querySelector('main');
        if (clonedMain) { (clonedMain as HTMLElement).style.overflow = 'visible'; (clonedMain as HTMLElement).style.height = 'auto'; }
      },
    });
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  } finally { banner.remove(); }
}

function downloadPng(base64: string, filename: string) {
  const a = document.createElement('a');
  a.href = `data:image/jpeg;base64,${base64}`;
  a.download = filename.replace(/\.png$/, '.jpg');
  a.click();
}

// ── 리스크 게이지 바 ──
function RiskGauge({ item }: { item: CopilotData['risk'][0] }) {
  const pct = Math.min(100, (item.value / item.max) * 100);
  const barColor = item.level === 'danger' ? 'bg-red-500' : item.level === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  const textColor = item.level === 'danger' ? 'text-red-400' : item.level === 'warn' ? 'text-amber-400' : 'text-emerald-400';
  return (
    <div className="flex items-center gap-3">
      <div className="w-20 text-[10px] text-slate-400 shrink-0">{item.label}</div>
      <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
      <div className={`w-14 text-right text-xs font-bold tabular-nums ${textColor}`}>
        {item.value}{item.unit}
      </div>
    </div>
  );
}

export default function ScreenshotReview(props: Props) {
  const { currentTab, setTab, viewMode, switchViewMode } = props;
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState('');
  const [step, setStep] = useState(0);
  const [total, setTotal] = useState(0);
  const [copilot, setCopilot] = useState<CopilotData | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [activeSection, setActiveSection] = useState<'integrity' | 'risk' | 'actions'>('risk');
  const capturedScreenshots = useRef<{ tab: string; base64: string }[]>([]);
  const [togglingLoop, setTogglingLoop] = useState(false);

  // Auto Pilot 상태: SSE prop 우선, 없으면 폴링
  const [localLoopStatus, setLocalLoopStatus] = useState<LoopStatus | null>(null);
  const loopStatus = props.loopStatus ?? localLoopStatus;

  useEffect(() => {
    if (props.loopStatus) return; // SSE로 받고 있으면 폴링 불필요
    const fetchStatus = () => api('/loop/status').then((d) => setLocalLoopStatus(d as LoopStatus)).catch(() => {});
    fetchStatus();
    const iv = setInterval(fetchStatus, 30_000);
    return () => clearInterval(iv);
  }, [props.loopStatus]);

  const toggleLoop = useCallback(async () => {
    if (togglingLoop) return;
    setTogglingLoop(true);
    try {
      if (loopStatus?.active) {
        await api('/loop/stop', { method: 'POST' });
      } else {
        await api('/loop/start', { method: 'POST' });
      }
      const status = await api('/loop/status');
      setLocalLoopStatus(status as LoopStatus);
    } catch (err) {
      console.error('Loop toggle failed:', err);
    } finally {
      setTogglingLoop(false);
    }
  }, [togglingLoop, loopStatus]);

  const captureAllTabs = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    setCopilot(null);
    setShowPanel(false);

    const originalTab = currentTab;
    const originalMode = viewMode;
    const otherMode = viewMode === 'live' ? 'paper' : 'live';
    const screenshots: { tab: string; base64: string }[] = [];
    const totalSteps = TAB_LIST.length + DUAL_MODE_TABS.length + 2; // +1 trade, +1 copilot
    setTotal(totalSteps);

    try {
      // Phase 1: 현재 모드 전체 탭 캡처
      for (let i = 0; i < TAB_LIST.length; i++) {
        const { id, label } = TAB_LIST[i];
        setStep(i + 1);
        setProgress(`[${originalMode.toUpperCase()}] ${label}`);
        setTab(id);
        await new Promise((r) => setTimeout(r, id === 'journal' || id === 'news' ? 1500 : 800));
        const base64 = await captureTab(label, props, originalMode);
        if (base64) screenshots.push({ tab: `${label} [${originalMode.toUpperCase()}]`, base64 });
      }

      // Phase 2: 반대 모드 핵심 탭
      setProgress(`${otherMode.toUpperCase()} 전환`);
      switchViewMode(otherMode);
      await new Promise((r) => setTimeout(r, 3000));

      for (let i = 0; i < DUAL_MODE_TABS.length; i++) {
        const tabId = DUAL_MODE_TABS[i];
        const tabInfo = TAB_LIST.find((t) => t.id === tabId)!;
        setStep(TAB_LIST.length + i + 1);
        setProgress(`[${otherMode.toUpperCase()}] ${tabInfo.label}`);
        setTab(tabId);
        await new Promise((r) => setTimeout(r, 1200));
        const base64 = await captureTab(tabInfo.label, props, otherMode);
        if (base64) screenshots.push({ tab: `${tabInfo.label} [${otherMode.toUpperCase()}]`, base64 });
      }

      // 복원
      switchViewMode(originalMode);
      setTab(originalTab);
      await new Promise((r) => setTimeout(r, 500));

      // Phase 2.5: 해외주식 AI 매매 실행
      setStep(totalSteps - 1);
      setProgress('🚀 해외주식 AI 매매 실행');
      await api('/run-overseas', { method: 'POST' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));

      // Phase 3: 서버 업로드 + Copilot 진단
      setStep(totalSteps);
      setProgress('AI Copilot 분석');
      const [, copilotRes] = await Promise.all([
        api('/review/capture', { method: 'POST', body: JSON.stringify({ screenshots }) }),
        api('/review/copilot').catch(() => null),
      ]);

      capturedScreenshots.current = screenshots;
      if (copilotRes) setCopilot(copilotRes as CopilotData);
      setShowPanel(true);
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
      downloadPng(s.base64, `quantops_${ts}_${i}_${safeName}.png`);
    });
  }, []);

  const copyDiag = useCallback(() => {
    if (!copilot) return;
    const lines = [
      `QuantOps Copilot Report ${copilot.timestamp}`,
      `Mode: ${copilot.mode}`,
      '',
      '=== INTEGRITY ===',
      ...copilot.integrity.map(i => `[${i.status.toUpperCase()}] ${i.label}: ${i.detail}`),
      '',
      '=== RISK ===',
      ...copilot.risk.map(r => `${r.label}: ${r.value}${r.unit} / ${r.max}${r.unit} [${r.level}]`),
      '',
      '=== ACTIONS ===',
      ...copilot.actions.map(a => `[${a.urgency}] ${a.title} — ${a.detail}`),
    ];
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
  }, [copilot]);

  // 전체 건강도 점수 계산
  const healthScore = copilot ? (() => {
    let s = 100;
    for (const i of copilot.integrity) { if (i.status === 'danger') s -= 25; else if (i.status === 'warn') s -= 10; }
    for (const r of copilot.risk) { if (r.level === 'danger') s -= 15; else if (r.level === 'warn') s -= 5; }
    for (const a of copilot.actions) { if (a.urgency === 'high') s -= 10; else if (a.urgency === 'mid') s -= 3; }
    return Math.max(0, Math.min(100, s));
  })() : 0;

  const scoreColor = (s: number) => s >= 80 ? 'text-emerald-400' : s >= 50 ? 'text-amber-400' : 'text-red-400';
  const scoreBg = (s: number) => s >= 80 ? 'from-emerald-500/20 to-emerald-700/10 border-emerald-500/30' : s >= 50 ? 'from-amber-500/20 to-amber-700/10 border-amber-500/30' : 'from-red-500/20 to-red-700/10 border-red-500/30';

  const dangerCount = copilot ? copilot.integrity.filter(i => i.status === 'danger').length + copilot.risk.filter(r => r.level === 'danger').length : 0;
  const warnCount = copilot ? copilot.integrity.filter(i => i.status === 'warn').length + copilot.risk.filter(r => r.level === 'warn').length : 0;
  const highActions = copilot?.actions.filter(a => a.urgency === 'high').length ?? 0;

  return (
    <>
      {/* Auto Pilot 토글 */}
      <button
        onClick={toggleLoop}
        disabled={togglingLoop || capturing}
        className={`fixed bottom-6 right-[88px] z-50 h-14 px-3 rounded-full shadow-lg shadow-black/50 flex items-center justify-center transition-all duration-300 ${
          loopStatus?.active
            ? 'bg-emerald-600/90 text-white animate-pulse ring-2 ring-emerald-400/40'
            : 'bg-slate-800/90 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-white/10'
        }`}
        title={loopStatus?.active ? `Auto Pilot ON (${loopStatus.totalRuns}회 실행)` : 'Auto Pilot OFF — 클릭하여 5분 루프 시작'}
      >
        <div className="flex flex-col items-center leading-none">
          <span className="text-[9px] font-black tracking-wider">AP</span>
          {loopStatus?.active ? (
            <span className="text-[11px] font-bold mt-0.5">{loopStatus.totalRuns}</span>
          ) : (
            <span className="text-[8px] mt-0.5 opacity-60">OFF</span>
          )}
        </div>
      </button>

      {/* 플로팅 버튼 */}
      <button
        onClick={captureAllTabs}
        disabled={capturing}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg shadow-black/50 flex items-center justify-center transition-all duration-300 group ${
          capturing
            ? 'bg-blue-600 animate-pulse cursor-wait ring-2 ring-blue-400/50'
            : copilot
              ? `bg-gradient-to-br ${scoreBg(healthScore)} backdrop-blur-sm border`
              : 'bg-slate-800/90 hover:bg-slate-700 hover:scale-110 hover:shadow-xl hover:shadow-blue-500/20 border border-white/10'
        }`}
        title="Copilot — 전체 캡처 + AI 진단"
      >
        {capturing ? (
          <div className="relative">
            <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-blue-400 rounded-full animate-ping" />
          </div>
        ) : copilot ? (
          <div className="flex flex-col items-center leading-none">
            <span className={`text-[11px] font-black ${scoreColor(healthScore)}`}>{healthScore}</span>
            <span className="text-[7px] text-slate-400 mt-0.5">SCORE</span>
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
      {copilot && !showPanel && (dangerCount > 0 || highActions > 0) && (
        <div className="fixed bottom-[82px] right-6 z-50 flex gap-1">
          {dangerCount > 0 && <span className="bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full animate-pulse">{dangerCount}</span>}
          {highActions > 0 && <span className="bg-amber-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">{highActions}</span>}
        </div>
      )}

      {copilot && !showPanel && (
        <button
          onClick={() => setShowPanel(true)}
          className="fixed bottom-[82px] right-[76px] z-50 bg-slate-900/95 border border-white/10 rounded-lg px-3 py-1.5 shadow-xl cursor-pointer hover:bg-slate-800 transition-colors"
        >
          <span className="text-[10px] text-slate-400">결과 보기</span>
        </button>
      )}

      {/* ── Copilot 결과 패널 ── */}
      {showPanel && copilot && (
        <div className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={() => setShowPanel(false)}>
          <div
            className="w-full sm:w-[440px] max-h-[90vh] bg-[#0a0e1a] border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 헤더 */}
            <div className={`bg-gradient-to-b ${scoreBg(healthScore)} px-5 pt-5 pb-4 shrink-0`}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white tracking-tight">Copilot</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">{copilot.mode.toUpperCase()} | {capturedScreenshots.current.length}장 캡처</p>
                </div>
                <div className="text-center">
                  <div className={`text-3xl font-black tracking-tighter ${scoreColor(healthScore)}`}>{healthScore}</div>
                  <div className="text-[8px] text-slate-500 font-semibold tracking-wider">HEALTH</div>
                </div>
              </div>
              {/* 요약 알림 칩 */}
              <div className="flex gap-1.5 mt-3 flex-wrap">
                {dangerCount > 0 && <span className="text-[9px] bg-red-500/20 text-red-300 border border-red-500/30 rounded-full px-2 py-0.5 font-semibold">위험 {dangerCount}</span>}
                {warnCount > 0 && <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5 font-semibold">주의 {warnCount}</span>}
                {highActions > 0 && <span className="text-[9px] bg-orange-500/20 text-orange-300 border border-orange-500/30 rounded-full px-2 py-0.5 font-semibold">긴급 {highActions}</span>}
                {dangerCount === 0 && warnCount === 0 && highActions === 0 && (
                  <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full px-2 py-0.5 font-semibold">정상</span>
                )}
              </div>
            </div>

            {/* 탭 네비게이션 */}
            <div className="flex border-b border-white/5 shrink-0">
              {([
                { key: 'integrity' as const, label: '정합성', icon: 'S', count: copilot.integrity.filter(i => i.status !== 'ok').length },
                { key: 'risk' as const, label: '리스크', icon: 'R', count: copilot.risk.filter(r => r.level !== 'ok').length },
                { key: 'actions' as const, label: '액션', icon: 'A', count: copilot.actions.length },
              ]).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveSection(tab.key)}
                  className={`flex-1 py-2.5 text-[11px] font-semibold transition-colors relative ${
                    activeSection === tab.key ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className={`ml-1 text-[8px] px-1 py-px rounded-full font-bold ${
                      activeSection === tab.key ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    }`}>{tab.count}</span>
                  )}
                  {activeSection === tab.key && <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-blue-500 rounded-full" />}
                </button>
              ))}
            </div>

            {/* 콘텐츠 영역 */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {/* ── 정합성 섹션 ── */}
              {activeSection === 'integrity' && copilot.integrity.map((item, i) => (
                <div key={i} className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-xs ${
                  item.status === 'danger' ? 'bg-red-950/40 border border-red-500/20' :
                  item.status === 'warn' ? 'bg-amber-950/40 border border-amber-500/20' :
                  'bg-emerald-950/20 border border-emerald-500/10'
                }`}>
                  <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black ${
                    item.status === 'danger' ? 'bg-red-600/30 text-red-300' :
                    item.status === 'warn' ? 'bg-amber-600/30 text-amber-300' :
                    'bg-emerald-600/30 text-emerald-300'
                  }`}>{item.status === 'danger' ? '!' : item.status === 'warn' ? '?' : '\u2713'}</span>
                  <div className="flex-1 min-w-0">
                    <div className={`font-semibold ${
                      item.status === 'danger' ? 'text-red-300' :
                      item.status === 'warn' ? 'text-amber-300' :
                      'text-emerald-400'
                    }`}>{item.label}</div>
                    <div className="text-slate-500 text-[10px] mt-0.5 break-all">{item.detail}</div>
                  </div>
                </div>
              ))}

              {/* ── 리스크 섹션 ── */}
              {activeSection === 'risk' && (
                <div className="space-y-3">
                  {copilot.risk.length === 0 ? (
                    <div className="text-center text-slate-500 text-xs py-6">데이터 수집 중...</div>
                  ) : copilot.risk.map((item, i) => (
                    <RiskGauge key={i} item={item} />
                  ))}
                </div>
              )}

              {/* ── 액션 섹션 ── */}
              {activeSection === 'actions' && (
                <div className="space-y-2">
                  {copilot.actions.length === 0 ? (
                    <div className="text-center text-emerald-400/60 text-xs py-6">이상 없음 — 현재 포트폴리오 정상</div>
                  ) : copilot.actions.map((action, i) => {
                    const colors = {
                      cut_loss: { bg: 'bg-red-950/40', border: 'border-red-500/20', text: 'text-red-300', icon: 'bg-red-600/30 text-red-300' },
                      take_profit: { bg: 'bg-emerald-950/30', border: 'border-emerald-500/20', text: 'text-emerald-300', icon: 'bg-emerald-600/30 text-emerald-300' },
                      rebalance: { bg: 'bg-blue-950/30', border: 'border-blue-500/20', text: 'text-blue-300', icon: 'bg-blue-600/30 text-blue-300' },
                      anomaly: { bg: 'bg-amber-950/30', border: 'border-amber-500/20', text: 'text-amber-300', icon: 'bg-amber-600/30 text-amber-300' },
                      opportunity: { bg: 'bg-violet-950/30', border: 'border-violet-500/20', text: 'text-violet-300', icon: 'bg-violet-600/30 text-violet-300' },
                    }[action.type] ?? { bg: 'bg-slate-800', border: 'border-white/5', text: 'text-slate-300', icon: 'bg-slate-700 text-slate-300' };

                    return (
                      <div key={i} className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-xs ${colors.bg} border ${colors.border}`}>
                        <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black ${colors.icon}`}>
                          {action.icon}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`font-semibold ${colors.text}`}>{action.title}</span>
                            {action.urgency === 'high' && <span className="text-[8px] bg-red-500/30 text-red-300 px-1.5 py-px rounded-full font-bold animate-pulse">URGENT</span>}
                          </div>
                          <div className="text-slate-500 text-[10px] mt-0.5">{action.detail}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 하단 액션 바 */}
            <div className="flex gap-2 px-4 py-3 border-t border-white/5 shrink-0 bg-[#0a0e1a]">
              <button onClick={downloadAll} className="flex-1 flex items-center justify-center gap-1 px-2 py-2 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-xl text-[11px] font-semibold text-slate-300 transition-colors">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                {capturedScreenshots.current.length}장
              </button>
              <button onClick={copyDiag} className="flex-1 flex items-center justify-center gap-1 px-2 py-2 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-xl text-[11px] font-semibold text-slate-300 transition-colors">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                복사
              </button>
              <button onClick={() => setShowPanel(false)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-xl text-[11px] font-semibold text-slate-400 transition-colors">
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 진행 상태 오버레이 */}
      {capturing && (
        <div className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-[#0c1021] border border-white/10 rounded-2xl px-10 py-8 shadow-2xl text-center pointer-events-auto min-w-[280px]">
            <div className="relative w-20 h-20 mx-auto mb-5">
              <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="35" fill="none" stroke="#1e293b" strokeWidth="4" />
                <circle cx="40" cy="40" r="35" fill="none" stroke="url(#prog-grad)" strokeWidth="4"
                  strokeLinecap="round" strokeDasharray={`${(step / total) * 220} 220`} className="transition-all duration-500" />
                <defs><linearGradient id="prog-grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#3b82f6" /><stop offset="100%" stopColor="#06b6d4" /></linearGradient></defs>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xl font-black text-white">{step}/{total}</span>
              </div>
            </div>
            <p className="text-sm font-bold text-white mb-1">{progress}</p>
            <p className="text-xs text-slate-500">Copilot 분석 중...</p>
          </div>
        </div>
      )}
    </>
  );
}
