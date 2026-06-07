/**
 * 인메모리 캐시 — Redis 미설정 시 fallback
 * TTL 기반 자동 만료, KIS API 호출 절감
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // 30분마다 만료된 항목 정리 (v3: 5m→30m, GC 부담 축소)
    this.cleanupInterval = setInterval(() => this.cleanup(), 1_800_000);
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  get size(): number {
    return this.store.size;
  }
}

export const memCache = new MemoryCache();

// ── 가격 캐시 (15초 TTL — 3초 SSE 틱에서 빠르게 stale 감지) ──

export function cachePriceMemory(stockCode: string, price: number): void {
  if (price > 0) memCache.set(`price:${stockCode}`, price, 15);
  // 장기 캐시도 유지 (2시간 — 장 마감 후 fallback용)
  if (price > 0) memCache.set(`price:last:${stockCode}`, price, 7200);
}

export function getCachedPriceMemory(stockCode: string): number | null {
  return memCache.get<number>(`price:${stockCode}`);
}

export function getLastKnownPriceMemory(stockCode: string): number | null {
  return memCache.get<number>(`price:last:${stockCode}`);
}

export function getLastKnownPricesMemory(stockCodes: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const code of stockCodes) {
    const price = memCache.get<number>(`price:last:${code}`) ?? memCache.get<number>(`price:${code}`);
    if (price && price > 0) map.set(code, price);
  }
  return map;
}

// ── 범용 캐시 ──

export function cacheSet<T>(key: string, value: T, ttlSeconds: number): void {
  memCache.set(key, value, ttlSeconds);
}

export function cacheGet<T>(key: string): T | null {
  return memCache.get<T>(key);
}
