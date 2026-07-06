/**
 * 일일 운영 브리핑 — 간결한 한 줄 요약 텔레그램 발송
 *
 * 08:00 KST: 해외주식 브리핑 (미국장 마감 후)
 * 17:00 KST: 국내주식 브리핑 (국내장 마감 후)
 *
 * 포맷:
 * - 손절: 종목 한 줄 사유
 * - 수익: 종목 한 줄 요약
 * - 보유 현황: 종목별 수익률
 * - 운영 방향: 한 마디
 */

import { getPool } from '../db/client.js';
import { safeQuery } from '../db/pool.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { computeStrategyHealth } from '../risk/strategy-health.js';

const COMPONENT = 'BRIEFING';

type Market = 'KR' | 'US';

export async function runDailyBriefing(market: Market): Promise<void> {
  try {
    const pool = getPool();
    const today = getKSTNow().toISOString().split('T')[0];
    const isKr = market === 'KR';
    const label = isKr ? '국내' : '해외';

    // ── 기간: 국내=오늘, 해외=어제 미국장 마감~지금 (약 18시간)
    const cutoff = isKr
      ? `${today}T00:00:00+09:00`
      : new Date(Date.now() - 18 * 3600_000).toISOString();

    // ── 1. 오늘 청산된 체인 (paper + live)
    const { rows: closedChains } = await pool.query(
      `SELECT stock_code, is_paper, realized_pnl, pnl_pct, close_reason, sell_reason,
              total_quantity, avg_buy_price, strategy_mode
       FROM transaction_chains
       WHERE status = 'CLOSED' AND closed_at >= $1
       ${isKr ? "AND stock_code ~ '^[0-9]{6}$'" : "AND stock_code !~ '^[0-9]{6}$'"}
       ORDER BY closed_at DESC`,
      [cutoff],
    );

    // ── 2. 오늘 체결된 매수/매도 건수
    const { rows: orderStats } = await pool.query(
      `SELECT is_paper, side, COUNT(*) as cnt
       FROM orders
       WHERE status = 'FILLED' AND created_at >= $1
       ${isKr ? "AND stock_code ~ '^[0-9]{6}$'" : "AND stock_code !~ '^[0-9]{6}$'"}
       GROUP BY is_paper, side`,
      [cutoff],
    );

    // ── 3. 현재 보유 종목
    let holdingLines: string[] = [];
    if (isKr) {
      const { rows: chains } = await pool.query(
        `SELECT stock_code, is_paper, total_quantity, avg_buy_price, realized_pnl, strategy_mode
         FROM transaction_chains
         WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
           AND stock_code ~ '^[0-9]{6}$'
         ORDER BY is_paper, stock_code`,
      );
      holdingLines = chains.map((c: any) => {
        const mode = c.is_paper ? 'P' : 'L';
        return `  [${mode}] ${c.stock_code} ${c.total_quantity}주 · 평단${Number(c.avg_buy_price).toLocaleString()}원`;
      });
    } else {
      const { rows: holdings } = await pool.query(
        `SELECT stock_code, is_paper, quantity, avg_price, last_price,
                CASE WHEN avg_price > 0 THEN ((last_price - avg_price) / avg_price) * 100 ELSE NULL END AS unrealized_pnl_pct
         FROM overseas_holdings
         WHERE quantity > 0
         ORDER BY is_paper, stock_code`,
      );
      holdingLines = holdings.map((h: any) => {
        const mode = h.is_paper ? 'P' : 'L';
        const pct = h.unrealized_pnl_pct != null ? `${Number(h.unrealized_pnl_pct) >= 0 ? '+' : ''}${Number(h.unrealized_pnl_pct).toFixed(1)}%` : '';
        return `  [${mode}] ${h.stock_code} ${h.quantity}주 $${Number(h.avg_price).toFixed(1)} ${pct}`;
      });
    }

    // ── 4. 누적 성과 (이번 달)
    const monthStart = `${today.slice(0, 7)}-01`;
    const { rows: monthStats } = await pool.query(
      `SELECT is_paper,
              COUNT(*) as total,
              SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
              SUM(realized_pnl) as pnl
       FROM transaction_chains
       WHERE status = 'CLOSED' AND closed_at >= $1
       ${isKr ? "AND stock_code ~ '^[0-9]{6}$'" : "AND stock_code !~ '^[0-9]{6}$'"}
       GROUP BY is_paper`,
      [`${monthStart}T00:00:00+09:00`],
    );

    // ── v25 P1-3: 성과 4줄 헤더 ──
    let healthHeader = '';
    try {
      const h = await computeStrategyHealth(false, 90, 5.0);
      const bmStr = h.benchmark.available
        ? `벤치 ${h.benchmark.benchmarkCagr >= 0 ? '+' : ''}${h.benchmark.benchmarkCagr}% | 알파 ${h.benchmark.alpha >= 0 ? '+' : ''}${h.benchmark.alpha}%`
        : '';
      const psrStr = h.efficiency.psrSignificant
        ? `확정`
        : `${h.efficiency.minTRL - h.period.tradingDays}일 더`;
      healthHeader = [
        `TWR ${h.returns.cumulativePct >= 0 ? '+' : ''}${h.returns.cumulativePct}% (${h.period.totalTrades}건)${bmStr ? ` | ${bmStr}` : ''}`,
        `MDD -${h.risk.maxDrawdownPct}% | 월 ${h.goal.currentMonthPct >= 0 ? '+' : ''}${h.goal.currentMonthPct}%/목표5%`,
        `Sharpe ${h.efficiency.sharpeRatio} (PSR ${h.efficiency.psr}, ${psrStr}) | Sortino ${h.efficiency.sortinoRatio}`,
        `등급 ${h.grade}${!h.goal.goalRealistic ? ' ⚠️목표 필요샤프 ' + h.goal.requiredSharpe + ' (비현실적)' : ''}`,
      ].join('\n');
    } catch { /* health 조회 실패 시 생략 */ }

    // ── 메시지 조립
    const lines: string[] = [];
    lines.push(`${isKr ? '🇰🇷' : '🇺🇸'} *${label} 운영 브리핑* · ${today}`);
    lines.push(`━━━━━━━━━━━━━━━━`);
    if (healthHeader) {
      lines.push(healthHeader);
      lines.push(`━━━━━━━━━━━━━━━━`);
    }

    // 청산 요약 — 한 줄씩
    if (closedChains.length === 0) {
      lines.push(`📭 오늘 청산 없음`);
    } else {
      lines.push(`📊 *오늘 청산 ${closedChains.length}건*`);
      for (const c of closedChains) {
        const pnl = Number(c.realized_pnl ?? 0);
        const pct = c.pnl_pct != null ? `${Number(c.pnl_pct).toFixed(1)}%` : '';
        const mode = c.is_paper ? 'P' : 'L';
        const reason = summarizeReason(c.close_reason, c.sell_reason, pnl);
        if (pnl >= 0) {
          lines.push(`  🟢 [${mode}] ${c.stock_code} +${pnl.toLocaleString()}${isKr ? '원' : '$'} (${pct}) — ${reason}`);
        } else {
          lines.push(`  🔴 [${mode}] ${c.stock_code} ${pnl.toLocaleString()}${isKr ? '원' : '$'} (${pct}) — ${reason}`);
        }
      }
    }

    // 매매 활동
    const paperBuy = orderStats.find((r: any) => r.is_paper && r.side === 'BUY')?.cnt ?? 0;
    const paperSell = orderStats.find((r: any) => r.is_paper && r.side === 'SELL')?.cnt ?? 0;
    const liveBuy = orderStats.find((r: any) => !r.is_paper && r.side === 'BUY')?.cnt ?? 0;
    const liveSell = orderStats.find((r: any) => !r.is_paper && r.side === 'SELL')?.cnt ?? 0;
    if (paperBuy + paperSell + liveBuy + liveSell > 0) {
      lines.push(``);
      lines.push(`🤖 *AI 활동*`);
      if (paperBuy + paperSell > 0) lines.push(`  [P] 매수 ${paperBuy}건 · 매도 ${paperSell}건`);
      if (liveBuy + liveSell > 0) lines.push(`  [L] 매수 ${liveBuy}건 · 매도 ${liveSell}건`);
    }

    // 보유 현황
    if (holdingLines.length > 0) {
      lines.push(``);
      lines.push(`📋 *보유 ${holdingLines.length}종목*`);
      lines.push(...holdingLines.slice(0, 15));
      if (holdingLines.length > 15) lines.push(`  ... +${holdingLines.length - 15}종목`);
    }

    // 월간 성과 + 미실현 손익 (v10.11.3: 숨겨진 손실 투명화)
    if (monthStats.length > 0) {
      lines.push(``);
      lines.push(`📈 *${today.slice(5, 7)}월 누적*`);
      for (const ms of monthStats) {
        const mode = ms.is_paper ? 'P' : 'L';
        const pnl = Number(ms.pnl ?? 0);
        const winRate = Number(ms.total) > 0 ? ((Number(ms.wins) / Number(ms.total)) * 100).toFixed(0) : '0';
        lines.push(`  [${mode}] ${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}${isKr ? '원' : '$'} · 승률 ${winRate}% (${ms.wins}/${ms.total})`);
      }
    }

    // v10.11.3: 미실현 손익 투명화 — OPEN 포지션의 평가손익 합산
    // 기존: CLOSED만 보여줌 → OPEN 포지션의 대규모 미실현 손실이 보이지 않음
    // 수정: 미실현 손익도 함께 표시하여 실질 포트폴리오 상태 파악
    try {
      let unrealizedPnlKrw = 0;
      let unrealizedCount = 0;
      if (isKr) {
        // 국내: OPEN 체인의 (현재가 - 평균매수가) × 수량
        // livePrices 없으므로 avg_buy_price 기반 추정 (realized_pnl에 누적된 부분매도 PnL 포함)
        const { rows: openChains } = await pool.query(
          `SELECT stock_code, total_quantity, avg_buy_price, is_paper, realized_pnl
           FROM transaction_chains
           WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')
             AND stock_code ~ '^[0-9]{6}$'`,
        );
        unrealizedCount = openChains.length;
        // 부분매도 수익 합산 (실현된 PnL이 미실현 영역에 숨겨짐)
        for (const c of openChains) {
          unrealizedPnlKrw += Number(c.realized_pnl ?? 0);
        }
      } else {
        // 해외: overseas_holdings의 unrealized_pnl (인라인 계산)
        const { rows: holdings } = await pool.query(
          `SELECT quantity, avg_price, last_price,
                  CASE WHEN avg_price > 0 THEN ((last_price - avg_price) / avg_price) * 100 ELSE 0 END AS unrealized_pnl_pct
           FROM overseas_holdings WHERE quantity > 0`,
        );
        unrealizedCount = holdings.length;
        for (const h of holdings) {
          const value = Number(h.quantity) * Number(h.avg_price);
          const pct = Number(h.unrealized_pnl_pct ?? 0);
          unrealizedPnlKrw += value * (pct / 100);
        }
      }
      if (unrealizedCount > 0) {
        const unrealizedLabel = isKr ? '원' : '$';
        const emoji = unrealizedPnlKrw >= 0 ? '📗' : '📕';
        lines.push(`${emoji} *미실현* ${unrealizedPnlKrw >= 0 ? '+' : ''}${Math.round(unrealizedPnlKrw).toLocaleString()}${unrealizedLabel} (${unrealizedCount}종목 보유중)`);
      }
    } catch { /* 미실현 조회 실패 시 생략 */ }

    // 운영 방향 한 마디
    lines.push(``);
    lines.push(generateDirection(closedChains, monthStats, market));

    const message = lines.join('\n');
    await sendTelegramMessage(message);
    logger.info(`📊 ${label} 브리핑 발송 (${closedChains.length}청산, ${holdingLines.length}보유)`, { component: COMPONENT });
  } catch (err) {
    logger.error(`${market} 브리핑 실패: ${err}`, { component: COMPONENT });
  }
}

/** 청산 사유 → 한 줄 한국어 요약 */
function summarizeReason(closeReason: string | null, sellReason: string | null, pnl: number): string {
  const reason = sellReason || closeReason || '';
  const r = reason.toLowerCase();

  if (r.includes('stop_loss') || r.includes('stoploss') || r.includes('손절'))
    return '손절 컷';
  if (r.includes('trailing') || r.includes('trail'))
    return '트레일링 스톱';
  if (r.includes('take_profit') || r.includes('takeprofit') || r.includes('익절'))
    return '목표가 도달';
  if (r.includes('partial') || r.includes('분할'))
    return '분할 익절';
  if (r.includes('defense') || r.includes('park') || r.includes('방어'))
    return '방어 모드';
  if (r.includes('holding') || r.includes('보유일'))
    return '보유일 초과';
  if (r.includes('overnight') || r.includes('eod'))
    return '장마감 강제청산';
  if (r.includes('mdd') || r.includes('drawdown'))
    return 'MDD 한도';
  if (r.includes('manual'))
    return '수동 청산';
  if (r.includes('kill') || r.includes('emergency'))
    return '긴급 정지';
  if (r.includes('rebalance') || r.includes('리밸'))
    return '리밸런싱';

  // 사유 없으면 손익 기반
  return pnl >= 0 ? '수익 청산' : '손실 청산';
}

/** 운영 방향 한 마디 생성 */
function generateDirection(closedChains: any[], monthStats: any[], market: Market): string {
  const totalClosed = closedChains.length;
  const wins = closedChains.filter((c: any) => Number(c.realized_pnl) > 0).length;
  const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;

  const monthPnl = monthStats.reduce((s: number, ms: any) => s + Number(ms.pnl ?? 0), 0);
  const monthWinRate = monthStats.reduce((s: number, ms: any) => s + Number(ms.total ?? 0), 0) > 0
    ? (monthStats.reduce((s: number, ms: any) => s + Number(ms.wins ?? 0), 0) / monthStats.reduce((s: number, ms: any) => s + Number(ms.total ?? 0), 0)) * 100
    : 0;

  if (totalClosed === 0) {
    return `📌 *방향*: 관망 유지, 진입 신호 대기 중`;
  }

  if (monthWinRate >= 60 && monthPnl > 0) {
    return `📌 *방향*: 승률 양호 — 현 전략 유지, 포지션 사이즈 점진 확대 검토`;
  }
  if (monthWinRate >= 40 && monthPnl > 0) {
    return `📌 *방향*: 수익 유지 중 — 리스크 관리 유지, 손절폭 준수`;
  }
  if (monthWinRate < 35) {
    return `📌 *방향*: 승률 부진 — 임계값 상향, 거래 빈도 줄이고 확실한 기회만 진입`;
  }
  if (monthPnl < 0) {
    return `📌 *방향*: 월 손실 구간 — 포지션 축소, 방어적 운영 강화`;
  }
  return `📌 *방향*: 현 전략 유지, 시장 변동성 모니터링 지속`;
}
