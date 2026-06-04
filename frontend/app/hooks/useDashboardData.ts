'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/utils';
import { useSSEStream } from './useSSEStream';
import type {
  Health, Dashboard, WatchlistItem, Strategy, Trade, KillSwitch,
  Secrets, UsDashboard, WithdrawConfig, AllocConfig, LoopStatus,
} from '../types';

export function useDashboardData() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [killSwitch, setKillSwitch] = useState<KillSwitch | null>(null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [usDash, setUsDash] = useState<UsDashboard | null>(null);
  const [withdrawConfig, setWithdrawConfig] = useState<WithdrawConfig | null>(null);
  const [withdrawHistory, setWithdrawHistory] = useState<WithdrawConfig[]>([]);
  const [allocConfig, setAllocConfig] = useState<AllocConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [loopStatus, setLoopStatus] = useState<LoopStatus | null>(null);
  const [sseHealthScore, setSseHealthScore] = useState<number>(0);
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});

  // localStorage에서 동기적으로 viewMode 복원 — useEffect 비동기 복원 시
  // live→paper 전환 사이에 SSE가 live 모드로 연결되어 1초간 실전 데이터 표시되는 버그 방지
  const [viewMode, setViewMode] = useState<'live'|'paper'>(() => {
    try {
      const saved = localStorage.getItem('aab_viewMode');
      if (saved === 'paper' || saved === 'live') return saved;
    } catch {}
    return 'live';
  });

  const loadingRef = useRef(false);
  const loadGenRef = useRef(0);
  const staticLoadedRef = useRef(false);
  const tradesLoadedRef = useRef(false);
  const tradesLastFetchRef = useRef(0);
  const viewModeRef = useRef<'live'|'paper'>(viewMode);

  const loadStatic = async (gen: number, vmOverride?: string) => {
    const vm = vmOverride ?? viewModeRef.current;
    const [w, s, t, sec, wc, wh] = await Promise.allSettled([
      api(`/watchlist?viewMode=${vm}`), api('/strategy'),
      api(`/trades?limit=100&viewMode=${vm}`), api('/secrets'),
      api('/withdraw/config').catch(() => null),
      api('/withdraw/history').catch(() => []),
    ]);
    if (loadGenRef.current !== gen) return;
    if (w.status === 'fulfilled') setWatchlist(Array.isArray(w.value) ? w.value : []);
    if (s.status === 'fulfilled') setStrategy(s.value);
    if (t.status === 'fulfilled' && Array.isArray(t.value)) {
      setTrades(t.value);
      tradesLoadedRef.current = true;
      tradesLastFetchRef.current = Date.now();
    }
    if (sec.status === 'fulfilled') setSecrets(sec.value);
    if (wc.status === 'fulfilled' && wc.value) setWithdrawConfig(wc.value);
    if (wh.status === 'fulfilled') setWithdrawHistory(Array.isArray(wh.value) ? wh.value : []);
    staticLoadedRef.current = true;
  };

  const refreshTrades = (gen: number, vmOverride?: string) => {
    const vm = vmOverride ?? viewModeRef.current;
    api(`/trades?limit=100&viewMode=${vm}`).then((t: Trade[]) => {
      if (loadGenRef.current !== gen) return;
      if (Array.isArray(t)) {
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
      const [h, d, k] = await Promise.allSettled([
        api('/health'), api(`/dashboard?viewMode=${vm}`), api('/kill-switch'),
      ]);
      if (gen !== loadGenRef.current) return;
      if (h.status === 'fulfilled') setHealth(h.value);
      if (d.status === 'fulfilled' && d.value) setDash(d.value);
      if (k.status === 'fulfilled') setKillSwitch(k.value);
      setLastUpdate(new Date());
      setLoading(false);

      if (!staticLoadedRef.current || forceStatic) {
        loadStatic(gen, vm).catch(() => {});
      } else {
        const tradesStaleSec = (Date.now() - tradesLastFetchRef.current) / 1000;
        if (!tradesLoadedRef.current || tradesStaleSec > 60) {
          refreshTrades(gen, vm);
        }
      }

      api(`/overseas/dashboard?viewMode=${vm}`).then(ifCurrent((us: UsDashboard) => {
        if (!us) return;
        setUsDash(us);
      })).catch(() => {});
      if (!staticLoadedRef.current) {
        api('/portfolio/allocation').then(ifCurrent((ac: AllocConfig) => { if (ac) setAllocConfig(ac); })).catch(() => {});
      }
    } catch (err) { setLoading(false); console.error('[AAB] 데이터 로드 실패:', err); }
    finally { loadingRef.current = false; }
  }, []);

  // viewMode는 useState 초기화에서 동기적으로 localStorage 복원됨 (위 참조)
  // 별도 useEffect 불필요 — SSE/API 레이스 컨디션 원천 차단

  // feature flags 로드
  useEffect(() => {
    api('/feature-flags').then((r: { flags?: Array<{ key: string; enabled: boolean }> }) => {
      const map: Record<string, boolean> = {};
      (r.flags || []).forEach((f) => { map[f.key] = f.enabled; });
      setFeatureFlags(map);
    }).catch(() => {});
  }, [viewMode]);

  // 초기 로드 + 폴링
  useEffect(() => {
    load(true);
    const getInterval = () => {
      const h = new Date().getHours(), m = new Date().getMinutes();
      const mins = h * 60 + m;
      const isMarket = mins >= 9 * 60 && mins < 15 * 60 + 30;
      const visible = document.visibilityState === 'visible';
      if (!visible) return 300000;
      return isMarket ? 20000 : 120000;
    };
    let iv: ReturnType<typeof setInterval>;
    const schedule = () => { iv = setInterval(() => { load(); clearInterval(iv); schedule(); }, getInterval()); };
    schedule();
    const onVisibility = () => { clearInterval(iv); schedule(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVisibility); };
  }, [load]);

  // SSE 실시간 스트림
  useSSEStream(viewMode, { setTrades, setStrategy, setDash, setUsDash, setLoopStatus, setSseHealthScore });

  const switchView = useCallback((mode: 'live' | 'paper') => {
    if (viewModeRef.current === mode) return;
    viewModeRef.current = mode;
    setViewMode(mode);
    try { localStorage.setItem('aab_viewMode', mode); } catch {}
    setDash(null);
    setUsDash(null);
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
    featureFlags, setFeatureFlags, viewMode, switchView, load,
  };
}
