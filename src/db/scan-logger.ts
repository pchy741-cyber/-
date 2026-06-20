import { logger } from '../utils/logger.js';
import { getPool } from './client.js';
import type { TradeDecision } from './models.js';

export interface ScanSessionInput {
  isPaper: boolean;
  effectiveMode: string;
  kospiPenalty: number;
  kospiBoost: boolean;
  blockNewBuys: boolean;
  flashCrash: boolean;
  dailyPnlPct: number;
  totalAssets: number;
  orderableCash: number;
  scoresCount: number;
  macroRegime?: string;
  crashSignalLevel?: string;
  adamKhooBullish?: boolean | null;
  adamKhooBelowMa200?: boolean | null;
  elapsedMs: number;
}

export interface ScanStockInput {
  stockCode: string;
  aiScoreRaw?: number;
  aiScoreAdjusted?: number;
  confidence?: number;
  regime?: string;
  regimeConfidence?: number;
  adx?: number;
  autocorrelation?: number;
  buyThresholdAdj?: number;
  action: string;
  skipReason?: string;
  quantity?: number;
  isPaper: boolean;
}

export async function logScanSession(
  session: ScanSessionInput,
  decisions: TradeDecision[],
  stocks: ScanStockInput[],
): Promise<void> {
  try {
    const pool = getPool();
    const buysCount = decisions.filter((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN').length;
    const sellsCount = decisions.filter(
      (d) => d.action === 'SELL' || d.action === 'PARTIAL_SELL' || d.action === 'FORCE_CLOSE',
    ).length;

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO scan_sessions
        (is_paper, effective_mode, kospi_penalty, kospi_boost, block_new_buys, flash_crash,
         daily_pnl_pct, total_assets, orderable_cash, scores_count,
         decisions_count, buys_count, sells_count, elapsed_ms, macro_regime, crash_signal_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        session.isPaper,
        session.effectiveMode,
        session.kospiPenalty,
        session.kospiBoost,
        session.blockNewBuys,
        session.flashCrash,
        session.dailyPnlPct,
        Math.round(session.totalAssets),
        Math.round(session.orderableCash),
        session.scoresCount,
        decisions.length,
        buysCount,
        sellsCount,
        session.elapsedMs,
        session.macroRegime ?? null,
        session.crashSignalLevel ?? 'NONE',
      ],
    );

    const sessionId = rows[0]?.id;
    if (!sessionId || stocks.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const s of stocks) {
      placeholders.push(
        `($${idx},$${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6},$${idx + 7},$${idx + 8},$${idx + 9},$${idx + 10},$${idx + 11},$${idx + 12},$${idx + 13})`,
      );
      values.push(
        sessionId,
        s.stockCode,
        s.aiScoreRaw ?? null,
        s.aiScoreAdjusted ?? null,
        s.confidence ?? null,
        s.regime ?? null,
        s.regimeConfidence ?? null,
        s.adx ?? null,
        s.autocorrelation ?? null,
        s.buyThresholdAdj ?? 0,
        s.action,
        s.skipReason ?? null,
        s.quantity ?? null,
        s.isPaper,
      );
      idx += 14;
    }
    await pool.query(
      `INSERT INTO scan_stock_decisions
        (session_id, stock_code, ai_score_raw, ai_score_adjusted, confidence,
         regime, regime_confidence, adx, autocorrelation, buy_threshold_adj,
         action, skip_reason, quantity, is_paper)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  } catch (e) {
    logger.warn(`scan_sessions 로그 실패 (무시): ${(e as Error).message}`, { component: 'SCAN_LOG' });
  }
}
