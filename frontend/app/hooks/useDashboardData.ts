'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/utils';
import { useSSEStream } from './useSSEStream';
import type {
  Health, Dashboard, WatchlistItem, Strategy, Trade, KillSwitch,
  Secrets, UsDashboard, WithdrawConfig, AllocConfig, LoopStatus, TodayStats,
} from '../types';

// ── Stale-While-Revalidate 캐시 ──
// DB가 꺼져있어도 마지막 데이터를 즉시 표시 → 백그라운드에서 새 데이터 갱신
const CACHE_KEY = 'aab_dash_cache';

interface DashCache {
  dash: Dashboard | null;
  trades: Trade[];
  killSwitch: KillSwitch | null;
  watchlist: WatchlistItem[];
  usDash: UsDashboard | null;
  todayStats: TodayStats | null;
  viewMode: string;
  savedAt: number;
}

function loadCache(vm: string): DashCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as DashCache;
    if (c.viewMode !== vm) return null;
    return c;
  } catch { return null; }
}

function saveCache(c: Omit<DashCache, 'savedAt'>) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...c, savedAt: Date.now() })); } catch {}
}

// 1회성 오염 정리 — paper 캐시만 제거, live 캐시는 SWR용으로 유지
const CLEAN_VER = 'aab_clean_v2';
if (typeof window !== 'undefined') {
  try {
    if (!localStorage.getItem(CLEAN_VER)) {
      localStorage.removeItem('aab_viewMode');
      sessionStorage.removeItem('aab_capture_result');
      // paper 캐시만 제거 (live 캐시는 SWR 즉시표시용으로 보존)
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c.viewMode !== 'live') localStorage.removeItem(CACHE_KEY);
      }
      localStorage.setItem(CLEAN_VER, '1');
    }
  } catch {}
}

export function useDashboardData() {
  const initVm = 'live' as const;
  const cached = typeof window !== 'undefined' ? loadCache(initVm) : null;

  const [health, setHealth] = useState<Health | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(cached?.dash ?? null);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(cached?.watchlist ?? []);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [trades, setTrades] = useState<Trade[]>(cached?.trades ?? []);
  const [killSwitch, setKillSwitch] = useState<KillSwitch | null>(cached?.killSwitch ?? null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [usDash, setUsDash] = useState<UsDashboard | null>(cached?.usDash ?? null);
  const [withdrawConfig, setWithdrawConfig] = useState<WithdrawConfig | null>(null);
  const [withdrawHistory, setWithdrawHistory] = useState<WithdrawConfig[]>([]);
  const [allocConfig, setAllocConfig] = useState<AllocConfig | null>(null);
  const [loading, setLoading] = useState(!cached?.dash);
  const [lastUpdate, setLastUpdate] = useState(cached ? new Date(cached.savedAt) : new Date());
  const [loopStatus, setLoopStatus] = useState<LoopStatus | null>(null);
  const [sseHealthScore, setSseHealthScore] = useState<number>(0);
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});
  const [todayStats, setTodayStats] = useState<TodayStats | null>(cached?.todayStats ?? null);
  const [isStale, setIsStale] = useState(!!cached?.dash); // 캐시 데이터면 stale
  const [newInsightCount, setNewInsightCount] = useState(0);

  const [viewMode, setViewMode] = useState<'live'|'paper'>(initVm);

  const loadingRef = useRef(false);
  const loadGenRef = useRef(0);
  const staticLoadedRef = useRef(false);
  const tradesLoadedRef = useRef(false);
  const tradesLastFetchRef = useRef(0);
  const viewModeRef = useRef<'live'|'paper'>(viewMode);

  const loadStatic = async (gen: number, vmOverride?: string) => {
    const vm = vmOverride ?? viewModeRef.current;
    const [w, s, t, sec, wc, wh, ts] = await Promise.allSettled([
      api(`/watchlist?viewMode=${vm}`), api(`/strategy?viewMode=${vm}`),
      api(`/trades?limit=100&viewMode=${vm}`), api(`/secrets?viewMode=${vm}`),
      api('/withdraw/config').catch(() => null),
      api('/withdraw/history').catch(() => []),
      api(`/trades/today-stats?viewMode=${vm}`),
    ]);
    if (loadGenRef.current !== gen) return;
    if (w.status === 'fulfilled') setWatchlist(Array.isArray(w.value) ? w.value : []);
    if (s.status === 'fulfilled') setStrategy(s.value);
    if (t.status === 'fulfilled' && Array.isArray(t.value) && t.value.length > 0) {
      setTrades(t.value);
      tradesLoadedRef.current = true;
      tradesLastFetchRef.current = Date.now();
    }
    if (sec.status === 'fulfilled') setSecrets(sec.value);
    if (wc.status === 'fulfilled' && wc.value) setWithdrawConfig(wc.value);
    if (wh.status === 'fulfilled') setWithdrawHistory(Array.isArray(wh.value) ? wh.value : []);
    if (ts.status === 'fulfilled' && ts.value?.totalTrades != null) setTodayStats(ts.value);
    staticLoadedRef.current = true;
  };

  const refreshTrades = (gen: number, vmOverride?: string) => {
    const vm = vmOverride ?? viewModeRef.current;
    api(`/trades?limit=100&viewMode=${vm}`).then((t: Trade[]) => {
      if (loadGenRef.current !== gen) return;
      if (Array.isArray(t) && t.length > 0) {
        setTrades(t);
        tradesLoadedRef.current = true;
        tradesLastFetchRef.current = Date.now();
      }
    }).catch(() => {});
  };

  const load = useCallback(async (forceStatic = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const gen = ++loadGenRef.current;
    const vm = viewModeRef.current;
    const ifCurrent = <T,>(setter: (v: T) => void) => (v: T) => {
      if (loadGenRef.current === gen) setter(v);
    };
    try {
      setLoading(true);
      // 핵심 데이터 + trades 동시 로딩 (초기 표시 속도 개선)
      const fetchTrades = !tradesLoadedRef.current || forceStatic;
      const [h, d, k, t] = await Promise.allSettled([
        api('/health'), api(`/dashboard?viewMode=${vm}`), api('/kill-switch'),
        fetchTrades ? api(`/trades?limit=100&viewMode=${vm}`) : Promise.resolve(null),
      ]);
      if (gen !== loadGenRef.current) return;
      if (h.status === 'fulfilled') setHealth(h.value);
      if (d.status === 'fulfilled' && d.value) { setDash(d.value); setIsStale(false); }
      if (k.status === 'fulfilled') setKillSwitch(k.value);
      if (t.status === 'fulfilled' && Array.isArray(t.value) && t.value.length > 0) {
        setTrades(t.value);
        tradesLoadedRef.current = true;
        tradesLastFetchRef.current = Date.now();
      }
      setLastUpdate(new Date());
      setLoading(false);

      if (!staticLoadedRef.current || forceStatic) {
        loadStatic(gen, vm).catch(() => {});
      } else {
        const tradesStaleSec = (Date.now() - tradesLastFetchRef.current) / 1000;
        if (!tradesLoadedRef.current || tradesStaleSec > 20) {
          refreshTrades(gen, vm);
        }
      }

      api(`/overseas/dashboard?viewMode=${vm}`).then(ifCurrent((us: UsDashboard) => {
        if (!us) return;
        setUsDash(us);
      })).catch(() => {});
      if (!staticLoadedRef.current) {
        api(`/portfolio/allocation?viewMode=${vm}`).then(ifCurrent((ac: AllocConfig) => { if (ac) setAllocConfig(ac); })).catch(() => {});
      }
    } catch (err) { setLoading(false); console.error('[AAB] 데이터 로드 실패:', err); }
    finally { loadingRef.current = false; }
  }, []);

  // feature flags 로드
  useEffect(() => {
    api('/feature-flags').then((r: { flags?: Array<{ key: string; enabled: boolean }> }) => {
      const map: Record<string, boolean> = {};
      (r.flags || []).forEach((f) => { map[f.key] = f.enabled; });
      setFeatureFlags(map);
    }).catch(() => {});
  }, []);

  // 초기 로드 + 폴링
  useEffect(() => {
    load(true);
    // SSE가 실시간 데이터를 3초/30초 주기로 보내므로
    // 폴링: 절전모드 없음 — 항상 일정 주기 (탭 복귀 시 즉시 갱신)
    const getInterval = () => {
      const h = new Date().getHours(), m = new Date().getMinutes();
      const mins = h * 60 + m;
      const isMarket = mins >= 9 * 60 && mins < 15 * 60 + 30;
      return isMarket ? 120000 : 300000; // 장중: 2분, 장외: 5분
    };
    let iv: ReturnType<typeof setInterval>;
    const schedule = () => { iv = setInterval(() => { load(); clearInterval(iv); schedule(); }, getInterval()); };
    schedule();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load(); // 탭 복귀 즉시 갱신
        clearInterval(iv);
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVisibility); };
  }, [load]);

  // 캐시 저장 — dash가 갱신될 때마다 localStorage에 저장
  useEffect(() => {
    if (!dash || isStale) return;
    saveCache({ dash, trades, killSwitch, watchlist, usDash, todayStats, viewMode });
  }, [dash, trades, killSwitch, watchlist, usDash, todayStats, viewMode, isStale]);

  // SSE 실시간 스트림
  useSSEStream(viewMode, { setTrades, setStrategy, setDash, setUsDash, setLoopStatus, setSseHealthScore, setHealth, setTodayStats, setNewInsightCount });

  const switchView = useCallback((mode: 'live' | 'paper') => {
    if (viewModeRef.current === mode) return;
    viewModeRef.current = mode;
    setViewMode(mode);
    // 모드 전환 시 모든 모드 종속 상태 즉시 초기화 (크로스오염 방지)
    setDash(null);
    setTrades([]);
    setUsDash(null);
    setTodayStats(null);
    setNewInsightCount(0);
    loadingRef.current = false;
    tradesLoadedRef.current = false;
    staticLoadedRef.current = false;
    load(true);
  }, [load]);

  return {
    health, dash, watchlist, setWatchlist, strategy, setStrategy,
    trades, killSwitch, setKillSwitch, secrets, usDash,
    withdrawConfig, setWithdrawConfig, withdrawHistory, setWithdrawHistory,
    allocConfig, setAllocConfig, loading, lastUpdate, loopStatus, sseHealthScore,
    featureFlags, setFeatureFlags, viewMode, switchView, load, todayStats, isStale,
    newInsightCount,
  };
}
