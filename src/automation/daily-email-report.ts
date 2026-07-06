/**
 * 17시 종합 이메일 리포트 — HTML 포맷
 *
 * 매일 17:00 KST (평일) 자동 발송:
 * 1. 자산 현황 (paper + live)
 * 2. 오늘 매매 (매수/매도 건수, 체결 목록)
 * 3. 보유 종목 (현재가, 수익률, 평단가)
 * 4. 주간/월간 성과 (누적 PnL, 승률)
 * 5. AI 비용 (오늘/월 비용, 모델별)
 * 6. 정합성 체크 (치명/경고 이슈)
 * 7. 시스템 이벤트 (에러/경고 요약)
 */

import { getOpenChains, getPool } from '../db/client.js';
import { safeQuery } from '../db/pool.js';
import { getAccountBalance } from '../kis/account.js';
import { escapeHtml, sendEmail } from '../notifications/email.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { runWithMode } from '../config/context.js';
import { paperOnly } from '../config/index.js';

const COMPONENT = 'EMAIL_REPORT';

export async function sendDailyEmailReport(): Promise<void> {
  try {
    const today = getKSTNow().toISOString().split('T')[0];
    const weekStart = getWeekStart(today);
    const monthStart = `${today.slice(0, 7)}-01`;

    // paper + live 데이터 수집
    const [paperData, liveData] = await Promise.all([
      collectModeData(true, today, weekStart, monthStart),
      paperOnly ? null : collectModeData(false, today, weekStart, monthStart),
    ]);

    // AI 비용
    const aiCost = await collectAiCost(today, monthStart);

    // 정합성 체크
    const integrityIssues = await runIntegrityCheck();

    // 시스템 이벤트
    const systemEvents = await collectSystemEvents(today);

    // HTML 생성
    const html = buildHtml({
      today,
      paperData,
      liveData,
      aiCost,
      integrityIssues,
      systemEvents,
    });

    const pnlEmoji = (liveData?.realizedPnl ?? paperData.realizedPnl) >= 0 ? '📈' : '📉';
    await sendEmail({
      subject: `${pnlEmoji} [AI매매] ${today} 종합 리포트`,
      html,
    });

    logger.info('📧 종합 이메일 리포트 발송 완료', { component: COMPONENT });
  } catch (err) {
    logger.error(`📧 이메일 리포트 실패: ${err}`, { component: COMPONENT });
  }
}

// ── 데이터 수집 ──

interface ModeData {
  mode: string;
  totalAsset: number;
  cash: number;
  investedAmount: number;
  unrealizedPnl: number;
  realizedPnl: number;
  positions: Array<{
    name: string;
    code: string;
    qty: number;
    avgPrice: number;
    curPrice: number;
    pnl: number;
    pnlPct: number;
  }>;
  buyCount: number;
  sellCount: number;
  closedCount: number;
  todayOrders: Array<Record<string, unknown>>;
  weekPnl: number;
  weekWins: number;
  weekLosses: number;
  monthPnl: number;
  monthWins: number;
  monthLosses: number;
  openChains: number;
}

async function collectModeData(
  isPaper: boolean,
  today: string,
  weekStart: string,
  monthStart: string,
): Promise<ModeData> {
  return runWithMode(isPaper, async () => {
    const balance = isPaper
      ? await (await import('../risk/engine.js')).getPaperBalance()
      : await getAccountBalance(true);
    const chains = await getOpenChains(isPaper);
    const pool = getPool();

    const [{ rows: todayOrders }, { rows: closedToday }, { rows: weekData }, { rows: monthData }] =
      await Promise.all([
        pool.query(
          `SELECT * FROM orders WHERE created_at >= $1 AND status = 'FILLED' AND is_paper = $2
           AND (trading_mode = $3::text OR ($3::text = 'paper' AND trading_mode = 'p_arch'))
           ORDER BY created_at ASC`,
          [`${today}T00:00:00+09:00`, isPaper, isPaper ? 'paper' : 'live'],
        ),
        pool.query(
          `SELECT * FROM transaction_chains WHERE status = 'CLOSED' AND closed_at >= $1 AND is_paper = $2`,
          [`${today}T00:00:00+09:00`, isPaper],
        ),
        pool.query(
          `SELECT realized_pnl FROM transaction_chains WHERE status = 'CLOSED' AND closed_at >= $1 AND is_paper = $2`,
          [`${weekStart}T00:00:00+09:00`, isPaper],
        ),
        pool.query(
          `SELECT realized_pnl FROM transaction_chains WHERE status = 'CLOSED' AND closed_at >= $1 AND is_paper = $2`,
          [`${monthStart}T00:00:00+09:00`, isPaper],
        ),
      ]);

    const buyOrders = todayOrders.filter((o: Record<string, unknown>) => o.side === 'BUY');
    const sellOrders = todayOrders.filter((o: Record<string, unknown>) => o.side === 'SELL');
    const realizedPnl = closedToday.reduce(
      (sum: number, c: Record<string, unknown>) => sum + Number(c.realized_pnl ?? 0),
      0,
    );
    const weekPnl = weekData.reduce(
      (s: number, c: Record<string, unknown>) => s + Number(c.realized_pnl ?? 0),
      0,
    );
    const weekWins = weekData.filter((c: Record<string, unknown>) => Number(c.realized_pnl) > 0).length;
    const weekLosses = weekData.filter((c: Record<string, unknown>) => Number(c.realized_pnl) <= 0).length;
    const monthPnl = monthData.reduce(
      (s: number, c: Record<string, unknown>) => s + Number(c.realized_pnl ?? 0),
      0,
    );
    const monthWins = monthData.filter((c: Record<string, unknown>) => Number(c.realized_pnl) > 0).length;
    const monthLosses = monthData.filter(
      (c: Record<string, unknown>) => Number(c.realized_pnl) <= 0,
    ).length;

    return {
      mode: isPaper ? '연습' : '실전',
      totalAsset: balance.orderableCash + balance.totalEvalAmount,
      cash: balance.orderableCash,
      investedAmount: balance.totalEvalAmount,
      // Paper 모드: totalProfitLoss는 누적 실현PnL → 미실현은 포지션에서 계산
      unrealizedPnl: balance.positions.reduce((sum, p) => sum + p.profitLoss, 0),
      realizedPnl,
      positions: balance.positions.map((p) => ({
        name: p.stockName,
        code: p.stockCode,
        qty: p.quantity,
        avgPrice: p.avgBuyPrice,
        curPrice: p.currentPrice,
        pnl: p.profitLoss,
        pnlPct: p.profitLossPct,
      })),
      buyCount: buyOrders.length,
      sellCount: sellOrders.length,
      closedCount: closedToday.length,
      todayOrders,
      weekPnl,
      weekWins,
      weekLosses,
      monthPnl,
      monthWins,
      monthLosses,
      openChains: chains.length,
    };
  });
}

interface AiCost {
  todayCost: number;
  monthCost: number;
  byModel: Array<{ model: string; cost: number; tokens: number }>;
}

async function collectAiCost(today: string, monthStart: string): Promise<AiCost> {
  try {
    const [{ rows: todayRows }, { rows: monthRows }, { rows: modelRows }] = await Promise.all([
      safeQuery<{ total_cost: string }>(
        `SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM ai_token_usage WHERE created_at >= $1`,
        [`${today}T00:00:00+09:00`],
      ),
      safeQuery<{ total_cost: string }>(
        `SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM ai_token_usage WHERE created_at >= $1`,
        [`${monthStart}T00:00:00+09:00`],
      ),
      safeQuery<{ model: string; total_cost: string; total_tokens: string }>(
        `SELECT model, COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens
         FROM ai_token_usage WHERE created_at >= $1 GROUP BY model ORDER BY total_cost DESC`,
        [`${today}T00:00:00+09:00`],
      ),
    ]);

    return {
      todayCost: Number(todayRows[0]?.total_cost ?? 0),
      monthCost: Number(monthRows[0]?.total_cost ?? 0),
      byModel: modelRows.map((r) => ({
        model: r.model,
        cost: Number(r.total_cost),
        tokens: Number(r.total_tokens),
      })),
    };
  } catch {
    return { todayCost: 0, monthCost: 0, byModel: [] };
  }
}

interface IntegrityIssue {
  severity: 'critical' | 'warning';
  message: string;
}

async function runIntegrityCheck(): Promise<IntegrityIssue[]> {
  const pool = getPool();
  const issues: IntegrityIssue[] = [];

  try {
    // 체인 vs 주문 수량 불일치 (paper/live 구분)
    const { rows: qtyMismatch } = await pool.query(`
      SELECT tc.stock_code, tc.is_paper, tc.total_quantity AS chain_qty,
             COALESCE(SUM(CASE WHEN o.side='BUY' THEN o.filled_quantity ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN o.side='SELL' THEN o.filled_quantity ELSE 0 END), 0) AS order_qty
      FROM transaction_chains tc
      LEFT JOIN orders o ON o.chain_id = tc.id AND o.status = 'FILLED'
      WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      GROUP BY tc.id, tc.stock_code, tc.is_paper, tc.total_quantity
      HAVING tc.total_quantity != COALESCE(SUM(CASE WHEN o.side='BUY' THEN o.filled_quantity ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN o.side='SELL' THEN o.filled_quantity ELSE 0 END), 0)
    `);
    for (const r of qtyMismatch) {
      const mode = r.is_paper ? 'PAPER' : 'LIVE';
      issues.push({ severity: 'critical', message: `[${mode}] 수량 불일치: ${r.stock_code} 체인=${r.chain_qty}주 vs 주문=${r.order_qty}주` });
    }

    // 고아 체인 (paper/live 구분)
    const { rows: orphanChains } = await pool.query(`
      SELECT tc.stock_code, tc.total_quantity, tc.is_paper
      FROM transaction_chains tc
      WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING')
        AND tc.opened_at < NOW() - INTERVAL '5 minutes'
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.chain_id = tc.id AND o.status = 'FILLED')
    `);
    for (const r of orphanChains) {
      const mode = r.is_paper ? 'PAPER' : 'LIVE';
      issues.push({ severity: 'critical', message: `[${mode}] 고아 체인: ${r.stock_code} ${r.total_quantity}주` });
    }

    // 중복 체인
    const { rows: dupChains } = await pool.query(`
      SELECT stock_code, is_paper, COUNT(*) AS cnt
      FROM transaction_chains WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
      GROUP BY stock_code, is_paper HAVING COUNT(*) > 1
    `);
    for (const r of dupChains) {
      issues.push({ severity: 'critical', message: `중복 체인: ${r.stock_code} (${r.is_paper ? 'PAPER' : 'LIVE'}) ${r.cnt}개` });
    }

    // PENDING 주문 장기 미체결 (live만 — paper 미체결은 흔하므로 제외)
    const { rows: stuckOrders } = await pool.query(`
      SELECT stock_code, side, quantity FROM orders
      WHERE status = 'PENDING' AND is_paper = false AND created_at < NOW() - INTERVAL '2 hours'
    `);
    if (stuckOrders.length > 0) {
      issues.push({
        severity: 'warning',
        message: `[LIVE] 미체결 ${stuckOrders.length}건 (2h+): ${stuckOrders.map((o) => `${o.stock_code} ${o.side}`).join(', ')}`,
      });
    }
  } catch (err) {
    logger.warn(`정합성 체크(이메일) 실패: ${err}`, { component: COMPONENT });
  }

  return issues;
}

async function collectSystemEvents(today: string): Promise<{ errors: number; warnings: number }> {
  try {
    const { rows } = await safeQuery<{ level: string; cnt: string }>(
      `SELECT level, COUNT(*) as cnt FROM system_log
       WHERE timestamp >= $1 AND level IN ('error', 'warn')
       GROUP BY level`,
      [`${today}T00:00:00+09:00`],
    );
    let errors = 0;
    let warnings = 0;
    for (const r of rows) {
      if (r.level === 'error') errors = Number(r.cnt);
      if (r.level === 'warn') warnings = Number(r.cnt);
    }
    return { errors, warnings };
  } catch {
    return { errors: 0, warnings: 0 };
  }
}

// ── HTML 생성 ──

function buildHtml(data: {
  today: string;
  paperData: ModeData;
  liveData: ModeData | null;
  aiCost: AiCost;
  integrityIssues: IntegrityIssue[];
  systemEvents: { errors: number; warnings: number };
}): string {
  const { today, paperData, liveData, aiCost, integrityIssues, systemEvents } = data;

  const renderModeSection = (d: ModeData) => {
    const pnlColor = d.unrealizedPnl >= 0 ? '#22c55e' : '#ef4444';
    const realColor = d.realizedPnl >= 0 ? '#22c55e' : '#ef4444';
    const monthWinRate = (d.monthWins + d.monthLosses) > 0
      ? ((d.monthWins / (d.monthWins + d.monthLosses)) * 100).toFixed(0)
      : '-';

    // 보유 종목 테이블
    let posTable = '<p style="color:#9ca3af;">보유 종목 없음</p>';
    if (d.positions.length > 0) {
      posTable = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
          <tr style="background:#1e293b;color:#e2e8f0;">
            <th style="padding:6px 8px;text-align:left;">종목</th>
            <th style="padding:6px 8px;text-align:right;">수량</th>
            <th style="padding:6px 8px;text-align:right;">평단가</th>
            <th style="padding:6px 8px;text-align:right;">현재가</th>
            <th style="padding:6px 8px;text-align:right;">손익</th>
            <th style="padding:6px 8px;text-align:right;">수익률</th>
          </tr>
          ${d.positions
            .map(
              (p) => `
            <tr style="border-bottom:1px solid #334155;">
              <td style="padding:6px 8px;">${p.name}<br><span style="color:#9ca3af;font-size:11px;">${p.code}</span></td>
              <td style="padding:6px 8px;text-align:right;">${p.qty.toLocaleString()}</td>
              <td style="padding:6px 8px;text-align:right;">${p.avgPrice.toLocaleString()}</td>
              <td style="padding:6px 8px;text-align:right;">${p.curPrice.toLocaleString()}</td>
              <td style="padding:6px 8px;text-align:right;color:${p.pnl >= 0 ? '#22c55e' : '#ef4444'};">${p.pnl >= 0 ? '+' : ''}${p.pnl.toLocaleString()}원</td>
              <td style="padding:6px 8px;text-align:right;color:${p.pnlPct >= 0 ? '#22c55e' : '#ef4444'};">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%</td>
            </tr>`,
            )
            .join('')}
        </table>`;
    }

    // 오늘 매매 내역
    let tradeList = '';
    if (d.todayOrders.length > 0) {
      tradeList = d.todayOrders
        .slice(-10)
        .map((o: Record<string, unknown>) => {
          const side = o.side === 'BUY' ? '🟢 매수' : '🔴 매도';
          const reason = o.ai_reasoning ? escapeHtml(String(o.ai_reasoning).slice(0, 60)) : '';
          return `<div style="padding:4px 0;border-bottom:1px solid #334155;font-size:13px;">
            ${side} <b>${escapeHtml(String(o.stock_code))}</b> ${Number(o.filled_quantity ?? o.quantity).toLocaleString()}주 @ ${Number(o.filled_price ?? o.price).toLocaleString()}원
            ${reason ? `<br><span style="color:#9ca3af;font-size:11px;">💡 ${reason}</span>` : ''}
          </div>`;
        })
        .join('');
    }

    return `
      <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:16px;">
        <h2 style="color:#38bdf8;margin:0 0 12px 0;font-size:16px;">
          ${d.mode === '실전' ? '🔴' : '🔵'} ${d.mode} 모드
        </h2>

        <!-- 자산 현황 -->
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
          <div style="flex:1;min-width:120px;background:#1e293b;border-radius:6px;padding:10px;">
            <div style="color:#9ca3af;font-size:11px;">총 자산</div>
            <div style="color:#f8fafc;font-size:18px;font-weight:bold;">${d.totalAsset.toLocaleString()}원</div>
          </div>
          <div style="flex:1;min-width:120px;background:#1e293b;border-radius:6px;padding:10px;">
            <div style="color:#9ca3af;font-size:11px;">현금</div>
            <div style="color:#f8fafc;font-size:16px;">${d.cash.toLocaleString()}원</div>
          </div>
          <div style="flex:1;min-width:120px;background:#1e293b;border-radius:6px;padding:10px;">
            <div style="color:#9ca3af;font-size:11px;">투자금</div>
            <div style="color:#f8fafc;font-size:16px;">${d.investedAmount.toLocaleString()}원</div>
          </div>
        </div>

        <!-- 손익 -->
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          <div style="flex:1;background:#1e293b;border-radius:6px;padding:10px;">
            <div style="color:#9ca3af;font-size:11px;">미실현 손익</div>
            <div style="color:${pnlColor};font-size:16px;font-weight:bold;">${d.unrealizedPnl >= 0 ? '+' : ''}${d.unrealizedPnl.toLocaleString()}원</div>
          </div>
          <div style="flex:1;background:#1e293b;border-radius:6px;padding:10px;">
            <div style="color:#9ca3af;font-size:11px;">실현 손익</div>
            <div style="color:${realColor};font-size:16px;font-weight:bold;">${d.realizedPnl >= 0 ? '+' : ''}${d.realizedPnl.toLocaleString()}원</div>
          </div>
        </div>

        <!-- 오늘 매매 -->
        <div style="margin-bottom:16px;">
          <h3 style="color:#94a3b8;font-size:13px;margin:0 0 8px 0;">📊 오늘 매매 (매수 ${d.buyCount} · 매도 ${d.sellCount} · 청산 ${d.closedCount})</h3>
          ${tradeList || '<p style="color:#9ca3af;font-size:13px;">매매 없음</p>'}
        </div>

        <!-- 보유 종목 -->
        <div style="margin-bottom:16px;">
          <h3 style="color:#94a3b8;font-size:13px;margin:0 0 8px 0;">📋 보유 종목 (${d.positions.length}개) · 열린 체인 ${d.openChains}개</h3>
          ${posTable}
        </div>

        <!-- 성과 요약 -->
        <div style="display:flex;gap:12px;">
          <div style="flex:1;background:#1e293b;border-radius:6px;padding:10px;">
            <div style="color:#9ca3af;font-size:11px;">이번 주</div>
            <div style="color:${d.weekPnl >= 0 ? '#22c55e' : '#ef4444'};font-size:14px;">${d.weekPnl >= 0 ? '+' : ''}${d.weekPnl.toLocaleString()}원</div>
            <div style="color:#9ca3af;font-size:11px;">${d.weekWins}승 ${d.weekLosses}패</div>
          </div>
          <div style="flex:1;background:#1e293b;border-radius:6px;padding:10px;">
            <div style="color:#9ca3af;font-size:11px;">이번 달</div>
            <div style="color:${d.monthPnl >= 0 ? '#22c55e' : '#ef4444'};font-size:14px;">${d.monthPnl >= 0 ? '+' : ''}${d.monthPnl.toLocaleString()}원</div>
            <div style="color:#9ca3af;font-size:11px;">${d.monthWins}승 ${d.monthLosses}패 (승률 ${monthWinRate}%)</div>
          </div>
        </div>
      </div>`;
  };

  // AI 비용 섹션
  const aiSection = `
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h2 style="color:#a78bfa;margin:0 0 12px 0;font-size:16px;">🤖 AI 비용</h2>
      <div style="display:flex;gap:12px;margin-bottom:8px;">
        <div style="flex:1;background:#1e293b;border-radius:6px;padding:10px;">
          <div style="color:#9ca3af;font-size:11px;">오늘</div>
          <div style="color:#f8fafc;font-size:16px;">$${aiCost.todayCost.toFixed(4)}</div>
        </div>
        <div style="flex:1;background:#1e293b;border-radius:6px;padding:10px;">
          <div style="color:#9ca3af;font-size:11px;">이번 달 누적</div>
          <div style="color:#f8fafc;font-size:16px;">$${aiCost.monthCost.toFixed(4)}</div>
        </div>
      </div>
      ${
        aiCost.byModel.length > 0
          ? `<div style="font-size:12px;color:#9ca3af;margin-top:8px;">
              ${aiCost.byModel.map((m) => `${m.model}: $${m.cost.toFixed(4)} (${m.tokens.toLocaleString()} tokens)`).join('<br>')}
            </div>`
          : ''
      }
    </div>`;

  // 정합성 체크 섹션
  const criticalIssues = integrityIssues.filter((i) => i.severity === 'critical');
  const warningIssues = integrityIssues.filter((i) => i.severity === 'warning');
  const integritySection = `
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h2 style="color:${integrityIssues.length === 0 ? '#22c55e' : '#f59e0b'};margin:0 0 12px 0;font-size:16px;">
        🔍 정합성 체크 ${integrityIssues.length === 0 ? '✅' : `(${integrityIssues.length}건)`}
      </h2>
      ${
        integrityIssues.length === 0
          ? '<p style="color:#22c55e;font-size:13px;">이상 없음</p>'
          : `
            ${criticalIssues.length > 0 ? `<div style="color:#ef4444;font-size:13px;margin-bottom:8px;"><b>치명 (${criticalIssues.length})</b><br>${criticalIssues.map((i) => `🔴 ${escapeHtml(i.message)}`).join('<br>')}</div>` : ''}
            ${warningIssues.length > 0 ? `<div style="color:#f59e0b;font-size:13px;"><b>경고 (${warningIssues.length})</b><br>${warningIssues.map((i) => `🟡 ${escapeHtml(i.message)}`).join('<br>')}</div>` : ''}
          `
      }
    </div>`;

  // 시스템 이벤트 섹션
  const sysSection = `
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h2 style="color:#94a3b8;margin:0 0 8px 0;font-size:16px;">⚙️ 시스템</h2>
      <div style="font-size:13px;color:#9ca3af;">
        에러 ${systemEvents.errors}건 · 경고 ${systemEvents.warnings}건
      </div>
    </div>`;

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:20px;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0;">
      <div style="max-width:640px;margin:0 auto;">
        <h1 style="color:#f8fafc;font-size:20px;margin:0 0 4px 0;">📊 AI 자동매매 종합 리포트</h1>
        <p style="color:#64748b;font-size:13px;margin:0 0 20px 0;">${today} (KST 17:00)</p>

        ${liveData ? renderModeSection(liveData) : ''}
        ${renderModeSection(paperData)}
        ${aiSection}
        ${integritySection}
        ${sysSection}

        <p style="color:#475569;font-size:11px;text-align:center;margin-top:24px;">
          AI Auto Bot — 자동 생성 리포트
        </p>
      </div>
    </body>
    </html>`;
}

/** UTC 안전 — getDay()→getUTCDay() 타임존 버그 수정 */
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return d.toISOString().split('T')[0];
}
