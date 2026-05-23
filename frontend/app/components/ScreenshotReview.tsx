'use client';

import React, { useState, useCallback } from 'react';
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

/** 양쪽 모드에서 캡처할 핵심 탭 */
const DUAL_MODE_TABS: Tab[] = ['home', 'trades'];

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
}

/** 캡처 시 상단에 주입할 진단 배너 */
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
  if (killSwitch?.active) parts.push(`<span style="color:#ef4444;font-weight:bold;">KILL SWITCH ON</span>`);

  const pv = dash?.portfolio?.totalValue;
  if (pv != null) parts.push(pill('자산', `${Math.round(pv).toLocaleString()}원`));

  const pnl = dash?.portfolio?.todayPnl;
  const pnlPct = dash?.portfolio?.todayPnlPct;
  if (pnl != null) {
    const c = pnl >= 0 ? '#10b981' : '#ef4444';
    const s = pnl >= 0 ? '+' : '';
    parts.push(pill('PnL', `${s}${Math.round(pnl).toLocaleString()}원 (${s}${(pnlPct ?? 0).toFixed(2)}%)`, c));
  }

  const chains = dash?.chains ?? [];
  const kr = chains.filter((c: any) => c.stock_code?.length === 6).length;
  const us = chains.length - kr;
  parts.push(pill('포지션', `KR:${kr} US:${us}`, '#6366f1'));
  if (trades?.length) parts.push(pill('매매', `${trades.length}건`));

  el.innerHTML = parts.join('');
  return el;
}

/** 단일 탭 캡처 헬퍼 */
async function captureTab(tabLabel: string, props: Props, modeOverride?: 'live' | 'paper'): Promise<string | null> {
  const mainEl = document.querySelector('main');
  if (!mainEl) return null;

  const effectiveMode = modeOverride ?? props.viewMode;
  const bannerProps = modeOverride ? { ...props, viewMode: modeOverride } : props;
  const banner = buildDiagBanner(tabLabel, bannerProps);
  mainEl.insertBefore(banner, mainEl.firstChild);

  // 스크롤 위치 초기화 후 캡처 (잘림 방지)
  mainEl.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 100));

  try {
    const fullHeight = Math.max(mainEl.scrollHeight, mainEl.offsetHeight, 800);
    const bgColor = effectiveMode === 'paper' ? '#0d0a06' : '#06080f';
    const canvas = await html2canvas(mainEl as HTMLElement, {
      backgroundColor: bgColor,
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 1200,
      windowHeight: fullHeight,
      height: fullHeight,
      y: 0,
      scrollY: 0,
      onclone: (doc: Document) => {
        // 클론된 DOM에서 main을 찾아 스크롤/높이 보정
        const clonedMain = doc.querySelector('main');
        if (clonedMain) {
          (clonedMain as HTMLElement).style.overflow = 'visible';
          (clonedMain as HTMLElement).style.height = 'auto';
        }
      },
    });
    return canvas.toDataURL('image/png', 0.92).split(',')[1];
  } finally {
    banner.remove();
  }
}

export default function ScreenshotReview(props: Props) {
  const { currentTab, setTab, viewMode, switchViewMode } = props;
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState('');
  const [step, setStep] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);

  const captureAllTabs = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    setDone(false);

    const originalTab = currentTab;
    const originalMode = viewMode;
    const otherMode = viewMode === 'live' ? 'paper' : 'live';
    const screenshots: { tab: string; base64: string }[] = [];

    // 현재 모드 6탭 + 반대 모드 2탭 = 총 8
    const totalSteps = TAB_LIST.length + DUAL_MODE_TABS.length;
    setTotal(totalSteps);

    try {
      // ── Phase 1: 현재 모드 전체 6탭 캡처 ──
      for (let i = 0; i < TAB_LIST.length; i++) {
        const { id, label } = TAB_LIST[i];
        setStep(i + 1);
        setProgress(`[${originalMode.toUpperCase()}] ${label} 캡처 중...`);

        setTab(id);
        await new Promise((r) => setTimeout(r, id === 'journal' || id === 'news' ? 1500 : 800));

        const base64 = await captureTab(label, props, originalMode);
        if (base64) screenshots.push({ tab: `${label} [${originalMode.toUpperCase()}]`, base64 });
      }

      // ── Phase 2: 반대 모드 핵심 탭 캡처 ──
      setProgress(`${otherMode.toUpperCase()} 모드 전환 중...`);
      switchViewMode(otherMode);
      await new Promise((r) => setTimeout(r, 3000)); // 데이터 로드 대기

      for (let i = 0; i < DUAL_MODE_TABS.length; i++) {
        const tabId = DUAL_MODE_TABS[i];
        const tabInfo = TAB_LIST.find((t) => t.id === tabId)!;
        setStep(TAB_LIST.length + i + 1);
        setProgress(`[${otherMode.toUpperCase()}] ${tabInfo.label} 캡처 중...`);

        setTab(tabId);
        await new Promise((r) => setTimeout(r, 1200));

        const base64 = await captureTab(tabInfo.label, props, otherMode);
        if (base64) screenshots.push({ tab: `${tabInfo.label} [${otherMode.toUpperCase()}]`, base64 });
      }

      // ── 원래 모드/탭 복원 ──
      switchViewMode(originalMode);
      setTab(originalTab);
      await new Promise((r) => setTimeout(r, 500));

      setProgress('서버 업로드 중...');
      await api('/review/capture', {
        method: 'POST',
        body: JSON.stringify({ screenshots }),
      });

      setProgress('');
      setDone(true);
      setTimeout(() => setDone(false), 5000);
    } catch (err) {
      console.error('캡처 실패:', err);
      document.getElementById('__diag_banner__')?.remove();
      // 원래 상태 복원
      switchViewMode(originalMode);
      setTab(originalTab);
      setProgress('');
    } finally {
      setCapturing(false);
      setStep(0);
    }
  }, [capturing, currentTab, setTab, props, viewMode, switchViewMode]);

  return (
    <>
      {/* 플로팅 버튼 */}
      <button
        onClick={captureAllTabs}
        disabled={capturing}
        className={`fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full shadow-lg shadow-black/40 flex items-center justify-center transition-all duration-200 ${
          capturing
            ? 'bg-blue-600 animate-pulse cursor-wait'
            : done
              ? 'bg-emerald-700 border border-emerald-500/30'
              : 'bg-slate-800 hover:bg-slate-700 hover:scale-110 border border-white/10'
        }`}
        title="모든 탭 캡처 (실전+연습) → Claude 검수"
      >
        {capturing ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : done ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-300">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        )}
      </button>

      {/* 완료 토스트 */}
      {done && (
        <div className="fixed bottom-20 right-4 z-50 bg-emerald-900/90 border border-emerald-500/30 rounded-xl px-4 py-2.5 shadow-xl animate-in slide-in-from-bottom-2">
          <p className="text-xs font-semibold text-emerald-300">캡처 완료 (실전+연습) — Claude에게 "검수" 요청</p>
        </div>
      )}

      {/* 진행 상태 오버레이 */}
      {capturing && (
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center pointer-events-none">
          <div className="bg-[#0f1320] border border-white/10 rounded-2xl px-8 py-6 shadow-2xl text-center pointer-events-auto">
            <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm font-semibold text-slate-200 mb-1">{progress}</p>
            <p className="text-xs text-slate-500">{step} / {total} 탭</p>
            <div className="mt-3 w-48 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-500"
                style={{ width: `${(step / total) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
