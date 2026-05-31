/**
 * 경량 헬스 엔드포인트 — 스크린샷 없이 DB 쿼리만으로 건강도 점수 반환 (~200ms)
 * GET /review/copilot-lite?viewMode=paper|live
 */
import { Hono } from 'hono';

const app = new Hono();

app.get('/review/copilot-lite', async (c) => {
  try {
    const { getPool } = await import('../../../db/client.js');
    const { baseIsPaper } = await import('../../../config/index.js');
    const pool = getPool();

    const viewModeParam = c.req.query('viewMode');
    const viewIsPaper = viewModeParam === 'paper' ? true : viewModeParam === 'live' ? false : baseIsPaper;

    let score = 100;
    const issues: { id: string; level: 'warn' | 'danger'; label: string }[] = [];

    // 1. 월간 MDD
    try {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const { rows } = await pool.query(
        `SELECT total_value FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2 ORDER BY snapshot_at ASC`,
        [monthStart.toISOString(), viewIsPaper],
      );
      if (rows.length >= 2) {
        const values = rows.map((r: any) => Number(r.total_value));
        const peak = Math.max(...values);
        const latest = values[values.length - 1];
        const mddPct = peak > 0 ? ((peak - latest) / peak) * 100 : 0;
        const limit = viewIsPaper ? 40 : 8;
        if (mddPct >= limit) { score -= 25; issues.push({ id: 'mdd', level: 'danger', label: `MDD ${mddPct.toFixed(1)}%` }); }
        else if (mddPct >= limit * 0.75) { score -= 10; issues.push({ id: 'mdd', level: 'warn', label: `MDD ${mddPct.toFixed(1)}%` }); }
      }
    } catch {}

    // 2. 연속 손실
    try {
      const { rows } = await pool.query(
        `SELECT realized_pnl FROM transaction_chains WHERE status = 'CLOSED' AND is_paper = $1 ORDER BY closed_at DESC LIMIT 10`,
        [viewIsPaper],
      );
      let streak = 0;
      for (const r of rows) { if (Number(r.realized_pnl) < 0) streak++; else break; }
      if (streak >= 5) { score -= 20; issues.push({ id: 'loss_streak', level: 'danger', label: `${streak}연속 손실` }); }
      else if (streak >= 3) { score -= 10; issues.push({ id: 'loss_streak', level: 'warn', label: `${streak}연속 손실` }); }
    } catch {}

    // 3. Kill Switch
    try {
      const { getKillSwitchStatusAll } = await import('../../../risk/kill-switch.js');
      const ks = getKillSwitchStatusAll();
      if ((ks as any).overseas?.active) { score -= 20; issues.push({ id: 'kill_switch', level: 'danger', label: 'Kill Switch 활성' }); }
    } catch {}

    // 4. 21일 초과 보유
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1 AND bought_at < NOW() - INTERVAL '21 days'`,
        [viewIsPaper],
      );
      const cnt = Number(rows[0]?.cnt ?? 0);
      if (cnt > 0) { score -= 7 * cnt; issues.push({ id: 'old_holdings', level: 'warn', label: `${cnt}종목 21일+ 보유` }); }
    } catch {}

    return c.json({
      score: Math.max(0, Math.min(100, score)),
      issues,
      timestamp: new Date().toISOString(),
      mode: viewIsPaper ? 'paper' : 'live',
    });
  } catch (err: any) {
    return c.json({ score: 0, issues: [], error: err.message }, 500);
  }
});

export default app;

/** 서버 내부 직접 호출용 — SSE 등에서 사용 */
export async function getCopilotLiteScore(viewIsPaper: boolean): Promise<{ score: number; issues: { id: string; level: string; label: string }[] }> {
  try {
    const { getPool } = await import('../../../db/client.js');
    const pool = getPool();
    let score = 100;
    const issues: { id: string; level: string; label: string }[] = [];

    // MDD
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { rows: snapRows } = await pool.query(
      `SELECT total_value FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2 ORDER BY snapshot_at ASC`,
      [monthStart.toISOString(), viewIsPaper],
    );
    if (snapRows.length >= 2) {
      const values = snapRows.map((r: any) => Number(r.total_value));
      const peak = Math.max(...values);
      const latest = values[values.length - 1];
      const mddPct = peak > 0 ? ((peak - latest) / peak) * 100 : 0;
      const limit = viewIsPaper ? 40 : 8;
      if (mddPct >= limit) { score -= 25; issues.push({ id: 'mdd', level: 'danger', label: `MDD ${mddPct.toFixed(1)}%` }); }
      else if (mddPct >= limit * 0.75) { score -= 10; issues.push({ id: 'mdd', level: 'warn', label: `MDD ${mddPct.toFixed(1)}%` }); }
    }

    // Kill Switch
    const { getKillSwitchStatusAll } = await import('../../../risk/kill-switch.js');
    const ks = getKillSwitchStatusAll();
    if ((ks as any).overseas?.active) { score -= 20; issues.push({ id: 'kill_switch', level: 'danger', label: 'Kill Switch 활성' }); }

    return { score: Math.max(0, Math.min(100, score)), issues };
  } catch {
    return { score: 0, issues: [] };
  }
}
