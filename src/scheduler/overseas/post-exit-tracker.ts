/**
 * Post-Exit Tracker — 매도 후 가격 추적
 *
 * 최근 7일 해외 SELL 주문 → 현재가 조회 → 잔여수익 계산 → 집계
 * 트레일링 스탑 파라미터 튜닝에 핵심 피드백 제공
 */
import { getPool } from '../../db/client.js';
import { getOverseasPrice } from '../../kis/overseas.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { parseCloseReason, CLOSE_REASON_KR } from '../../automation/self-learning/overseas-analyzers.js';
import { WATCHLIST_BY_CODE } from './watchlist.js';
import { getOverseasState, setOverseasState } from './utils.js';

// ── Types ──

interface PostExitRecord {
  stockCode: string;
  exchange: string;
  exitPrice: number;
  currentPrice: number;
  missedGainPct: number;
  daysSinceExit: number;
  closeReason: string;
  exitPnlPct: number;
}

type TimeBucket = '1d' | '2-3d' | '4-5d' | '6-7d';

interface PostExitStats {
  totalExits: number;
  records: PostExitRecord[];
  byTimeBucket: Array<{
    bucket: TimeBucket;
    count: number;
    avgMissedGainPct: number;
    positiveRate: number;
  }>;
  byCloseReason: Array<{
    closeReason: string;
    count: number;
    avgMissedGainPct: number;
    positiveRate: number;
  }>;
  overallAvgMissedGainPct: number;
  overallPositiveRate: number;
  trailingStopMissedAvg: number;
  apiErrors: number;
  analyzedAt: string;
}

// ── Helpers ──

function getTimeBucket(days: number): TimeBucket {
  if (days <= 1) return '1d';
  if (days <= 3) return '2-3d';
  if (days <= 5) return '4-5d';
  return '6-7d';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──

export async function runPostExitTracker(isPaper: boolean): Promise<PostExitStats | null> {
  const mode = isPaper ? 'paper' : 'live';
  logger.info(`📊 Post-Exit Tracker 시작 (${mode})`, { component: 'POST_EXIT' });

  try {
    // 1. 최근 7일 해외 SELL 주문 쿼리
    const { rows } = await getPool().query(
      `SELECT stock_code, filled_price, avg_buy_price, ai_reasoning, created_at
       FROM orders
       WHERE trigger_source = 'OVERSEAS' AND side = 'SELL' AND status = 'FILLED'
         AND filled_price > 0 AND avg_buy_price > 0
         AND created_at >= NOW() - INTERVAL '7 days'
         AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
       ORDER BY created_at DESC`,
      [isPaper ? 'paper' : 'live'],
    );

    if (rows.length === 0) {
      logger.info(`⏭️ Post-Exit Tracker 스킵 — 최근 7일 매도 없음 (${mode})`, { component: 'POST_EXIT' });
      return null;
    }

    // 2. 종목별 현재가 조회 (배치 4개씩, 200ms 간격)
    const records: PostExitRecord[] = [];
    let apiErrors = 0;
    const uniqueCodes = [...new Set(rows.map((r: any) => String(r.stock_code)))];

    for (let i = 0; i < uniqueCodes.length; i += 4) {
      const batch = uniqueCodes.slice(i, i + 4);
      const priceResults = await Promise.allSettled(
        batch.map((code) => {
          const exchange = WATCHLIST_BY_CODE.get(code)?.exchange ?? 'NASDAQ';
          return getOverseasPrice(code, exchange);
        }),
      );

      const priceMap = new Map<string, number>();
      for (let j = 0; j < batch.length; j++) {
        const result = priceResults[j];
        if (result.status === 'fulfilled' && result.value.currentPrice > 0) {
          priceMap.set(batch[j], result.value.currentPrice);
        } else {
          apiErrors++;
        }
      }

      // 매칭: 같은 종목 여러 매도 가능
      for (const row of rows) {
        const code = String(row.stock_code);
        if (!batch.includes(code)) continue;
        const currentPrice = priceMap.get(code);
        if (!currentPrice) continue;

        const exitPrice = Number(row.filled_price);
        const avgBuyPrice = Number(row.avg_buy_price);
        const missedGainPct = ((currentPrice - exitPrice) / exitPrice) * 100;
        const exitPnlPct = avgBuyPrice > 0 ? ((exitPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
        const daysSinceExit = Math.max(
          0,
          (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24),
        );
        const closeReason = parseCloseReason(String(row.ai_reasoning ?? ''));

        records.push({
          stockCode: code,
          exchange: WATCHLIST_BY_CODE.get(code)?.exchange ?? 'NASDAQ',
          exitPrice,
          currentPrice,
          missedGainPct,
          daysSinceExit,
          closeReason,
          exitPnlPct,
        });
      }

      if (i + 4 < uniqueCodes.length) await sleep(200);
    }

    if (records.length === 0) {
      logger.info(`⏭️ Post-Exit Tracker — 가격 조회 실패로 분석 불가 (${mode})`, { component: 'POST_EXIT' });
      return null;
    }

    // 3. 시간대별 집계
    const bucketOrder: TimeBucket[] = ['1d', '2-3d', '4-5d', '6-7d'];
    const bucketMap = new Map<TimeBucket, { sum: number; positives: number; count: number }>();
    for (const b of bucketOrder) bucketMap.set(b, { sum: 0, positives: 0, count: 0 });

    for (const r of records) {
      const bucket = getTimeBucket(r.daysSinceExit);
      const stat = bucketMap.get(bucket)!;
      stat.sum += r.missedGainPct;
      stat.count++;
      if (r.missedGainPct > 0) stat.positives++;
    }

    const byTimeBucket = bucketOrder
      .map((bucket) => {
        const s = bucketMap.get(bucket)!;
        return {
          bucket,
          count: s.count,
          avgMissedGainPct: s.count > 0 ? s.sum / s.count : 0,
          positiveRate: s.count > 0 ? s.positives / s.count : 0,
        };
      })
      .filter((b) => b.count > 0);

    // 4. 매도사유별 집계
    const reasonMap = new Map<string, { sum: number; positives: number; count: number }>();
    for (const r of records) {
      const stat = reasonMap.get(r.closeReason) ?? { sum: 0, positives: 0, count: 0 };
      stat.sum += r.missedGainPct;
      stat.count++;
      if (r.missedGainPct > 0) stat.positives++;
      reasonMap.set(r.closeReason, stat);
    }

    const byCloseReason = [...reasonMap.entries()]
      .map(([closeReason, s]) => ({
        closeReason,
        count: s.count,
        avgMissedGainPct: s.count > 0 ? s.sum / s.count : 0,
        positiveRate: s.count > 0 ? s.positives / s.count : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // 5. 전체 통계
    const overallSum = records.reduce((s, r) => s + r.missedGainPct, 0);
    const overallPositives = records.filter((r) => r.missedGainPct > 0).length;
    const trailingRecords = records.filter((r) => r.closeReason === 'TRAILING_STOP');
    const trailingStopMissedAvg =
      trailingRecords.length > 0
        ? trailingRecords.reduce((s, r) => s + r.missedGainPct, 0) / trailingRecords.length
        : 0;

    const stats: PostExitStats = {
      totalExits: records.length,
      records,
      byTimeBucket,
      byCloseReason,
      overallAvgMissedGainPct: overallSum / records.length,
      overallPositiveRate: overallPositives / records.length,
      trailingStopMissedAvg,
      apiErrors,
      analyzedAt: new Date().toISOString(),
    };

    // 6. overseas_state 저장
    const stateKey = isPaper ? 'post_exit_stats_paper' : 'post_exit_stats_live';
    await setOverseasState(stateKey, JSON.stringify(stats));

    // 7. 텔레그램 리포트
    const report = formatPostExitReport(stats, mode);
    logger.info(report, { component: 'POST_EXIT' });
    await sendTelegramMessage(report).catch(() => {});

    return stats;
  } catch (e: any) {
    logger.error(`Post-Exit Tracker 실패: ${e.message}`, { component: 'POST_EXIT' });
    return null;
  }
}

// ── 리포트 포맷 ──

function formatPostExitReport(stats: PostExitStats, mode: string): string {
  const rising = stats.records.filter((r) => r.missedGainPct > 0);
  const falling = stats.records.filter((r) => r.missedGainPct <= 0);

  const lines = [
    `📊 매도 후 추적 (${mode}) | ${stats.totalExits}건 분석`,
    '',
  ];

  // 상승/하락 요약
  if (rising.length > 0) {
    const avgRising = rising.reduce((s, r) => s + r.missedGainPct, 0) / rising.length;
    lines.push(`📈 계속 상승: ${rising.length}건 (${((rising.length / stats.totalExits) * 100).toFixed(0)}%) 평균 +${avgRising.toFixed(1)}%`);
  }
  if (falling.length > 0) {
    const avgFalling = falling.reduce((s, r) => s + r.missedGainPct, 0) / falling.length;
    lines.push(`📉 하락: ${falling.length}건 (${((falling.length / stats.totalExits) * 100).toFixed(0)}%) 평균 ${avgFalling.toFixed(1)}%`);
  }
  lines.push(`전체 평균: ${stats.overallAvgMissedGainPct >= 0 ? '+' : ''}${stats.overallAvgMissedGainPct.toFixed(1)}%`);

  // 시간대별
  if (stats.byTimeBucket.length > 0) {
    lines.push('', '⏰ 시간대별:');
    const bucketParts = stats.byTimeBucket.map(
      (b) => `  ${b.bucket}: ${b.avgMissedGainPct >= 0 ? '+' : ''}${b.avgMissedGainPct.toFixed(1)}% (${b.count}건)`,
    );
    lines.push(...bucketParts);
  }

  // 매도사유별
  if (stats.byCloseReason.length > 0) {
    lines.push('', '🏷️ 매도사유별:');
    for (const cr of stats.byCloseReason) {
      const krName = CLOSE_REASON_KR[cr.closeReason] ?? cr.closeReason;
      const hint =
        cr.closeReason === 'TRAILING_STOP' && cr.avgMissedGainPct > 1.5
          ? ' ← 조기매도 의심'
          : cr.closeReason === 'STOP_LOSS' && cr.avgMissedGainPct < 0
            ? ' ← 적절'
            : '';
      lines.push(
        `  ${krName}: ${cr.avgMissedGainPct >= 0 ? '+' : ''}${cr.avgMissedGainPct.toFixed(1)}% (${cr.count}건)${hint}`,
      );
    }
  }

  if (stats.apiErrors > 0) {
    lines.push(`\n⚠️ API 오류: ${stats.apiErrors}건`);
  }

  return lines.join('\n');
}
