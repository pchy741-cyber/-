import { isMemoryMode, queryWithRetry } from '../pool.js';
import { memGetActiveWatchlist, memUpsertWatchlistItem } from '../memory-store.js';
import type { WatchlistItem } from '../models.js';
import { getKSTNow } from '../../utils/time.js';

/** 장중(09:00~15:30): 2분, 장후: 10분 — 장중 새 편입 종목 빠른 반영 */
function getWatchlistTtl(): number {
  const kst = getKSTNow();
  const t = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  return t >= 900 && t <= 1530 ? 120 : 600;
}

export async function getActiveWatchlist(): Promise<WatchlistItem[]> {
  if (isMemoryMode()) return memGetActiveWatchlist();
  const { cacheGet, cacheSet } = await import('../../cache/memory.js');
  const cached = cacheGet<WatchlistItem[]>('db:watchlist:active');
  if (cached) return cached;
  const { rows } = await queryWithRetry('SELECT stock_code, stock_name, market, source, is_active, added_at FROM watchlist WHERE is_active = true ORDER BY added_at ASC');
  cacheSet('db:watchlist:active', rows, getWatchlistTtl());
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
