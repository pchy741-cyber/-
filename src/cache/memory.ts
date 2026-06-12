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
  private static readonly MAX_ENTRIES = 10_000; // 장기운영 메모리 비대화 방지
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // 10분마다 만료된 항목 정리 (30m→10m, 장기운영 메모리 축적 방지)
    this.cleanupInterval = setInterval(() => this.cleanup(), 600_000);
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    // 상한 초과 시 만료 엔트리 정리, 그래도 초과면 가장 오래된 20% 제거
    if (this.store.size > MemoryCache.MAX_ENTRIES) {
      this.cleanup();
      if (this.store.size > MemoryCache.MAX_ENTRIES) {
        const entries = [...this.store.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        entries.slice(0, Math.floor(entries.length * 0.2)).forEach(([k]) => {
          this.store.delete(k);
        });
      }
    }
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
