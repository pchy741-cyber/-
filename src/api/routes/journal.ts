import { Hono } from 'hono';
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { FALLBACK_FX_RATE, OVERSEAS_FEE_PCT } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { resolveRequestMode } from '../guards/live-pin.js';

export const journalRoutes = new Hono();

interface JournalTrade {
  market: 'KR' | 'US';
  code: string;
  name: string;
  pnlPct: number; // 수수료 차감 후 실수익률
  pnlPctGross: number; // 수수료 미반영 (참고용)
  pnlAmountKrw: number; // 원화 환산 수익금
  pnlAmount: number; // 시장 기준 통화 (KR=원, US=달러)
  feeKrw: number; // 수수료 원화
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  openedAt: string;
  closedAt: string;
  holdingDays: number;
  closeReason: string;
  strategyMode?: string;
}

interface ReasonStat {
  reason: string;
  count: number;
  winRate: number;
  avgPnlPct: number;
}

/**
 * GET /journal?days=30&viewMode=paper|live
 * 국내(KR) + 해외(US) 완결 매매 통합 조회 + 승률 인사이트
 */
journalRoutes.get('/journal', async (c) => {
  // 🛡️ 백테스팅용 데이터 보존: max 90 → 730일 (2년) 확장, default 30 → 180 확장
  // CEO 지시 (2026-06-12): "매매일지 내역 다 보이게"
  const days = Math.min(730, Math.max(1, Number(c.req.query('days') ?? 180)));
  const viewIsPaper = resolveRequestMode(c);
  const viewTradingMode = viewIsPaper ? 'paper' : 'live';
  const pool = getPool();
  const trades: JournalTrade[] = [];

  // 환율 조회 (US→KRW 변환용)
  let fxRate = FALLBACK_FX_RATE;
  try {
    fxRate = await fetchExchangeRate();
  } catch {
    /* 폴백 사용 */
  }

  try {
    // ── 국내 종결 체인 (transaction_chains) ──
    const { rows: krRows } = await pool.query(
      `
      SELECT
        tc.stock_code,
        w.stock_name,
        tc.avg_buy_price,
        tc.total_quantity,
        tc.total_invested,
        tc.realized_pnl,
        tc.strategy_mode,
        tc.opened_at,
        tc.closed_at,
        tc.close_reason,
        (
          SELECT CASE WHEN SUM(o.filled_quantity) > 0
            THEN SUM(o.filled_price * o.filled_quantity) / SUM(o.filled_quantity)
            ELSE AVG(o.filled_price) END
          FROM orders o
          WHERE o.chain_id = tc.id
            AND o.side = 'SELL'
            AND o.status = 'FILLED'
            AND o.filled_price IS NOT NULL
            AND o.filled_quantity > 0
        ) AS exit_price
      FROM transaction_chains tc
      LEFT JOIN watchlist w ON w.stock_code = tc.stock_code
      WHERE tc.status = 'CLOSED'
        AND tc.closed_at >= (DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') - ($1 * INTERVAL '1 day')) AT TIME ZONE 'Asia/Seoul'
        AND tc.is_paper = $2
      ORDER BY tc.closed_at DESC
      LIMIT 2000
    `,
      [days, viewIsPaper],
    );

    for (const r of krRows) {
      const entryPrice = Number(r.avg_buy_price ?? 0);
      const exitPrice = Number(r.exit_price ?? 0);
      const qty = Number(r.total_quantity ?? 0);
      const invested = Number(r.total_invested ?? 0);

      // 수수료 추정 (표시용) — 매수 0.015% + 매도 0.195%
      const buyFeeKrw = entryPrice * qty * 0.00015;  // KR_FEE.BUY_FEE_PCT
      const sellFeeKrw = exitPrice > 0 ? exitPrice * qty * 0.00195 : 0;  // KR_FEE.SELL_FEE_PCT
      const feeKrw = buyFeeKrw + sellFeeKrw;

      // realized_pnl: DB 값은 이미 수수료 포함 (avg_buy_price에 매수수수료 포함, 매도가에 SELL_FEE 차감)
      // → pnlNet으로 직접 사용, 추가 수수료 차감 금지 (이중차감 방지)
      let pnlNet: number;
      let pnlPctGross: number;
      if (r.realized_pnl != null) {
        pnlNet = Number(r.realized_pnl);
        // Gross = 수수료 차감 전 추정 (역산)
        const estGross = pnlNet + feeKrw;
        pnlPctGross = invested > 0 ? (estGross / invested) * 100
          : entryPrice > 0 && exitPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      } else {
        // realized_pnl NULL: 가격 기반 폴백 (외부 매도 등)
        // exitPrice=0(외부 매도 → SELL 주문 없음 → NULL) 시 -100% 오표시 방지
        const pnlGross = exitPrice > 0 && entryPrice > 0 ? (exitPrice - entryPrice) * qty : 0;
        pnlPctGross = invested > 0 ? (pnlGross / invested) * 100
          : entryPrice > 0 && exitPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
        pnlNet = pnlGross - feeKrw;
      }
      const pnlPctNet = invested > 0 ? (pnlNet / invested) * 100 : pnlPctGross;

      const openedAt = r.opened_at ? new Date(r.opened_at).toISOString() : '';
      const closedAt = r.closed_at ? new Date(r.closed_at).toISOString() : '';
      const holdingDays =
        openedAt && closedAt ? (new Date(closedAt).getTime() - new Date(openedAt).getTime()) / 86_400_000 : 0;

      trades.push({
        market: 'KR',
        code: String(r.stock_code),
        name: String(r.stock_name ?? r.stock_code),
        pnlPct: Math.round(pnlPctNet * 100) / 100,
        pnlPctGross: Math.round(pnlPctGross * 100) / 100,
        pnlAmountKrw: Math.round(pnlNet),
        pnlAmount: Math.round(pnlNet),
        feeKrw: Math.round(feeKrw),
        entryPrice,
        exitPrice: exitPrice || entryPrice,
        quantity: qty,
        openedAt,
        closedAt,
        holdingDays: Math.round(holdingDays * 10) / 10,
        closeReason: String(r.close_reason ?? ''),
        strategyMode: String(r.strategy_mode ?? 'SWING'),
      });
    }
  } catch (e) {
    logger.warn(`저널 KR 조회 실패: ${(e as Error).message}`, { component: 'JOURNAL' });
  }

  try {
    // ── 해외 완결 매매 (SELL 기반) ──
    const { rows: usRows } = await pool.query(
      `
      SELECT
        s.stock_code   AS code,
        s.created_at   AS closed_at,
        s.filled_price AS exit_price,
        s.filled_quantity AS qty,
        s.ai_reasoning AS sell_reasoning,
        COALESCE(
          s.avg_buy_price,
          (regexp_match(s.ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric
        ) AS avg_buy_price,
        (
          SELECT MIN(b.created_at)
          FROM orders b
          WHERE b.stock_code = s.stock_code
            AND b.side = 'BUY' AND b.status = 'FILLED'
            AND b.trigger_source = 'OVERSEAS'
            AND b.created_at < s.created_at
            AND b.filled_price IS NOT NULL
        ) AS opened_at
      FROM orders s
      WHERE s.side = 'SELL'
        AND s.status = 'FILLED'
        AND s.trigger_source = 'OVERSEAS'
        AND s.created_at >= NOW() - ($1 || ' days')::interval
        AND s.filled_price IS NOT NULL
        AND s.filled_price > 0
        AND (s.avg_buy_price IS NOT NULL OR s.ai_reasoning ~ '\\[avgBuy:[0-9]')
        AND s.trading_mode IN ($2, CASE WHEN $2 = 'paper' THEN 'p_arch' ELSE $2 END)
      ORDER BY s.created_at DESC
      LIMIT 2000
    `,
      [days, viewTradingMode],
    );

    for (const r of usRows) {
      const entryPrice = Number(r.avg_buy_price ?? 0);
      const exitPrice = Number(r.exit_price);
      const qty = Number(r.qty ?? 0);
      if (entryPrice <= 0 || qty <= 0) continue;
      // 수익률 100% 초과 = 입금으로 왜곡된 평단가 → 제외
      if (entryPrice > 0 && (exitPrice / entryPrice > 2.0 || entryPrice / exitPrice > 2.0)) continue;

      const pnlPctGross = ((exitPrice - entryPrice) / entryPrice) * 100;
      const pnlUsdGross = (exitPrice - entryPrice) * qty;

      // 해외 수수료: 매수 0.35% + 매도 0.35% (수수료+환전스프레드)
      const buyCost = entryPrice * qty * OVERSEAS_FEE_PCT;
      const sellCost = exitPrice * qty * OVERSEAS_FEE_PCT;
      const feeUsd = buyCost + sellCost;
      const pnlUsdNet = pnlUsdGross - feeUsd;
      const pnlPctNet = entryPrice > 0 ? (pnlUsdNet / (entryPrice * qty)) * 100 : 0;

      // USD → KRW 변환
      const pnlKrw = pnlUsdNet * fxRate;
      const feeKrw = feeUsd * fxRate;

      const openedAt = r.opened_at ? new Date(r.opened_at).toISOString() : '';
      const closedAt = r.closed_at ? new Date(r.closed_at).toISOString() : '';
      const holdingDays =
        openedAt && closedAt ? (new Date(closedAt).getTime() - new Date(openedAt).getTime()) / 86_400_000 : 0;

      const sellReasoning = String(r.sell_reasoning ?? '');
      const closeReason = sellReasoning.replace(/\[avgBuy:[^\]]+\]\s*/, '').trim();

      trades.push({
        market: 'US',
        code: String(r.code),
        name: String(r.code),
        pnlPct: Math.round(pnlPctNet * 100) / 100,
        pnlPctGross: Math.round(pnlPctGross * 100) / 100,
        pnlAmountKrw: Math.round(pnlKrw),
        pnlAmount: Math.round(pnlUsdNet * 100) / 100,
        feeKrw: Math.round(feeKrw),
        entryPrice,
        exitPrice,
        quantity: qty,
        openedAt,
        closedAt,
        holdingDays: Math.round(holdingDays * 10) / 10,
        closeReason,
      });
    }
  } catch (e) {
    logger.warn(`저널 US 조회 실패: ${(e as Error).message}`, { component: 'JOURNAL' });
  }

  // 시간순 정렬 (최신 먼저)
  trades.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());

  // ── 승률 분석 ──
  const total = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const avgPnlPct = total > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / total : 0;
  const totalFeeKrw = trades.reduce((s, t) => s + t.feeKrw, 0);
  const totalPnlKrw = trades.reduce((s, t) => s + t.pnlAmountKrw, 0);

  // 매도사유별 승률 분석 (승률 향상 인사이트)
  const reasonMap = new Map<string, { wins: number; total: number; pnlSum: number }>();
  for (const t of trades) {
    const reason = categorizeReason(t.closeReason);
    const stat = reasonMap.get(reason) ?? { wins: 0, total: 0, pnlSum: 0 };
    stat.total++;
    if (t.pnlPct > 0) stat.wins++;
    stat.pnlSum += t.pnlPct;
    reasonMap.set(reason, stat);
  }
  const reasonStats: ReasonStat[] = [...reasonMap.entries()]
    .map(([reason, s]) => ({
      reason,
      count: s.total,
      winRate: s.total > 0 ? Math.round((s.wins / s.total) * 1000) / 10 : 0,
      avgPnlPct: s.total > 0 ? Math.round((s.pnlSum / s.total) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // 승/패 평균 보유일 분석
  const winTrades = trades.filter((t) => t.pnlPct > 0);
  const lossTrades = trades.filter((t) => t.pnlPct <= 0);
  const avgWinHoldDays =
    winTrades.length > 0
      ? Math.round((winTrades.reduce((s, t) => s + t.holdingDays, 0) / winTrades.length) * 10) / 10
      : 0;
  const avgLossHoldDays =
    lossTrades.length > 0
      ? Math.round((lossTrades.reduce((s, t) => s + t.holdingDays, 0) / lossTrades.length) * 10) / 10
      : 0;
  const avgWinPct =
    winTrades.length > 0 ? Math.round((winTrades.reduce((s, t) => s + t.pnlPct, 0) / winTrades.length) * 100) / 100 : 0;
  const avgLossPct =
    lossTrades.length > 0
      ? Math.round((lossTrades.reduce((s, t) => s + t.pnlPct, 0) / lossTrades.length) * 100) / 100
      : 0;

  return c.json({
    trades,
    summary: {
      totalTrades: total,
      wins,
      losses: total - wins,
      winRate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0,
      avgPnlPct: Math.round(avgPnlPct * 100) / 100,
      totalPnlKrw: Math.round(totalPnlKrw),
      totalFeeKrw: Math.round(totalFeeKrw),
      fxRate: Math.round(fxRate * 100) / 100,
    },
    insights: {
      reasonStats,
      winAvg: { holdDays: avgWinHoldDays, pnlPct: avgWinPct },
      lossAvg: { holdDays: avgLossHoldDays, pnlPct: avgLossPct },
      profitFactor:
        lossTrades.length > 0 && avgLossPct !== 0
          ? Math.round(Math.abs((avgWinPct * winTrades.length) / (avgLossPct * lossTrades.length)) * 100) / 100
          : 0,
    },
    days,
  });
});

/** 매도사유를 카테고리로 분류 */
function categorizeReason(reason: string): string {
  if (!reason) return '미분류';
  const r = reason.toLowerCase();
  if (r.includes('손절') || r.includes('stoploss') || r.includes('stop_loss')) return '손절';
  if (r.includes('트레일') || r.includes('trail')) return '트레일링스톱';
  if (r.includes('부분익절') || r.includes('partialt')) return '부분익절';
  if (r.includes('집중') || r.includes('conc')) return '집중도캡';
  if (r.includes('리밸런') || r.includes('rebalanc')) return '리밸런싱';
  if (r.includes('보유기한') || r.includes('timeout') || r.includes('expir')) return '보유기한초과';
  if (r.includes('수동') || r.includes('manual')) return '수동매도';
  if (r.includes('약세') || r.includes('weak')) return '약세종목정리';
  if (r.includes('scalp') || r.includes('vision')) return '비전스캘프';
  if (r.includes('강제') || r.includes('force')) return '강제청산';
  return '기타';
}
