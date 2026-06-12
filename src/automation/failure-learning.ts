/**
 * 🎓 자동 실패 학습 — 손실 패턴 자동 추출 + 블랙리스트 자동 갱신
 *
 * CEO 지시 (2026-06-12): "데이터 쌓일수록 다양한 매매 전략 세밀하게 조정"
 *
 * 동작 (매일 02:30 KST):
 *  1. 최근 30일 종결 거래 분석
 *  2. 종목별 누적 손실/연속 손실 카운트
 *  3. 자동 블랙리스트 결정:
 *     - 단일 거래 -8% 이상 손실 → 30일 차단
 *     - 같은 종목 3회 손실 → 60일 차단
 *     - 같은 종목 5회 손실 → 180일 차단 (반영구)
 *     - 같은 종목 10건+ 승률 25% 미만 → 영구 차단
 *  4. 손실 사유 클러스터링 → 패턴 학습
 *  5. ai_overrides에 자동 반영 + Telegram 알림
 *
 * 학습 결과: failure_patterns 테이블 (신규)에 누적
 */

import { setOverride } from '../ai/ai-overrides.js';
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const COMP = 'FAIL_LEARN';
const REASON_PREFIX = 'failure_learn:';

interface StockFailureProfile {
  stockCode: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  worstLoss: number; // 가장 큰 단일 손실 %
  totalLossKrw: number;
  consecutiveLosses: number;
  closeReasons: Record<string, number>; // 사유별 카운트
  recommendation: 'WATCH' | 'BLOCK_30D' | 'BLOCK_60D' | 'BLOCK_180D' | 'BLOCK_FOREVER';
  reason: string;
}

async function analyzeStockFailures(isPaper: boolean, daysBack = 30): Promise<StockFailureProfile[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `WITH closed_trades AS (
      SELECT
        stock_code,
        realized_pnl,
        total_invested,
        (realized_pnl / NULLIF(total_invested, 0)) * 100 AS pnl_pct,
        closed_at,
        close_reason
      FROM transaction_chains
      WHERE status = 'CLOSED'
        AND is_paper = $1
        AND closed_at > NOW() - ($2 || ' days')::interval
    )
    SELECT
      stock_code,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE pnl_pct > 0) AS wins,
      COUNT(*) FILTER (WHERE pnl_pct <= 0) AS losses,
      COALESCE(MIN(pnl_pct), 0) AS worst_pct,
      COALESCE(SUM(realized_pnl) FILTER (WHERE realized_pnl < 0), 0) AS total_loss_krw,
      ARRAY_AGG(close_reason ORDER BY closed_at DESC) AS reasons,
      ARRAY_AGG(pnl_pct ORDER BY closed_at DESC) AS pnl_history
    FROM closed_trades
    GROUP BY stock_code`,
    [isPaper, daysBack],
  );

  const profiles: StockFailureProfile[] = [];
  for (const r of rows) {
    const total = Number(r.total);
    const wins = Number(r.wins);
    const losses = Number(r.losses);
    const winRate = total > 0 ? wins / total : 0.5;
    const worstLoss = Number(r.worst_pct ?? 0);
    const pnlHistory = (r.pnl_history as number[]) ?? [];
    let consec = 0;
    for (const p of pnlHistory) {
      if (Number(p) <= 0) consec++;
      else break;
    }
    const closeReasons: Record<string, number> = {};
    for (const rr of (r.reasons ?? []) as string[]) {
      if (!rr) continue;
      const key = String(rr).slice(0, 30);
      closeReasons[key] = (closeReasons[key] ?? 0) + 1;
    }

    // 권장 결정
    let recommendation: StockFailureProfile['recommendation'] = 'WATCH';
    let reason = '';
    if (total >= 10 && winRate < 0.25) {
      recommendation = 'BLOCK_FOREVER';
      reason = `${total}건 승률 ${(winRate * 100).toFixed(0)}% < 25% → 영구 차단`;
    } else if (losses >= 5) {
      recommendation = 'BLOCK_180D';
      reason = `${losses}회 손실 → 180일 차단`;
    } else if (losses >= 3) {
      recommendation = 'BLOCK_60D';
      reason = `${losses}회 손실 → 60일 차단`;
    } else if (worstLoss <= -8) {
      recommendation = 'BLOCK_30D';
      reason = `최대 손실 ${worstLoss.toFixed(1)}% → 30일 차단`;
    } else if (consec >= 2) {
      recommendation = 'WATCH';
      reason = `${consec}연속 손실 — 주의 관찰`;
    }

    profiles.push({
      stockCode: String(r.stock_code),
      totalTrades: total,
      wins,
      losses,
      winRate,
      worstLoss,
      totalLossKrw: Number(r.total_loss_krw ?? 0),
      consecutiveLosses: consec,
      closeReasons,
      recommendation,
      reason,
    });
  }
  return profiles.filter((p) => p.recommendation !== 'WATCH' || p.consecutiveLosses >= 2);
}

/** 권장 차단 시간 (분) */
function ttlMinutesFor(rec: StockFailureProfile['recommendation']): number {
  switch (rec) {
    case 'BLOCK_30D':
      return 30 * 24 * 60;
    case 'BLOCK_60D':
      return 60 * 24 * 60;
    case 'BLOCK_180D':
      return 180 * 24 * 60;
    case 'BLOCK_FOREVER':
      return 0; // TTL 0 = 영구
    default:
      return 0;
  }
}

export async function runFailureLearning(isPaper = false): Promise<{
  analyzed: number;
  blocked: number;
  updated: number;
}> {
  const mode = isPaper ? 'paper' : 'live';
  logger.info(`🎓 실패 학습 시작 [${mode}]`, { component: COMP });

  let profiles: StockFailureProfile[];
  try {
    profiles = await analyzeStockFailures(isPaper, 30);
  } catch (e) {
    logger.error(`실패 학습 분석 실패: ${(e as Error).message}`, { component: COMP });
    return { analyzed: 0, blocked: 0, updated: 0 };
  }

  const toBlock = profiles.filter((p) => p.recommendation.startsWith('BLOCK_'));
  let blocked = 0;
  for (const p of toBlock) {
    try {
      // ai_overrides에 stock_blacklist 형식 (예: stock_005930_block = true)
      await setOverride(
        'stock',
        `block_${p.stockCode}`,
        true,
        `${REASON_PREFIX}${p.reason}`,
        ttlMinutesFor(p.recommendation),
        isPaper,
      );
      blocked++;
      logger.warn(`🚫 [${mode}] ${p.stockCode}: ${p.reason}`, { component: COMP });
    } catch (e) {
      logger.warn(`${p.stockCode} 블랙리스트 적용 실패: ${(e as Error).message}`, { component: COMP });
    }
  }

  // 학습 결과 영구 적재 — failure_patterns 테이블
  try {
    for (const p of profiles) {
      await getPool().query(
        `INSERT INTO failure_patterns
           (stock_code, mode, analyzed_at, total_trades, win_rate, worst_loss_pct,
            consecutive_losses, recommendation, reason, close_reasons)
         VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (stock_code, mode) DO UPDATE SET
           analyzed_at = NOW(),
           total_trades = $3,
           win_rate = $4,
           worst_loss_pct = $5,
           consecutive_losses = $6,
           recommendation = $7,
           reason = $8,
           close_reasons = $9::jsonb`,
        [
          p.stockCode,
          mode,
          p.totalTrades,
          p.winRate,
          p.worstLoss,
          p.consecutiveLosses,
          p.recommendation,
          p.reason,
          JSON.stringify(p.closeReasons),
        ],
      );
    }
  } catch (e) {
    logger.debug(`failure_patterns 적재 실패 (테이블 미생성?): ${(e as Error).message}`, { component: COMP });
  }

  // Telegram 알림
  if (toBlock.length > 0) {
    const summary = toBlock
      .slice(0, 5)
      .map((p) => `  ${p.recommendation} ${p.stockCode}: ${p.reason}`)
      .join('\n');
    sendTelegramMessage(
      `🎓 *자동 실패 학습 결과* [${mode === 'paper' ? '연습' : '실전'}]\n` +
        `분석: ${profiles.length}종목 / 차단: ${toBlock.length}종목\n\n${summary}` +
        (toBlock.length > 5 ? `\n  외 ${toBlock.length - 5}건...` : ''),
    ).catch(() => {});
  }

  logger.info(`🎓 실패 학습 완료 [${mode}]: ${profiles.length}종목 분석, ${blocked}종목 차단`, {
    component: COMP,
  });
  return { analyzed: profiles.length, blocked, updated: profiles.length };
}

/** paper + live 모두 분석 */
export async function runFailureLearningBoth(): Promise<void> {
  const { runWithMode } = await import('../config/context.js');
  await runWithMode(false, () => runFailureLearning(false)).catch((e) =>
    logger.error(`실패 학습 live: ${e}`, { component: COMP }),
  );
  await runWithMode(true, () => runFailureLearning(true)).catch((e) =>
    logger.error(`실패 학습 paper: ${e}`, { component: COMP }),
  );
}
