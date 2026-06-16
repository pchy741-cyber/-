/**
 * 데이터 정합성 자동 체크 — DB 쿼리만 사용 (외부 API 호출 0, 추가 비용 0)
 *
 * 검증 항목:
 * 1. 체인 vs 주문 수량 불일치
 * 2. 고아 체인 (주문 없는 OPEN 체인)
 * 3. 고아 주문 (체인 없는 FILLED 주문)
 * 4. is_paper vs trading_mode 교차 불일치
 * 5. 비정상 손익률 (±50% 이상)
 * 6. PENDING 주문 장기 미체결 (2시간+)
 * 7. 중복 체인 (같은 종목 OPEN 2개 이상)
 */

import { logSystemEvent } from '../api/routes/health.js';
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

const COMPONENT = 'INTEGRITY';

interface Issue {
  severity: '🔴' | '🟡';
  message: string;
}

export async function runIntegrityCheck(): Promise<void> {
  const pool = getPool();
  const issues: Issue[] = [];

  try {
    // 1. OPEN 체인의 DB 수량 vs 실제 FILLED BUY-SELL 수량 비교
    const { rows: chainQtyMismatch } = await pool.query(`
      SELECT tc.id, tc.stock_code, tc.total_quantity AS chain_qty,
             COALESCE(SUM(CASE WHEN o.side='BUY' THEN o.filled_quantity ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN o.side='SELL' THEN o.filled_quantity ELSE 0 END), 0) AS order_qty
      FROM transaction_chains tc
      LEFT JOIN orders o ON o.chain_id = tc.id AND o.status = 'FILLED'
      WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      GROUP BY tc.id, tc.stock_code, tc.total_quantity
      HAVING tc.total_quantity != COALESCE(SUM(CASE WHEN o.side='BUY' THEN o.filled_quantity ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN o.side='SELL' THEN o.filled_quantity ELSE 0 END), 0)
    `);
    for (const r of chainQtyMismatch) {
      issues.push({
        severity: '🔴',
        message: `수량 불일치: ${r.stock_code} 체인=${r.chain_qty}주 vs 주문합산=${r.order_qty}주 (chain ${r.id.slice(0, 8)})`,
      });
    }

    // 2. 고아 체인 — OPEN인데 FILLED 주문이 0건 (5분 이상 경과한 체인만 — 신규 체인 오탐 방지)
    const { rows: orphanChains } = await pool.query(`
      SELECT tc.id, tc.stock_code, tc.total_quantity
      FROM transaction_chains tc
      WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
        AND tc.opened_at < NOW() - INTERVAL '5 minutes'
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.chain_id = tc.id AND o.status = 'FILLED')
    `);
    for (const r of orphanChains) {
      issues.push({
        severity: '🔴',
        message: `고아 체인: ${r.stock_code} ${r.total_quantity}주 (주문 없음, chain ${r.id.slice(0, 8)})`,
      });
    }

    // 3. 고아 주문 — FILLED인데 chain_id 없음 (최근 24시간)
    const { rows: orphanOrders } = await pool.query(`
      SELECT id, stock_code, side, filled_quantity, filled_price, trading_mode
      FROM orders
      WHERE status = 'FILLED' AND chain_id IS NULL
        AND created_at >= NOW() - INTERVAL '24 hours'
    `);
    if (orphanOrders.length > 0) {
      issues.push({
        severity: '🟡',
        message: `고아 주문 ${orphanOrders.length}건 (chain 미연결, 최근 24h): ${orphanOrders
          .slice(0, 3)
          .map((o) => `${o.stock_code} ${o.side}`)
          .join(', ')}`,
      });
    }

    // 4. is_paper vs trading_mode 교차 불일치 — 체인은 live인데 주문은 paper (또는 반대)
    const { rows: modeMismatch } = await pool.query(`
      SELECT DISTINCT tc.id, tc.stock_code, tc.is_paper AS chain_paper, o.trading_mode
      FROM transaction_chains tc
      JOIN orders o ON o.chain_id = tc.id AND o.status = 'FILLED'
      WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
        AND ((tc.is_paper = true AND o.trading_mode = 'live')
          OR (tc.is_paper = false AND o.trading_mode = 'paper'))
    `);
    for (const r of modeMismatch) {
      issues.push({
        severity: '🔴',
        message: `모드 불일치: ${r.stock_code} 체인=${r.chain_paper ? 'PAPER' : 'LIVE'} vs 주문=${r.trading_mode} (chain ${r.id.slice(0, 8)})`,
      });
    }

    // 5. 비정상 손익률 — CLOSED 체인 중 ±50% 이상 (최근 7일)
    const { rows: abnormalPnl } = await pool.query(`
      SELECT stock_code, realized_pnl, total_invested,
             CASE WHEN total_invested > 0 THEN (realized_pnl / total_invested * 100) ELSE 0 END AS pnl_pct
      FROM transaction_chains
      WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '7 days'
        AND total_invested > 0
        AND ABS(realized_pnl / total_invested * 100) > 50
    `);
    for (const r of abnormalPnl) {
      issues.push({
        severity: '🟡',
        message: `비정상 손익: ${r.stock_code} ${Number(r.pnl_pct).toFixed(1)}% (투자 ${Number(r.total_invested).toLocaleString()}원)`,
      });
    }

    // 6. PENDING 주문 장기 미체결 (2시간+)
    const { rows: stuckOrders } = await pool.query(`
      SELECT id, stock_code, side, quantity, created_at
      FROM orders
      WHERE status = 'PENDING'
        AND created_at < NOW() - INTERVAL '2 hours'
    `);
    if (stuckOrders.length > 0) {
      issues.push({
        severity: '🟡',
        message: `미체결 ${stuckOrders.length}건 (2h+): ${stuckOrders.map((o) => `${o.stock_code} ${o.side} ${o.quantity}주`).join(', ')}`,
      });
    }

    // 7. 중복 체인 — 같은 종목 + 같은 모드에서 OPEN 2개 이상
    const { rows: dupChains } = await pool.query(`
      SELECT stock_code, is_paper, COUNT(*) AS cnt
      FROM transaction_chains
      WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      GROUP BY stock_code, is_paper
      HAVING COUNT(*) > 1
    `);
    for (const r of dupChains) {
      issues.push({
        severity: '🔴',
        message: `중복 체인: ${r.stock_code} (${r.is_paper ? 'PAPER' : 'LIVE'}) ${r.cnt}개 동시 OPEN`,
      });
    }

    // ── 결과 보고 ──
    if (issues.length === 0) {
      logSystemEvent('정합성', 'success', '데이터 정합성 체크 통과');
      logger.info('✅ 데이터 정합성 체크 통과 (이상 없음)', { component: COMPONENT });
      return;
    }

    const critical = issues.filter((i) => i.severity === '🔴');
    const warning = issues.filter((i) => i.severity === '🟡');

    let msg = `🔍 *데이터 정합성 체크*\n`;
    if (critical.length > 0) {
      msg += `\n*치명적 (${critical.length}건):*\n`;
      msg += critical.map((i) => `${i.severity} ${i.message}`).join('\n');
    }
    if (warning.length > 0) {
      msg += `\n\n*경고 (${warning.length}건):*\n`;
      msg += warning.map((i) => `${i.severity} ${i.message}`).join('\n');
    }

    logSystemEvent(
      '정합성',
      critical.length > 0 ? 'error' : 'running',
      `${critical.length}건 치명, ${warning.length}건 경고`,
    );
    await sendTelegramMessage(msg).catch(() => {});
    logger.warn(`정합성 체크: ${critical.length}건 치명, ${warning.length}건 경고`, { component: COMPONENT });
  } catch (err) {
    logger.error(`정합성 체크 실패: ${err}`, { component: COMPONENT });
  }
}
