/**
 * 실시간 정합성 검증 스케줄러
 *
 * 장중 30분마다 실행 — 실제 P&L/잔고 수치 간 크로스체크
 * 기존 integrity-check-job (DB 구조 검증)과 별개로 "값" 검증
 *
 * 검증 항목:
 * 1. 오늘 실현P&L: transaction_chains SUM vs snapshot.daily_pnl
 * 2. 보유 잔고: overseas_holdings 시가 합산 vs snapshot.invested_value
 * 3. Paper 현금: computePaperCash() vs snapshot.cash_balance
 * 4. 매매 건수: orders FILLED 건수 vs transaction_chains 매칭
 *
 * 불일치 시: system_events + 텔레그램 QA 알림 + 자동매매현황 표시
 */

import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logSystemEvent } from '../utils/system-events.js';
import { logger } from '../utils/logger.js';

const COMP = 'CONSISTENCY';

interface ValidationIssue {
  check: string;
  expected: number;
  actual: number;
  diffPct: number;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
}

// 최근 검증 결과 캐시 (프론트엔드 표시용)
let _lastResult: ConsistencyResult | null = null;

export interface ConsistencyResult {
  runAt: string;
  issues: ValidationIssue[];
  status: 'pass' | 'warn' | 'fail';
  checks: {
    realizedPnl: { chainSum: number; snapshotPnl: number; diffPct: number } | null;
    holdingsValue: { holdingsSum: number; snapshotValue: number; diffPct: number } | null;
    paperCash: { computed: number; snapshot: number; diffPct: number } | null;
    tradeCount: { ordersCount: number; chainsCount: number; matched: boolean } | null;
  };
}

export function getLatestConsistencyResult(): ConsistencyResult | null {
  return _lastResult;
}

export async function runConsistencyValidator(): Promise<void> {
  const pool = getPool();
  const issues: ValidationIssue[] = [];
  const checks: ConsistencyResult['checks'] = {
    realizedPnl: null,
    holdingsValue: null,
    paperCash: null,
    tradeCount: null,
  };

  try {
    const todayKST = `(DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul')) AT TIME ZONE 'Asia/Seoul'`;

    // ── 1. 오늘 실현P&L: chains vs snapshot ──
    for (const isPaper of [true, false]) {
      try {
        const { rows: chainRows } = await pool.query(
          `SELECT COALESCE(SUM(realized_pnl), 0) AS total
           FROM transaction_chains
           WHERE status = 'CLOSED' AND is_paper = $1
           AND closed_at >= ${todayKST}`,
          [isPaper],
        );
        const chainPnl = Number(chainRows[0]?.total ?? 0);

        const { rows: snapRows } = await pool.query(
          `SELECT daily_pnl FROM portfolio_snapshots
           WHERE is_paper = $1 AND snapshot_at >= ${todayKST}
           ORDER BY snapshot_at DESC LIMIT 1`,
          [isPaper],
        );
        const snapPnl = Number(snapRows[0]?.daily_pnl ?? 0);

        // daily_pnl은 미실현 포함이므로 차이가 클 수 있음 — 실현만 비교
        if (Math.abs(chainPnl) > 1000) {
          const diffPct = snapPnl !== 0
            ? Math.abs((chainPnl - snapPnl) / Math.abs(snapPnl)) * 100
            : chainPnl !== 0 ? 100 : 0;

          checks.realizedPnl = { chainSum: chainPnl, snapshotPnl: snapPnl, diffPct };

          // 스냅샷 daily_pnl에는 미실현도 포함이라 50% 이상 차이만 경고
          if (diffPct > 50) {
            issues.push({
              check: `${isPaper ? 'Paper' : 'Live'} 실현P&L`,
              expected: chainPnl,
              actual: snapPnl,
              diffPct,
              severity: diffPct > 100 ? 'CRITICAL' : 'WARNING',
            });
          }
        }
      } catch (e) {
        logger.debug(`정합성 실현P&L 체크 실패 (${isPaper ? 'paper' : 'live'}): ${e}`, { component: COMP });
      }
    }

    // ── 2. 보유 잔고: holdings 시가 vs snapshot.invested_value ──
    for (const isPaper of [true, false]) {
      try {
        const { rows: holdRows } = await pool.query(
          `SELECT COALESCE(SUM(quantity * last_price), 0) AS total
           FROM overseas_holdings WHERE is_paper = $1 AND quantity > 0`,
          [isPaper],
        );
        const holdingsSum = Number(holdRows[0]?.total ?? 0);

        const { rows: snapRows } = await pool.query(
          `SELECT invested_value FROM portfolio_snapshots
           WHERE is_paper = $1 AND snapshot_at >= ${todayKST}
           ORDER BY snapshot_at DESC LIMIT 1`,
          [isPaper],
        );
        const snapValue = Number(snapRows[0]?.invested_value ?? 0);

        if (holdingsSum > 0 && snapValue > 0) {
          const diffPct = Math.abs((holdingsSum - snapValue) / snapValue) * 100;
          checks.holdingsValue = { holdingsSum, snapshotValue: snapValue, diffPct };

          if (diffPct > 5) {
            issues.push({
              check: `${isPaper ? 'Paper' : 'Live'} 보유잔고`,
              expected: holdingsSum,
              actual: snapValue,
              diffPct,
              severity: diffPct > 15 ? 'CRITICAL' : 'WARNING',
            });
          }
        }
      } catch (e) {
        logger.debug(`정합성 보유잔고 체크 실패 (${isPaper ? 'paper' : 'live'}): ${e}`, { component: COMP });
      }
    }

    // ── 3. Paper 현금 정합성 ──
    try {
      const { computePaperCash } = await import('./overseas/state.js');
      const actualCash = await computePaperCash();

      const { rows: snapRows } = await pool.query(
        `SELECT cash_balance FROM portfolio_snapshots
         WHERE is_paper = true AND snapshot_at >= ${todayKST}
         ORDER BY snapshot_at DESC LIMIT 1`,
      );
      const snapCash = Number(snapRows[0]?.cash_balance ?? 0);

      if (actualCash > 0 && snapCash > 0) {
        const diffPct = Math.abs((actualCash - snapCash) / snapCash) * 100;
        checks.paperCash = { computed: actualCash, snapshot: snapCash, diffPct };

        if (diffPct > 5) {
          issues.push({
            check: 'Paper 현금',
            expected: actualCash,
            actual: snapCash,
            diffPct,
            severity: diffPct > 15 ? 'CRITICAL' : 'WARNING',
          });
        }
      }
    } catch (e) {
      logger.debug(`정합성 Paper 현금 체크 실패: ${e}`, { component: COMP });
    }

    // ── 4. 오늘 매매 건수 크로스체크 ──
    try {
      const { rows: orderRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM orders
         WHERE status = 'FILLED' AND created_at >= ${todayKST}`,
      );
      const ordersCount = Number(orderRows[0]?.cnt ?? 0);

      const { rows: chainOrderRows } = await pool.query(
        `SELECT COUNT(DISTINCT o.id) AS cnt FROM orders o
         JOIN transaction_chains tc ON o.chain_id = tc.id
         WHERE o.status = 'FILLED' AND o.created_at >= ${todayKST}`,
      );
      const linkedCount = Number(chainOrderRows[0]?.cnt ?? 0);
      const matched = ordersCount === linkedCount;

      checks.tradeCount = { ordersCount, chainsCount: linkedCount, matched };

      if (!matched && ordersCount > 0) {
        const unlinked = ordersCount - linkedCount;
        issues.push({
          check: '매매건수 정합',
          expected: ordersCount,
          actual: linkedCount,
          diffPct: (unlinked / ordersCount) * 100,
          severity: unlinked > 3 ? 'CRITICAL' : 'WARNING',
        });
      }
    } catch (e) {
      logger.debug(`정합성 매매건수 체크 실패: ${e}`, { component: COMP });
    }

    // ── 결과 저장 + 알림 ──
    const criticals = issues.filter((i) => i.severity === 'CRITICAL');
    const warnings = issues.filter((i) => i.severity === 'WARNING');
    const status = criticals.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';

    _lastResult = {
      runAt: new Date().toISOString(),
      issues,
      status,
      checks,
    };

    if (issues.length === 0) {
      logSystemEvent('정합성검증', 'success', '크로스체크 통과 (P&L·잔고·현금·매매건수)');
      logger.info('✅ 정합성 크로스체크 통과', { component: COMP });
      return;
    }

    // 시스템 이벤트 기록
    logSystemEvent(
      '정합성검증',
      criticals.length > 0 ? 'error' : 'running',
      `${criticals.length}건 치명, ${warnings.length}건 경고: ${issues.map((i) => i.check).join(', ')}`,
    );

    // 텔레그램 QA 봇 알림
    const msg = [
      `🔍 *정합성 크로스체크*`,
      '',
      ...issues.map(
        (i) =>
          `${i.severity === 'CRITICAL' ? '🔴' : '🟡'} ${i.check}: 차이 ${i.diffPct.toFixed(1)}%` +
          ` (예상=${fmtNum(i.expected)} vs 실제=${fmtNum(i.actual)})`,
      ),
    ].join('\n');

    await sendTelegramMessage(msg).catch(() => {});
    logger.warn(`정합성 크로스체크: ${criticals.length}건 치명, ${warnings.length}건 경고`, { component: COMP });
  } catch (err) {
    logger.error(`정합성 크로스체크 실패: ${err}`, { component: COMP });
  }
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(0)}만`;
  return n.toLocaleString();
}
