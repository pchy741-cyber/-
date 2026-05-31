'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api, BACKEND_URL } from '../lib/utils';

export function useDashboardData() {
  const [health, setHealth] = useState<any>(null);
  const [dash, setDash] = useState<any>(null);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [strategy, setStrategy] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [killSwitch, setKillSwitch] = useState<any>(null);
  const [secrets, setSecrets] = useState<any>(null);
  const [usDash, setUsDash] = useState<any>(null);
  const [withdrawConfig, setWithdrawConfig] = useState<any>(null);
  const [withdrawHistory, setWithdrawHistory] = useState<any[]>([]);
  const [allocConfig, setAllocConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [loopStatus, setLoopStatus] = useState<any>(null);
  const [sseHealthScore, setSseHealthScore] = useState<number>(0);
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});

  const [viewMode, setViewMode] = useState<'live'|'paper'>('live');

  const loadingRef = useRef(false);
  const loadGenRef = useRef(0);
  const staticLoadedRef = useRef(false);
  const tradesLoadedRef = useRef(false);
  const tradesLastFetchRef = useRef(0);
  const viewModeRef = useRef<'live'|'paper'>('live');

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
    api(`/trades?limit=100&viewMode=${vm}`).then((t: any) => {
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

      api(`/overseas/dashboard?viewMode=${vm}`).then(ifCurrent((us: any) => {
        if (!us) return;
        setUsDash(us);
      })).catch(() => {});
      if (!staticLoadedRef.current) {
        api('/portfolio/allocation').then(ifCurrent((ac: any) => { if (ac) setAllocConfig(ac); })).catch(() => {});
      }
    } catch (err) { setLoading(false); console.error('[QUANTOPS] 데이터 로드 실패:', err); }
    finally { loadingRef.current = false; }
  }, []);

  // localStorage에서 viewMode 복원
  useEffect(() => {
    try {
      const saved = localStorage.getItem('quantops_viewMode');
      if (saved === 'paper' || saved === 'live') {
        viewModeRef.current = saved;
        if (saved !== 'live') setViewMode(saved);
      }
    } catch {}
  }, []);

  // feature flags 로드
  useEffect(() => {
    api('/feature-flags').then((r: any) => {
      const map: Record<string, boolean> = {};
      (r.flags || []).forEach((f: any) => { map[f.key] = f.enabled; });
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
  useEffect(() => {
    const vm = viewMode;
    const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    let es: EventSource | null = null;
    let prevChainCount = -1;
    let prevOverseasCount = -1;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource(`${base}/api/stream?viewMode=${vm}`, { withCredentials: true });

      es.addEventListener('update', (e: MessageEvent) => {
        retryCount = 0;
        try {
          const data = JSON.parse(e.data);
          if (Array.isArray(data.recentTrades) && data.recentTrades.length > 0) {
            setTrades(prev => {
              const incomingMap = new Map<string, any>(data.recentTrades.map((t: any) => [String(t.id), t]));
              const existingIds = new Set(prev.map((t: any) => String(t.id)));
              const updated = prev.map((t: any) => {
                const fresh = incomingMap.get(String(t.id));
                return fresh ? { ...t, ...fresh } : t;
              });
              const brandNew = data.recentTrades.filter((t: any) => !existingIds.has(String(t.id)));
              return brandNew.length > 0 ? [...brandNew, ...updated].slice(0, 200) : updated;
            });
          }
          if (data.strategy) {
            setStrategy((prev: any) => prev ? { ...prev, ...data.strategy } : data.strategy);
          }
          const chainsChanged = prevChainCount !== -1 && data.activeChains !== prevChainCount;
          const overseasChanged = prevOverseasCount !== -1 && data.overseasHoldingCount !== undefined && data.overseasHoldingCount !== prevOverseasCount;
          if (chainsChanged || overseasChanged) {
            api(`/dashboard?viewMode=${vm}`).then((d: any) => { if (d) setDash(d); }).catch(() => {});
            api(`/trades?limit=200&viewMode=${vm}`).then((t: any) => { if (Array.isArray(t) && t.length > 0) setTrades(t); }).catch(() => {});
            api(`/overseas/dashboard?viewMode=${vm}`).then((us: any) => {
              if (us) setUsDash(us);
            }).catch(() => {});
          }
          prevChainCount = data.activeChains ?? prevChainCount;
          if (data.overseasHoldingCount !== undefined) prevOverseasCount = data.overseasHoldingCount;
          if (data.loopMode) setLoopStatus(data.loopMode);
          if (data.healthScore != null) setSseHealthScore(data.healthScore);
        } catch { /* ignore */ }
      });

      es.onerror = () => {
        es?.close();
        if (disposed) return;
        retryCount = Math.min(retryCount + 1, 5);
        const delay = Math.min(2000 * Math.pow(2, retryCount), 30000);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [viewMode]);

  const switchView = useCallback((mode: 'live' | 'paper') => {
    if (viewModeRef.current === mode) return;
    viewModeRef.current = mode;
    setViewMode(mode);
    try { localStorage.setItem('quantops_viewMode', mode); } catch {}
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
