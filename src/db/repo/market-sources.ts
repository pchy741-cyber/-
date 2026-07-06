import { isMemoryMode, queryWithRetry, withTransaction } from '../pool.js';

export async function getRecentSources(
  limit = 20,
): Promise<Array<{ title: string; url: string; source_type: string; memo: string | null; body: string | null }>> {
  if (isMemoryMode()) return [];
  try {
    const { rows } = await queryWithRetry(
      `SELECT title, url, source_type, memo, body FROM market_sources
       WHERE (expires_at IS NULL OR expires_at >= CURRENT_DATE)
       ORDER BY is_pinned DESC, added_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * Fable 스케줄 카드 일괄 교체 — DELETE(fable_scheduled) → INSERT 트랜잭션
 */
export async function replaceFableCards(
  cards: Array<{ title: string; body: string; expires_at: string }>,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM market_sources WHERE source = 'fable_scheduled'`);
    for (const card of cards) {
      await client.query(
        `INSERT INTO market_sources (title, url, source_type, body, source, expires_at)
         VALUES ($1, '', 'fable', $2, 'fable_scheduled', $3)`,
        [card.title, card.body, card.expires_at],
      );
    }
  });
}
