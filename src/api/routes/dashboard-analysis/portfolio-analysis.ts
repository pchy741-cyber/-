import { Hono } from 'hono';
import { KR_FEE } from '../../../config/constants.js';
import { config } from '../../../config/index.js';
import { getOpenChains, getPool } from '../../../db/client.js';
import { getAccountBalance } from '../../../kis/account.js';
import { getPaperBalance } from '../../../risk/engine.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { getKnownStockName } from '../dashboard.js';

export const portfolioAnalysisRoutes = new Hono();

// 통합 헬퍼 사용 — viewMode/mode 양쪽 지원
const resolveViewIsPaper = resolveRequestMode;

// ── KIS 잔고 → DB 포지션 동기화 (고아 포지션 복구) ──
portfolioAnalysisRoutes.post('/sync-positions', async (c) => {
  try {
    const viewIsPaper = resolveViewIsPaper(c);
    const balanceFn = viewIsPaper ? getPaperBalance : getAccountBalance;
    const [balance, openChains] = await Promise.all([balanceFn(), getOpenChains(viewIsPaper)]);

    const kisPositions: Array<{ stockCode: string; quantity: number; avgBuyPrice: number; stockName?: string }> = (
      balance.positions ?? []
    )
      .filter((p: any) => Number(p.quantity ?? p.holdingQuantity ?? 0) > 0)
      .map((p: any) => ({
        stockCode: String(p.stockCode ?? ''),
        quantity: Number(p.quantity ?? p.holdingQuantity ?? 0),
        avgBuyPrice: Number(p.avgBuyPrice ?? p.purchasePrice ?? 0),
        stockName: p.stockName ?? undefined,
      }))
      .filter((p: any) => p.stockCode.length === 6 && p.quantity > 0 && p.avgBuyPrice > 0);

    const tradingPositions = kisPositions;
    const chainedCodes = new Set(openChains.map((ch: any) => ch.stock_code));
    const orphans = tradingPositions.filter((p) => !chainedCodes.has(p.stockCode));

    // 0주 체인 복구: 체인은 있는데 total_quantity=0이고 KIS에 실제 보유 있는 경우
    // (매수 직후 잔고 반영 딜레이로 confirmed=false 저장된 경우)
    const ghostChains = openChains.filter(
      (ch: any) => Number(ch.total_quantity) === 0 && Number(ch.avg_buy_price) > 0,
    );
    const fixedCodes: string[] = [];
    for (const ghost of ghostChains) {
      const kisPos = kisPositions.find((p) => p.stockCode === ghost.stock_code);
      if (kisPos) {
        await getPool().query(
          `UPDATE chains SET total_quantity = $1, total_invested = $2 WHERE id = $3`,
          [kisPos.quantity, kisPos.avgBuyPrice * kisPos.quantity, ghost.id],
        );
        fixedCodes.push(ghost.stock_code);
        logger.info(
          `🔧 0주 체인 복구: ${ghost.stock_code} → ${kisPos.quantity}주 @ ${kisPos.avgBuyPrice.toLocaleString()}원`,
          { component: 'SYNC' },
        );
      }
    }

    if (orphans.length === 0 && fixedCodes.length === 0) {
      return c.json({ ok: true, synced: 0, fixed: 0, message: '동기화할 포지션 없음 (이미 정상 상태)' });
    }
    if (orphans.length === 0) {
      const { hardInvalidateMode } = await import('../dashboard/helpers.js');
      hardInvalidateMode(viewIsPaper);
      return c.json({ ok: true, synced: 0, fixed: fixedCodes.length, fixedCodes, message: `0주 체인 ${fixedCodes.length}종목 복구 완료` });
    }

    const { createChain, insertOrder } = await import('../../../db/client.js');
    const synced: string[] = [];

    for (const pos of orphans) {
      try {
        const knownName = getKnownStockName(pos.stockCode) ?? pos.stockName ?? pos.stockCode;
        await getPool().query(
          `INSERT INTO watchlist (stock_code, stock_name, market, source)
           VALUES ($1, $2, 'KOSPI', 'KIS_SYNC')
           ON CONFLICT (stock_code) DO NOTHING`,
          [pos.stockCode, knownName],
        );

        const chainId = await createChain({
          stock_code: pos.stockCode,
          status: 'OPEN',
          strategy_mode: 'SWING',
          avg_buy_price: pos.avgBuyPrice,
          total_quantity: pos.quantity,
          total_invested: pos.avgBuyPrice * pos.quantity,
          realized_pnl: 0,
          target_profit_pct: 2.5,
          stop_loss_pct: -1.5,
          max_averaging_count: 1,
          current_averaging_count: 0,
        });

        await insertOrder({
          chain_id: chainId,
          stock_code: pos.stockCode,
          side: 'BUY',
          order_type: '01',
          quantity: pos.quantity,
          price: pos.avgBuyPrice,
          kis_order_no: `SYNC_${pos.stockCode}`,
          kis_status: null,
          filled_quantity: pos.quantity,
          filled_price: pos.avgBuyPrice,
          status: 'FILLED',
          trading_mode: viewIsPaper ? 'paper' : 'live',
          trigger_source: 'SYNC',
          ai_reasoning: 'KIS 잔고 동기화 — 기존 보유 포지션 복구',
        });

        synced.push(pos.stockCode);
        logger.info(`🔄 포지션 동기화: ${pos.stockCode} ${pos.quantity}주 @ ${pos.avgBuyPrice.toLocaleString()}원`, {
          component: 'SYNC',
        });
      } catch (innerErr: any) {
        logger.error(`포지션 동기화 실패 (${pos.stockCode}): ${innerErr.message}`, { component: 'SYNC' });
      }
    }

    const { hardInvalidateMode } = await import('../dashboard/helpers.js');
    hardInvalidateMode(viewIsPaper);
    return c.json({
      ok: true,
      synced: synced.length,
      fixed: fixedCodes.length,
      codes: synced,
      fixedCodes,
      message: `${synced.length}종목 신규 복구, ${fixedCodes.length}종목 0주 체인 수정 완료`,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 전략별 성과 분석 ──
portfolioAnalysisRoutes.get('/strategy/performance', async (c) => {
  try {
    const pool = getPool();
    const isPaper = resolveViewIsPaper(c);
    const { rows } = await pool.query(
      `
      SELECT
        tc.strategy_mode,
        COUNT(*) AS trades,
        SUM(CASE WHEN tc.realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
        ROUND(AVG(tc.realized_pnl)::numeric, 0) AS avg_pnl,
        ROUND(SUM(tc.realized_pnl)::numeric, 0) AS total_pnl,
        ROUND(
          AVG(CASE WHEN tc.avg_buy_price > 0 AND tc.total_quantity > 0
            THEN tc.realized_pnl / (tc.avg_buy_price * tc.total_quantity) * 100
            ELSE NULL END)::numeric, 2
        ) AS avg_pnl_pct,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (tc.closed_at - tc.opened_at)) / 3600
        )::numeric, 1) AS avg_hold_hours
      FROM transaction_chains tc
      WHERE tc.status = 'CLOSED'
        AND tc.is_paper = $1
        AND tc.stock_code ~ '^[0-9]{6}$'
        AND tc.opened_at >= NOW() - INTERVAL '90 days'
      GROUP BY tc.strategy_mode
      ORDER BY total_pnl DESC
    `,
      [isPaper],
    );
    return c.json(
      rows.map((r: any) => ({
        mode: r.strategy_mode ?? 'UNKNOWN',
        trades: Number(r.trades),
        wins: Number(r.wins),
        winRate: Number(r.trades) > 0 ? Math.round((Number(r.wins) / Number(r.trades)) * 100) : 0,
        avgPnl: Number(r.avg_pnl),
        totalPnl: Number(r.total_pnl),
        avgPnlPct: Number(r.avg_pnl_pct ?? 0),
        avgHoldHours: Number(r.avg_hold_hours ?? 0),
      })),
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 시간대별 매매 성과 분석 (어느 시간대에 매수하면 수익률이 좋은가) ──
portfolioAnalysisRoutes.get('/trades/by-hour', async (c) => {
  try {
    const isPaper = resolveViewIsPaper(c);
    const pool = getPool();
    const { rows } = await pool.query(
      `
      SELECT
        EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Seoul')::int AS hour,
        o.side,
        COUNT(*) AS count,
        ROUND(AVG(
          CASE
            WHEN o.side = 'SELL' AND o.filled_price IS NOT NULL AND tc.avg_buy_price IS NOT NULL AND tc.avg_buy_price > 0
            THEN (o.filled_price - tc.avg_buy_price) / tc.avg_buy_price * 100
            ELSE NULL
          END
        )::numeric, 2) AS avg_pnl_pct,
        SUM(CASE
          WHEN o.side = 'SELL' AND o.filled_price IS NOT NULL AND tc.avg_buy_price IS NOT NULL
            AND o.filled_price > tc.avg_buy_price THEN 1 ELSE 0
        END) AS win_count
      FROM orders o
      JOIN transaction_chains tc ON tc.id = o.chain_id
      WHERE o.status = 'FILLED'
        AND o.trigger_source != 'OVERSEAS'
        AND tc.is_paper = $1
        AND o.created_at >= NOW() - INTERVAL '90 days'
        AND o.filled_price IS NOT NULL
      GROUP BY hour, o.side
      ORDER BY hour ASC, o.side ASC
    `,
      [isPaper],
    );
    return c.json(
      rows.map((r: any) => ({
        hour: Number(r.hour),
        side: r.side,
        count: Number(r.count),
        avgPnlPct: Number(r.avg_pnl_pct ?? 0),
        winRate: Number(r.count) > 0 ? Math.round((Number(r.win_count) / Number(r.count)) * 100) : 0,
      })),
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 봇 수익률 vs KOSPI 비교 ──
portfolioAnalysisRoutes.get('/market/performance-vs-kospi', async (c) => {
  try {
    const pool = getPool();
    const isPaper = resolveViewIsPaper(c);
    // 최근 60일 일별 실현손익 합계
    const { rows: pnlRows } = await pool.query(
      `
      SELECT DATE(o.created_at AT TIME ZONE 'Asia/Seoul') AS day,
             -- v10.2: 매도수수료+세금 차감 (대시보드 통일)
             SUM(o.filled_price * o.filled_quantity
               - ROUND(o.filled_price * o.filled_quantity * ${KR_FEE.SELL_FEE_PCT})
               - tc.avg_buy_price * o.filled_quantity) AS daily_pnl,
             SUM(tc.avg_buy_price * o.filled_quantity) AS cost_basis
      FROM orders o
      JOIN transaction_chains tc ON tc.id = o.chain_id
      WHERE o.side = 'SELL' AND o.status = 'FILLED'
        AND o.trigger_source != 'OVERSEAS'
        AND tc.is_paper = $1
        AND o.filled_price IS NOT NULL AND tc.avg_buy_price IS NOT NULL
        AND o.created_at >= NOW() - INTERVAL '60 days'
      GROUP BY day ORDER BY day ASC
    `,
      [isPaper],
    );
    // KOSPI 60일 차트 — Yahoo Finance ^KS11 (primary) → Naver Finance (fallback)
    const kospiPoints = await (async () => {
      // 1차: Yahoo Finance (VIX 조회에 이미 검증된 API)
      try {
        const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=90d', {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
        const json = (await res.json()) as any;
        const result = json?.chart?.result?.[0];
        const timestamps: number[] = result?.timestamp ?? [];
        const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
        if (timestamps.length === 0) throw new Error('빈 응답');
        const sorted = timestamps
          .map((ts, i) => ({
            date: new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, ''),
            price: closes[i] ?? 0,
          }))
          .filter((d) => d.price > 0)
          .sort((a, b) => a.date.localeCompare(b.date));
        const base = sorted[0]?.price ?? 0;
        return sorted.map((d) => ({ date: d.date, value: base > 0 ? ((d.price - base) / base) * 100 : 0 }));
      } catch {
        // 2차 fallback: Naver Finance (다양한 필드명 시도)
        const end = new Date();
        const start = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000);
        const fmt = (d: Date) => d.toISOString().split('T')[0].replace(/-/g, '');
        const url = `https://m.stock.naver.com/api/index/KOSPI/price?startTime=${fmt(start)}&endTime=${fmt(end)}&pageSize=70&type=DAYBYDAY`;
        const res2 = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        if (!res2.ok) return [];
        const data2 = (await res2.json()) as Record<string, unknown>[];
        if (!Array.isArray(data2)) return [];
        const sorted2 = data2
          .map((d: any) => ({
            date: String(d.localDate ?? d.bizdate ?? d.date ?? ''),
            price: Number(d.closePrice ?? d.endPrice ?? d.closingPrice ?? d.close ?? 0),
          }))
          .filter((d) => d.date && d.price > 0)
          .sort((a, b) => a.date.localeCompare(b.date));
        const base2 = sorted2[0]?.price ?? 0;
        return sorted2.map((d) => ({ date: d.date, value: base2 > 0 ? ((d.price - base2) / base2) * 100 : 0 }));
      }
    })().catch(() => [] as { date: string; value: number }[]);
    // 봇 누적수익률 (일별 합산)
    let cumPnl = 0;
    let cumCost = 0;
    const botPoints = pnlRows.map((r: any) => {
      cumPnl += Number(r.daily_pnl ?? 0);
      cumCost += Number(r.cost_basis ?? 0);
      return { date: String(r.day).slice(0, 10), value: cumCost > 0 ? (cumPnl / cumCost) * 100 : 0 };
    });
    return c.json({ bot: botPoints, kospi: kospiPoints });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
