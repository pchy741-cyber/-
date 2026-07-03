'use client';

import { useState, useEffect, useRef } from 'react';

/**
 * DART/SEC 리포트 탭 공통 훅 — 상태 관리 + 30분 자동 리프레시
 */
export function useReportsFetcher<T>({
  fetchFn,
  watchlistLength,
}: {
  fetchFn: () => Promise<T[] | null>;
  watchlistLength: number;
}) {
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFn();
      if (data) setResults(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '분석 실패');
    } finally {
      setLoading(false);
    }
  };

  // 30분 자동 리프레시
  const loadRef = useRef(load);
  const loadingRef = useRef(loading);
  const lenRef = useRef(watchlistLength);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => { lenRef.current = watchlistLength; }, [watchlistLength]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!loadingRef.current && lenRef.current > 0) loadRef.current();
    }, 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  return { results, setResults, loading, error, setError, expanded, setExpanded, load };
}
