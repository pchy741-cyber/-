import { isMemoryMode, queryWithRetry } from '../pool.js';

export async function getRecentSources(
  limit = 20,
): Promise<Array<{ title: string; url: string; source_type: string; memo: string | null }>> {
  if (isMemoryMode()) return [];
  try {
    const { rows } = await queryWithRetry(
      'SELECT title, url, source_type, memo FROM market_sources ORDER BY is_pinned DESC, added_at DESC LIMIT $1',
      [limit],
    );
    return rows;
  } catch {
    return [];
  }
}
