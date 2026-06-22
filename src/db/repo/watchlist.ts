import { isMemoryMode, queryWithRetry } from '../pool.js';
import { memGetActiveWatchlist, memUpsertWatchlistItem } from '../memory-store.js';
import type { WatchlistItem } from '../models.js';

export async function getActiveWatchlist(): Promise<WatchlistItem[]> {
  if (isMemoryMode()) return memGetActiveWatchlist();
  // 10분 캐시 — 워치리스트는 자주 변하지 않음 (Track B 매 사이클 DB hit 제거)
  const { cacheGet, cacheSet } = await import('../../cache/memory.js');
  const cached = cacheGet<WatchlistItem[]>('db:watchlist:active');
  if (cached) return cached;
  const { rows } = await queryWithRetry('SELECT * FROM watchlist WHERE is_active = true ORDER BY added_at ASC');
  cacheSet('db:watchlist:active', rows, 600); // 10분 TTL
  return rows;
}

// 종목명 깨짐 감지 (특수문자 ◆ 등)
function isGarbledStockName(name: string): boolean {
  if (!name) return true;
  return /[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$]/.test(name);
}

export async function upsertWatchlistItem(
  item: Pick<WatchlistItem, 'stock_code' | 'stock_name' | 'market'>,
  source: 'MANUAL' | 'KIS_SYNC' | 'AUTO' = 'MANUAL',
) {
  if (isMemoryMode()) {
    memUpsertWatchlistItem(item);
    return;
  }
  // 깨진 종목명으로 기존 정상 이름을 덮어쓰지 않음
  const nameIsGarbled = isGarbledStockName(item.stock_name);
  if (nameIsGarbled) {
    await queryWithRetry(
      `INSERT INTO watchlist (stock_code, stock_name, market, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stock_code) DO UPDATE SET market = $3
         WHERE watchlist.stock_name IS NULL OR watchlist.stock_name = watchlist.stock_code`,
      [item.stock_code, item.stock_code, item.market, source],
    );
  } else {
    await queryWithRetry(
      `INSERT INTO watchlist (stock_code, stock_name, market, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stock_code) DO UPDATE SET stock_name = $2, market = $3`,
      [item.stock_code, item.stock_name, item.market, source],
    );
  }
  // 워치리스트 캐시 무효화
  import('../../cache/memory.js').then((m) => m.cacheSet('db:watchlist:active', null, 0));
}
