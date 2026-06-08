'use client';

import React, { useState, type CSSProperties } from 'react';
import { ConfirmModal, Button } from '@/components/ui';
import { api } from './lib/utils';
import { useToast, useConfirm } from './lib/hooks';
import { useDashboardData } from './hooks/useDashboardData';
import type { MpData } from './types';
import { DashboardSidebar } from './components/DashboardSidebar';
import { DashboardHeader } from './components/DashboardHeader';
import { ErrorBoundary } from './components/ErrorBoundary';

import HomeView from './views/HomeView';
import TradesView from './views/TradesView';
import JournalView from './views/JournalView';
import WatchlistView from './views/WatchlistView';
import NewsView from './views/NewsView';
import SettingsView from './views/SettingsView';
import DividendView from './views/DividendView';
import FuturesView from './views/FuturesView';
import StrategyLabView from './views/StrategyLabView';
import ScreenshotReview from './components/ScreenshotReview';
import DbWarmingOverlay from './components/DbWarmingOverlay';

type Tab = 'home' | 'trades' | 'journal' | 'watchlist' | 'news' | 'settings' | 'dividend' | 'futures' | 'strategy-lab';

export default function Dashboard() {
  const { show: toast, ToastContainer } = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [tab, setTab] = useState<Tab>('home');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [modeToggling, setModeToggling] = useState(false);
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [marketTab, setMarketTab] = useState<'KR'|'US'>(() => {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), mins = h * 60 + m;
    const day = now.getDay();
    // 국내장: 평일 09:00~15:30 → KR, 그 외 → US
    return (day >= 1 && day <= 5 && mins >= 540 && mins < 930) ? 'KR' : 'US';
  });

  const data = useDashboardData();
  const {
    health, dash, watchlist, setWatchlist, strategy, setStrategy,
    trades, killSwitch, setKillSwitch, secrets, usDash,
    withdrawConfig, allocConfig, setAllocConfig,
    loading, lastUpdate, loopStatus, sseHealthScore, featureFlags, setFeatureFlags,
    viewMode, switchView, load, todayStats, isStale,
  } = data;

  const [mpData, setMpData] = useState<MpData | null>(null);
  const refreshMp = React.useCallback(() => {
    api(`/money-printer/summary?viewMode=${viewMode}`).then(setMpData).catch(() => {});
  }, [viewMode]);
  React.useEffect(() => {
    refreshMp();
    const id = setInterval(refreshMp, 60000);
    return () => clearInterval(id);
  }, [refreshMp]);

  const modeTogglingRef = React.useRef(false);

  const isKillActive = killSwitch?.kr?.active || killSwitch?.overseas?.active;
  const toggleKill = async (scope?: 'KR' | 'OVERSEAS') => {
    const active = scope
      ? killSwitch?.[scope.toLowerCase()]?.active
      : isKillActive;
    await api(`/kill-switch/${active ? 'deactivate' : 'activate'}`, {
      method: 'POST',
      body: JSON.stringify({ force: true, ...(scope ? { scope } : {}) }),
    });
    const k = await api('/kill-switch'); setKillSwitch(k);
  };

  const doSwitchMode = async (mode: 'paper' | 'live') => {
    modeTogglingRef.current = true;
    setModeToggling(true);
    try {
      await api('/trading-mode', { method: 'POST', body: JSON.stringify({ mode }) });
      toast(mode === 'live' ? '실전모드로 전환됐습니다' : '연습모드로 전환됐습니다', 'ok');
      load(false);
    } catch (e: unknown) {
      toast('모드 전환 실패: ' + ((e as Error)?.message ?? ''), 'err');
    } finally {
      modeTogglingRef.current = false;
      setModeToggling(false);
    }
  };

  const switchMode = (mode: 'paper' | 'live') => {
    if (dash?.tradingMode === mode || modeTogglingRef.current) return;
    if (mode === 'live') { setLiveConfirmOpen(true); return; }
    doSwitchMode('paper');
  };

  // DB 기상: 캐시 데이터 없으면 오버레이, 있으면 상단 배너만
  const [dbSyncing, setDbSyncing] = React.useState(false);
  const dbDown = health?.db != null && health.db !== 'ok';
  React.useEffect(() => { if (dbDown) setDbSyncing(true); }, [dbDown]);
  React.useEffect(() => { if (!dbDown && health?.db === 'ok') setDbSyncing(false); }, [dbDown, health?.db]);
  React.useEffect(() => {
    const onDbUnavailable = () => setDbSyncing(true);
    window.addEventListener('db-unavailable', onDbUnavailable);
    return () => window.removeEventListener('db-unavailable', onDbUnavailable);
  }, []);
  const showOverlay = dbSyncing && !dash; // 캐시도 없고 DB도 안됨 → 오버레이

  const isPaper = viewMode === 'paper';
  const isUS = marketTab === 'US';
  const theme = isPaper
    ? isUS ? { bg: '#0a0906', side: '#100f08', main1: '#0a0906', main2: '#0f0e08', accent: 'amber', border: 'amber-500/[0.06]', bar: 'from-amber-700/40 via-amber-500/60 to-amber-700/40' }
           : { bg: '#0d0a06', side: '#12100a', main1: '#0d0a06', main2: '#11100a', accent: 'amber', border: 'amber-500/[0.06]', bar: 'from-amber-600/60 via-amber-400/80 to-amber-600/60' }
    : isUS ? { bg: '#080610', side: '#0e0a1a', main1: '#080610', main2: '#0c0a18', accent: 'violet', border: 'violet-500/[0.06]', bar: 'from-indigo-600/50 via-violet-500/60 to-indigo-600/50' }
           : { bg: '#06080f', side: '#0a0e1a', main1: '#06080f', main2: '#0a0e1a', accent: 'blue', border: 'white/[0.04]', bar: '' };

  if (showOverlay) return <DbWarmingOverlay onReady={() => { setDbSyncing(false); load(true); }} />;

  return (
    <div className="flex flex-col h-screen text-slate-100 overflow-hidden transition-colors duration-500 bg-[var(--theme-bg)]" style={{
      '--theme-bg': theme.bg,
      '--theme-side': theme.side,
      '--theme-side-95': theme.side + 'f2',
      '--theme-side-60': theme.side + '99',
      '--theme-border': isPaper ? 'rgba(245,158,11,0.06)' : isUS ? 'rgba(139,92,246,0.06)' : 'rgba(255,255,255,0.04)',
      '--theme-gradient': `linear-gradient(to bottom right, ${theme.main1}, ${theme.main2}, ${theme.main1})`,
    } as CSSProperties}>
      {/* DB 동기화 배너 — 캐시 데이터 표시 중 + 백그라운드 갱신 */}
      {(dbSyncing || isStale) && dash && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 bg-blue-500/10 border-b border-blue-500/20 shrink-0">
          <div className="w-3 h-3 border-[1.5px] border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-[11px] text-blue-300">
            {dbSyncing ? 'DB 기상 중 — 마지막 데이터 표시 중' : '데이터 갱신 중...'}
          </span>
        </div>
      )}
      {(isPaper || isUS) && !(dbSyncing || isStale) && (
        <div className={`h-1 w-full bg-gradient-to-r ${theme.bar} shrink-0`} />
      )}
      <div className="flex flex-1 min-h-0">
      <ToastContainer />
      <ConfirmDialog />
      <ConfirmModal
        open={liveConfirmOpen}
        onClose={() => setLiveConfirmOpen(false)}
        onConfirm={() => { setLiveConfirmOpen(false); doSwitchMode('live'); }}
        title="실전모드로 전환"
        description="실제 돈으로 거래합니다. 실전모드로 전환하시겠습니까?"
        confirmLabel="실전 전환"
        confirmVariant="danger"
      />

      <DashboardSidebar
        tab={tab} setTab={setTab}
        mobileMenu={mobileMenu} setMobileMenu={setMobileMenu}
        health={health} dash={dash}
        viewMode={viewMode} switchView={switchView}
        killSwitch={killSwitch} toggleKill={toggleKill}
        lastUpdate={lastUpdate} load={load}
        featureFlags={featureFlags}
        isPaper={isPaper} isUS={isUS} theme={theme}
        loopStatus={loopStatus}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <DashboardHeader
          viewMode={viewMode} switchView={switchView}
          dash={dash} killSwitch={killSwitch} toggleKill={toggleKill}
          marketTab={marketTab} setMobileMenu={setMobileMenu}
          isPaper={isPaper} isUS={isUS} theme={theme}
        />

        <main className="flex-1 overflow-y-auto transition-colors duration-500 [background:var(--theme-gradient)]">
          {loading && !dash ? (
            <div className="flex items-center justify-center h-full flex-col gap-3">
              <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <Button variant="ghost" size="sm" className="text-[10px] text-slate-500 hover:text-slate-300 mt-4" onClick={() => load(true)}>재시도</Button>
            </div>
          ) : (
            <div className="p-4 sm:p-6 lg:p-8 max-w-[1200px] mx-auto">
              <ErrorBoundary fallbackTitle="홈 화면 로딩 오류">
                {tab === 'home' && <HomeView dash={dash} health={health} killSwitch={killSwitch} trades={trades} usDash={usDash} withdrawConfig={data.withdrawConfig} watchlist={watchlist} strategy={strategy} setStrategy={setStrategy} toast={toast} confirm={confirm} onRefresh={load} allocConfig={allocConfig} setAllocConfig={setAllocConfig} onGoToSettings={() => setTab('settings')} viewMode={viewMode} onMarketTabChange={setMarketTab} mpData={mpData} loopStatus={loopStatus} todayStats={todayStats} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="매매내역 로딩 오류">
                {tab === 'trades' && <TradesView trades={trades} watchlist={watchlist} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="저널 로딩 오류">
                {tab === 'journal' && <JournalView viewMode={viewMode} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="감시목록 로딩 오류">
                {tab === 'watchlist' && <WatchlistView watchlist={watchlist} setWatchlist={setWatchlist} dash={dash} usDash={usDash} toast={toast} confirm={confirm} onRefresh={load} viewMode={viewMode} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="뉴스 로딩 오류">
                {tab === 'news' && <NewsView watchlist={watchlist} setWatchlist={setWatchlist} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="배당 로딩 오류">
                {tab === 'dividend' && <DividendView toast={toast} viewMode={viewMode} confirm={confirm} mpData={mpData} onRefreshMp={refreshMp} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="선물 로딩 오류">
                {tab === 'futures' && <FuturesView toast={toast} viewMode={viewMode} confirm={confirm} mpData={mpData} onRefreshMp={refreshMp} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="전략 Lab 로딩 오류">
                {tab === 'strategy-lab' && <StrategyLabView toast={toast} viewMode={viewMode} confirm={confirm} />}
              </ErrorBoundary>
              <ErrorBoundary fallbackTitle="설정 로딩 오류">
                {tab === 'settings' && <SettingsView strategy={strategy} setStrategy={setStrategy} secrets={secrets} killSwitch={killSwitch} toggleKill={toggleKill} toast={toast} confirm={confirm} onFeatureFlagChange={(key: string, enabled: boolean) => setFeatureFlags(prev => ({ ...prev, [key]: enabled }))} />}
              </ErrorBoundary>
            </div>
          )}
        </main>
      </div>
      <ScreenshotReview currentTab={tab} setTab={setTab} viewMode={viewMode} dash={dash} health={health} trades={trades} killSwitch={killSwitch} strategy={strategy} switchViewMode={switchView} loopStatus={loopStatus} sseHealthScore={sseHealthScore} toast={toast} />
      </div>
    </div>
  );
}
