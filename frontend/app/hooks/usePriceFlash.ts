'use client';

import { useRef, useState, useEffect } from 'react';

/**
 * 가격 변동 플래시 감지 훅
 * prices: { [stockCode]: currentPrice }
 * returns: { [stockCode]: 'up' | 'down' } — 800ms 후 자동 초기화
 */
export function usePriceFlash(prices: Record<string, number>): Record<string, 'up' | 'down'> {
  const prevRef = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const newFlash: Record<string, 'up' | 'down'> = {};
    for (const [code, price] of Object.entries(prices)) {
      const prev = prevRef.current[code];
      if (prev != null && prev > 0 && price > 0 && price !== prev) {
        newFlash[code] = price > prev ? 'up' : 'down';
      }
    }
    prevRef.current = { ...prices };
    if (Object.keys(newFlash).length > 0) {
      setFlash(newFlash);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFlash({}), 800);
    }
    return () => clearTimeout(timerRef.current);
  }, [prices]);

  return flash;
}
