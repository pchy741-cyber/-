'use client';
import { useEffect, useState } from 'react';

/**
 * matchMedia 기반 반응형 훅 — resize/방향전환 자동 반영
 *
 * 사용:
 *   const isTablet = useMediaQuery('(min-width: 600px) and (pointer: coarse)');
 *   const isDesktop = useMediaQuery('(min-width: 1024px)');
 *   const isDark = useMediaQuery('(prefers-color-scheme: dark)');
 *
 * 주의: SSR 환경에서는 initial false 반환 → hydration 후 정확값 갱신.
 */
export function useMediaQuery(query: string, defaultMatches = false): boolean {
  const [matches, setMatches] = useState<boolean>(defaultMatches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Safari < 14 호환
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }, [query]);

  return matches;
}

/** 자주 쓰는 breakpoint 프리셋 — Tailwind와 일치 */
export const MEDIA = {
  sm: '(min-width: 640px)',
  md: '(min-width: 768px)',
  lg: '(min-width: 1024px)',
  xl: '(min-width: 1280px)',
  tablet: '(min-width: 600px) and (pointer: coarse)',
  touchDevice: '(pointer: coarse)',
  portrait: '(orientation: portrait)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const;
