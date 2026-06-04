'use client';

import { useEffect } from 'react';
import { api, BACKEND_URL } from '../lib/utils';
import type { Dashboard, Trade, UsDashboard, Strategy, LoopStatus } from '../types';

interface SSESetters {
  setTrades: React.Dispatch<React.SetStateAction<Trade[]>>;
  setStrategy: React.Dispatch<React.SetStateAction<Strategy | null>>;
  setDash: React.Dispatch<React.SetStateAction<Dashboard | null>>;
  setUsDash: React.Dispatch<React.SetStateAction<UsDashboard | null>>;
  setLoopStatus: React.Dispatch<React.SetStateAction<LoopStatus | null>>;
  setSseHealthScore: React.Dispatch<React.SetStateAction<number>>;
}

export function useSSEStream(viewMode: 'live' | 'paper', setters: SSESetters) {
  const { setTrades, setStrategy, setDash, setUsDash, setLoopStatus, setSseHealthScore } = setters;

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
              const incomingMap = new Map<string, Trade>(data.recentTrades.map((t: Trade) => [String(t.id), t]));
              const existingIds = new Set(prev.map(t => String(t.id)));
              const updated = prev.map(t => {
                const fresh = incomingMap.get(String(t.id));
                return fresh ? { ...t, ...fresh } : t;
              });
              const brandNew = data.recentTrades.filter((t: Trade) => !existingIds.has(String(t.id)));
              return brandNew.length > 0 ? [...brandNew, ...updated].slice(0, 200) : updated;
            });
          }
          if (data.strategy) {
            setStrategy(prev => prev ? { ...prev, ...data.strategy } : data.strategy);
          }
          if (Array.isArray(data.chainPrices) && data.chainPrices.length > 0) {
            setDash(prev => {
              if (!prev?.chains) return prev;
              const priceMap = new Map<string, {stock_code:string;currentPrice:number;unrealizedPnl:number;unrealizedPnlPct:number}>(data.chainPrices.map((cp: {stock_code:string;currentPrice:number;unrealizedPnl:number;unrealizedPnlPct:number}) => [cp.stock_code, cp]));
              const updatedChains = prev.chains.map(ch => {
                const cp = priceMap.get(ch.stock_code);
                if (!cp || cp.currentPrice <= 0) return ch;
                return { ...ch, currentPrice: cp.currentPrice, unrealizedPnl: cp.unrealizedPnl, unrealizedPnlPct: cp.unrealizedPnlPct };
              });
              const updatedPortfolio = data.portfolio?.unrealizedPnl != null
                ? { ...prev.portfolio, unrealizedPnl: data.portfolio.unrealizedPnl }
                : prev.portfolio;
              return { ...prev, chains: updatedChains, portfolio: updatedPortfolio };
            });
          }
          const chainsChanged = prevChainCount !== -1 && data.activeChains !== prevChainCount;
          const overseasChanged = prevOverseasCount !== -1 && data.overseasHoldingCount !== undefined && data.overseasHoldingCount !== prevOverseasCount;
          if (chainsChanged || overseasChanged) {
            api(`/dashboard?viewMode=${vm}`).then((d: Dashboard) => { if (d) setDash(d); }).catch(() => {});
            api(`/trades?limit=200&viewMode=${vm}`).then((t: Trade[]) => { if (Array.isArray(t) && t.length > 0) setTrades(t); }).catch(() => {});
            api(`/overseas/dashboard?viewMode=${vm}`).then((us: UsDashboard) => {
              if (us) setUsDash(us);
            }).catch(() => {});
          }
          prevChainCount = data.activeChains ?? prevChainCount;
          if (data.overseasHoldingCount !== undefined) prevOverseasCount = data.overseasHoldingCount;
          if (data.loopMode) setLoopStatus({ ...data.loopMode, openMarkets: data.loopMode.openMarkets ?? [], autoPilot: data.autoPilot ?? null });
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
  }, [viewMode, setTrades, setStrategy, setDash, setUsDash, setLoopStatus, setSseHealthScore]);
}
