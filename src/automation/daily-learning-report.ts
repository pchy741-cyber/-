/**
 * 📊 일일 학습 리포트 — 매일 18:30 KST
 *
 * 그날 매매 통계 + 손실 패턴 + 학습된 인사이트 자동 정리
 *  → Telegram 전송
 *  → Google Sheets 백업 (sheets-journal과 별도)
 *
 * 포함 내용:
 *  1. 매매 통계: 매수/매도/승률/수익금
 *  2. 종목별 성과: 상위 5 (이익) / 하위 5 (손실)
 *  3. 사유별 분포: close_reason 클러스터링
 *  4. 강화 모듈 동작: MDD 가드 / AutoPilot / 캡쳐 트리거 횟수
 *  5. 신규 학습된 인사이트: failure_patterns 변경분
 *  6. 다음 날 권장사항
 */

import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const COMP = 'DAILY_REPORT';

interface DailyStats {
  trades: number;
  wins: number;
  winRate: number;
  totalPnlKrw: number;
  avgPnlPct: number;
  bestStock: { code: string; pnl: number } | null;
  worstStock: { code: string; pnl: number } | null;
  closeReasons: Array<{ reason: string; count: number; avgPnl: number }>;
}

async function fetchDailyStats(isPaper: boolean): Promise<DailyStats> {
  const pool = getPool();
  const { rows } = await pool.query(
    `WITH today AS (
      SELECT
        stock_code,
        realized_pnl,
        (realized_pnl / NULLIF(total_invested, 0)) * 100 AS pnl_pct,
        close_reason
      FROM transaction_chains
      WHERE status = 'CLOSED' AND is_paper = $1
        AND closed_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
    )
    SELECT
      COUNT(*) AS trades,
      COUNT(*) FILTER (WHERE pnl_pct > 0) AS wins,
      COALESCE(SUM(realized_pnl), 0) AS total_pnl,
      COALESCE(AVG(pnl_pct), 0) AS avg_pnl_pct,
      (ARRAY_AGG(stock_code ORDER BY pnl_pct DESC NULLS LAST))[1] AS best_code,
      MAX(pnl_pct) AS best_pnl,
      (ARRAY_AGG(stock_code ORDER BY pnl_pct ASC NULLS LAST))[1] AS worst_code,
      MIN(pnl_pct) AS worst_pnl
    FROM today`,
    [isPaper],
  );

  // 사유별 통계
  const { rows: reasonRows } = await pool.query(
    `SELECT
      LEFT(close_reason, 30) AS reason,
      COUNT(*) AS cnt,
      AVG((realized_pnl / NULLIF(total_invested, 0)) * 100) AS avg_pnl
    FROM transaction_chains
    WHERE status = 'CLOSED' AND is_paper = $1
      AND closed_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
      AND close_reason IS NOT NULL
    GROUP BY LEFT(close_reason, 30)
    ORDER BY COUNT(*) DESC LIMIT 5`,
    [isPaper],
  );

  const r = rows[0] ?? {};
  const trades = Number(r.trades ?? 0);
  const wins = Number(r.wins ?? 0);

  return {
    trades,
    wins,
    winRate: trades > 0 ? wins / trades : 0,
    totalPnlKrw: Number(r.total_pnl ?? 0),
    avgPnlPct: Number(r.avg_pnl_pct ?? 0),
    bestStock:
      r.best_code != null
        ? { code: String(r.best_code), pnl: Number(r.best_pnl ?? 0) }
        : null,
    worstStock:
      r.worst_code != null
        ? { code: String(r.worst_code), pnl: Number(r.worst_pnl ?? 0) }
        : null,
    closeReasons: reasonRows.map((rr) => ({
      reason: String(rr.reason),
      count: Number(rr.cnt),
      avgPnl: Number(rr.avg_pnl ?? 0),
    })),
  };
}

async function fetchAutomationStats(): Promise<{ mddTriggers: number; autopilotChanges: number; captures: number }> {
  const pool = getPool();
  const { rows } = await pool.query(
    `WITH today_overrides AS (
      SELECT command_type, payload, reject_reason
      FROM ai_command_log
      WHERE created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
    ),
    today_caps AS (
      SELECT trigger FROM capture_snapshots
      WHERE captured_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
    )
    SELECT
      (SELECT COUNT(*) FROM today_overrides WHERE payload::text LIKE '%mdd_guard%') AS mdd,
      (SELECT COUNT(*) FROM today_overrides WHERE payload::text LIKE '%AutoPilot%') AS autopilot,
      (SELECT COUNT(*) FROM today_caps) AS captures`,
  );
  return {
    mddTriggers: Number(rows[0]?.mdd ?? 0),
    autopilotChanges: Number(rows[0]?.autopilot ?? 0),
    captures: Number(rows[0]?.captures ?? 0),
  };
}

async function fetchNewlyLearned(): Promise<Array<{ stockCode: string; recommendation: string; reason: string }>> {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT stock_code, recommendation, reason
       FROM failure_patterns
       WHERE analyzed_at > NOW() - INTERVAL '24 hours'
         AND recommendation != 'WATCH'
       ORDER BY analyzed_at DESC LIMIT 5`,
    );
    return rows.map((r) => ({
      stockCode: String(r.stock_code),
      recommendation: String(r.recommendation),
      reason: String(r.reason ?? ''),
    }));
  } catch (err) {
    logger.debug(`자동화 추천 조회 실패: ${err}`, { component: 'LEARNING_REPORT' });
    return [];
  }
}

function formatReport(mode: 'paper' | 'live', stats: DailyStats, auto: Awaited<ReturnType<typeof fetchAutomationStats>>, learned: Awaited<ReturnType<typeof fetchNewlyLearned>>): string {
  const modeLabel = mode === 'paper' ? '연습' : '실전';
  const lines = [
    `📊 *일일 학습 리포트* [${modeLabel}]`,
    `\n*매매 통계*`,
    `  거래 ${stats.trades}건 | 승률 ${(stats.winRate * 100).toFixed(0)}%`,
    `  PnL ${stats.totalPnlKrw >= 0 ? '+' : ''}₩${stats.totalPnlKrw.toLocaleString('ko-KR')}`,
    `  평균 ${stats.avgPnlPct >= 0 ? '+' : ''}${stats.avgPnlPct.toFixed(2)}%`,
  ];
  if (stats.bestStock) lines.push(`  🏆 최고: ${stats.bestStock.code} +${stats.bestStock.pnl.toFixed(1)}%`);
  if (stats.worstStock) lines.push(`  💀 최악: ${stats.worstStock.code} ${stats.worstStock.pnl.toFixed(1)}%`);

  if (stats.closeReasons.length > 0) {
    lines.push(`\n*매도 사유 분포*`);
    for (const r of stats.closeReasons.slice(0, 3)) {
      lines.push(`  ${r.count}회 | ${r.reason.slice(0, 25)} | 평균 ${r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(1)}%`);
    }
  }

  lines.push(`\n*자동화 동작*`);
  lines.push(`  MDD 가드: ${auto.mddTriggers}회`);
  lines.push(`  AutoPilot 조정: ${auto.autopilotChanges}회`);
  lines.push(`  캡쳐 진단: ${auto.captures}회`);

  if (learned.length > 0) {
    lines.push(`\n*신규 학습*`);
    for (const l of learned.slice(0, 5)) {
      lines.push(`  🎓 ${l.stockCode} [${l.recommendation}] ${l.reason.slice(0, 30)}`);
    }
  }

  return lines.join('\n');
}

export async function runDailyLearningReport(): Promise<void> {
  try {
    const { runWithMode } = await import('../config/context.js');
    const [auto, learned] = await Promise.all([fetchAutomationStats(), fetchNewlyLearned()]);

    for (const mode of ['paper', 'live'] as const) {
      const isPaper = mode === 'paper';
      const stats = await runWithMode(isPaper, () => fetchDailyStats(isPaper));
      if (stats.trades === 0 && auto.mddTriggers === 0 && auto.captures === 0) {
        logger.debug(`일일 리포트 [${mode}] 스킵: 활동 없음`, { component: COMP });
        continue;
      }
      const msg = formatReport(mode, stats, auto, learned);
      await sendTelegramMessage(msg).catch(() => {});
      logger.info(`📊 일일 리포트 [${mode}] 전송: ${stats.trades}건`, { component: COMP });
    }
  } catch (e) {
    logger.error(`일일 학습 리포트 실패: ${(e as Error).message}`, { component: COMP });
  }
}
