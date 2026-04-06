'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const API = '/api';

// ── 범용 fetch 훅 ──
export function useApi<T>(path: string, interval?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API}${path}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'API 에러');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    fetchData();
    if (interval) {
      const id = setInterval(fetchData, interval);
      return () => clearInterval(id);
    }
  }, [fetchData, interval]);

  return { data, loading, error, refresh: fetchData };
}

// ── SSE 실시간 스트림 훅 ──
export function useSSE<T>(path: string = '/stream') {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`${API}${path}`);
    eventSourceRef.current = es;

    es.addEventListener('update', (event) => {
      try {
        setData(JSON.parse(event.data));
        setConnected(true);
      } catch { /* ignore */ }
    });

    es.addEventListener('error', () => {
      setConnected(false);
    });

    es.onerror = () => {
      setConnected(false);
      // 자동 재연결 (EventSource 기본 동작)
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [path]);

  return { data, connected };
}

// ── POST/PUT/DELETE 훅 ──
export function useMutation<TBody, TResult = unknown>(path: string, method: 'POST' | 'PUT' | 'DELETE' = 'POST') {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (body?: TBody): Promise<TResult | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `${res.status}`);
      }
      return await res.json();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'API 에러';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, [path, method]);

  return { mutate, loading, error };
}

// ── 대시보드 데이터 타입 ──
export interface DashboardData {
  portfolio: {
    totalValue: number;
    cash: number;
    invested: number;
    pnl: number;
    pnlPct: number;
    positions: Array<{
      stockCode: string;
      stockName: string;
      quantity: number;
      avgBuyPrice: number;
      currentPrice: number;
      evalAmount: number;
      profitLoss: number;
      profitLossPct: number;
    }>;
  };
  activeChains: number;
  chains: unknown[];
  scores: unknown[];
  strategy: { mode: string };
  killSwitch: { active: boolean; reason: string; activatedAt: string | null };
  tradingMode: string;
}

export interface SSEData {
  timestamp: string;
  portfolio: {
    totalValue: number;
    cash: number;
    invested: number;
    pnl: number;
    pnlPct: number;
    positionCount: number;
  };
  killSwitch: { active: boolean; reason: string };
  activeChains: number;
  marketOpen: boolean;
}

export interface HealthData {
  status: string;
  version: string;
  framework: string;
  tradingMode: string;
  marketOpen: boolean;
  killSwitch: { active: boolean };
  database: string;
}
