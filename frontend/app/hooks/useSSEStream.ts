'use client';

import { useEffect } from 'react';
import { api, BACKEND_URL } from '../lib/utils';
import type { Dashboard, Trade, UsDashboard, Strategy, LoopStatus, Health, TodayStats } from '../types';

interface SSESetters {
  setTrades: React.Dispatch<React.SetStateAction<Trade[]>>;
  setStrategy: React.Dispatch<React.SetStateAction<Strategy | null>>;
  setDash: React.Dispatch<React.SetStateAction<Dashboard | null>>;
  setUsDash: React.Dispatch<React.SetStateAction<UsDashboard | null>>;
  setLoopStatus: React.Dispatch<React.SetStateAction<LoopStatus | null>>;
  setSseHealthScore: React.Dispatch<React.SetStateAction<number>>;
  setHealth: React.Dispatch<React.SetStateAction<Health | null>>;
  setTodayStats: React.Dispatch<React.SetStateAction<TodayStats | null>>;
  setNewInsightCount: React.Dispatch<React.SetStateAction<number>>;
}

export function useSSEStream(viewMode: 'live' | 'paper', setters: SSESetters) {
  const { setTrades, setStrategy, setDash, setUsDash, setLoopStatus, setSseHealthScore, setHealth, setTodayStats, setNewInsightCount } = setters;

  useEffect(() => {
    const vm = viewMode;
    const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    let es: EventSource | null = null;
    let prevChainCount = -1;
    let prevOverseasCount = -1;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    // 공통: chainPrices + portfolio 머지 로직
    const mergeChainPrices = (data: { chainPrices?: any[]; portfolio?: any; overseasSummary?: any }, isMeta = false) => {
      if (!isMeta && (!Array.isArray(data.chainPrices) || data.chainPrices.length === 0)) return;
      setDash(prev => {
        if (!prev?.chains) return prev;
        // 체인 가격 갱신
        let updatedChains = prev.chains;
        if (Array.isArray(data.chainPrices) && data.chainPrices.length > 0) {
          const priceMap = new Map<string, {stock_code:string;currentPrice:number;unrealizedPnl:number;unrealizedPnlPct:number;weight?:number}>(data.chainPrices.map((cp: any) => [cp.stock_code, cp]));
          updatedChains = prev.chains.map(ch => {
            const cp = priceMap.get(ch.stock_code);
            if (!cp || cp.currentPrice <= 0) return ch;
            return { ...ch, currentPrice: cp.currentPrice, unrealizedPnl: cp.unrealizedPnl, unrealizedPnlPct: cp.unrealizedPnlPct, ...(cp.weight != null ? { weight: cp.weight } : {}) };
          });
        }
        // portfolio 전체 필드 머지 (meta 이벤트에서만 — totalValue, cash, invested 등)
        let updatedPortfolio = prev.portfolio;
        if (isMeta && data.portfolio) {
          const p = data.portfolio;
          updatedPortfolio = {
            ...prev.portfolio,
            ...(p.totalValue != null ? { totalValue: p.totalValue } : {}),
            ...(p.cash != null ? { cash: p.cash } : {}),
            ...(p.invested != null ? { invested: p.invested } : {}),
            ...(p.domesticInvested != null ? { domesticInvested: p.domesticInvested } : {}),
            ...(p.domesticEval != null ? { domesticEval: p.domesticEval } : {}),
            ...(p.domesticCash != null ? { domesticCash: p.domesticCash } : {}),
            ...(p.unrealizedPnl != null ? { unrealizedPnl: p.unrealizedPnl } : {}),
            ...(p.pnl != null ? { pnl: p.pnl } : {}),
            ...(p.pnlPct != null ? { pnlPct: p.pnlPct } : {}),
            ...(p.positionCount != null ? { positionCount: p.positionCount } : {}),
          };
        } else if (data.portfolio?.unrealizedPnl != null) {
          updatedPortfolio = { ...prev.portfolio, unrealizedPnl: data.portfolio.unrealizedPnl };
        }
        // overseas 머지 (meta 이벤트 — overseasSummary → overseas 형식 변환)
        let updatedOverseas = prev.overseas;
        if (isMeta && data.overseasSummary) {
          const os = data.overseasSummary;
          updatedOverseas = {
            ...prev.overseas,
            ...(os.cashUsd != null ? { cashUsd: os.cashUsd } : {}),
            ...(os.cashKrw != null ? { cashKrw: os.cashKrw } : {}),
            ...(os.investedUsd != null ? { totalInvestedUsd: os.investedUsd } : {}),
            ...(os.evalUsd != null ? { totalMarketValueUsd: os.evalUsd } : {}),
            ...(os.investedKrw != null ? { totalInvestedKrw: os.investedKrw } : {}),
            ...(os.evalKrw != null ? { totalMarketValueKrw: os.evalKrw } : {}),
            ...(os.fxRate != null ? { fxRate: os.fxRate } : {}),
          };
        }
        return { ...prev, chains: updatedChains, portfolio: updatedPortfolio, overseas: updatedOverseas };
      });
    };

    const connect = () => {
      if (disposed) return;
      es = new EventSource(`${base}/api/stream?viewMode=${vm}`, { withCredentials: true });

      // 경량 가격 틱 (3초) — chainPrices만 처리
      es.addEventListener('prices', (e: MessageEvent) => {
        if (disposed) return;
        retryCount = 0;
        try {
          const data = JSON.parse(e.data);
          mergeChainPrices(data);
        } catch { /* ignore */ }
      });

      // 전체 메타 페이로드 (30초) — 기존 update 로직
      es.addEventListener('meta', (e: MessageEvent) => {
        if (disposed) return;
        retryCount = 0;
        try {
          const data = JSON.parse(e.data);
          if (Array.isArray(data.recentTrades) && data.recentTrades.length > 0) {
            setTrades(prev => {
              // 모드 전환 직후: prev가 비어있으면(switchView에서 초기화됨) SSE 데이터로 교체
              if (prev.length === 0) return data.recentTrades.slice(0, 200);
              // trading_mode 교차오염 방지: SSE 데이터의 모드와 prev 모드가 다르면 SSE 데이터로 교체
              const prevMode = String(prev[0]?.trading_mode ?? '');
              const sseMode = String(data.recentTrades[0]?.trading_mode ?? '');
              if (prevMode && sseMode && prevMode !== sseMode && sseMode !== 'p_arch') {
                return data.recentTrades.slice(0, 200);
              }
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
          mergeChainPrices(data, true);
          const chainsChanged = prevChainCount !== -1 && data.activeChains !== prevChainCount;
          const overseasChanged = prevOverseasCount !== -1 && data.overseasHoldingCount !== undefined && data.overseasHoldingCount !== prevOverseasCount;
          if (chainsChanged || overseasChanged) {
            // disposed 체크: 모드 전환 시 stale API 응답이 새 모드 데이터 덮어쓰기 방지
            api(`/dashboard?viewMode=${vm}`).then((d: Dashboard) => { if (!disposed && d) setDash(d); }).catch(() => {});
            api(`/trades?limit=200&viewMode=${vm}`).then((t: Trade[]) => { if (!disposed && Array.isArray(t) && t.length > 0) setTrades(t); }).catch(() => {});
            api(`/overseas/dashboard?viewMode=${vm}`).then((us: UsDashboard) => {
              if (!disposed && us) setUsDash(us);
            }).catch(() => {});
          }
          prevChainCount = data.activeChains ?? prevChainCount;
          if (data.overseasHoldingCount !== undefined) prevOverseasCount = data.overseasHoldingCount;
          if (data.loopMode) setLoopStatus({ ...data.loopMode, openMarkets: data.loopMode.openMarkets ?? [], autoPilot: data.autoPilot ?? null });
          if (data.healthScore != null) setSseHealthScore(data.healthScore);
          if (Array.isArray(data.recentEvents)) {
            setHealth(prev => prev ? { ...prev, recentEvents: data.recentEvents } : prev);
          }
          if (data.todayStats) setTodayStats(data.todayStats);
          if (data.newInsightCount != null) setNewInsightCount(data.newInsightCount);
        } catch { /* ignore */ }
      });

      // 하위 호환: 기존 'update' 이벤트도 처리 (배포 전환 중)
      es.addEventListener('update', (e: MessageEvent) => {
        if (disposed) return;
        retryCount = 0;
        try {
          const data = JSON.parse(e.data);
          mergeChainPrices(data);
          if (data.loopMode) setLoopStatus({ ...data.loopMode, openMarkets: data.loopMode.openMarkets ?? [], autoPilot: data.autoPilot ?? null });
          if (data.healthScore != null) setSseHealthScore(data.healthScore);
          if (data.todayStats) setTodayStats(data.todayStats);
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
  }, [viewMode, setTrades, setStrategy, setDash, setUsDash, setLoopStatus, setSseHealthScore, setHealth, setTodayStats, setNewInsightCount]);
}
