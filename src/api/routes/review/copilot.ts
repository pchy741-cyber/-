/**
 * 통합 코파일럿 진단 — /review/copilot (정합성 + 리스크 + 액션)
 */
import { Hono } from 'hono';

const app = new Hono();

app.get('/review/copilot', async (c) => {
  try {
    const { getPool } = await import('../../../db/client.js');
    const { config, baseIsPaper } = await import('../../../config/index.js');
    const pool = getPool();

    // ── 1. 데이터 정합성 검증 ──
    const integrity: { id: string; status: 'ok' | 'warn' | 'danger'; label: string; detail: string }[] = [];

    // 1a. KIS 실계좌 vs DB 포지션 비교
    let kisPositions: any[] = [];
    let kisNetAsset = 0;
    let kisCash = 0;
    try {
      const { getAccountBalance } = await import('../../../kis/account.js');
      const bal = await getAccountBalance(true);
      kisPositions = bal.positions ?? [];
      kisNetAsset = (bal as any).netAsset ?? 0;
      kisCash = bal.orderableCash ?? 0;

      const { rows: dbChains } = await pool.query(
        "SELECT stock_code, total_quantity FROM transaction_chains WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND is_paper = false");
      const dbMap = new Map(dbChains.map((r: any) => [r.stock_code, Number(r.total_quantity)]));
      const kisMap = new Map(kisPositions.map((p: any) => [p.stockCode, p.quantity]));

      const mismatches: string[] = [];
      for (const [code, qty] of kisMap) {
        const dbQty = dbMap.get(code) ?? 0;
        if (Math.abs(qty - dbQty) >= 1) mismatches.push(`${code}: KIS ${qty}주 vs DB ${dbQty}주`);
      }
      for (const [code, qty] of dbMap) {
        if (!kisMap.has(code) && qty > 0) mismatches.push(`${code}: DB ${qty}주, KIS 없음`);
      }

      if (mismatches.length === 0) {
        integrity.push({ id: 'kis_vs_db', status: 'ok', label: 'KIS↔DB 포지션', detail: `${kisPositions.length}종목 일치` });
      } else {
        integrity.push({ id: 'kis_vs_db', status: 'danger', label: 'KIS↔DB 포지션 불일치', detail: mismatches.join(', ') });
      }
    } catch (e: any) {
      integrity.push({ id: 'kis_vs_db', status: 'warn', label: 'KIS 잔고 조회 실패', detail: e.message?.slice(0, 80) ?? 'unknown' });
    }

    // 1b. 해외 현금 정합성
    try {
      const { rows: osState } = await pool.query("SELECT key, value FROM overseas_state WHERE key IN ('cash', 'cash_paper')");
      const osMap = new Map(osState.map((r: any) => [r.key, Number(r.value)]));
      const liveCash = osMap.get('cash') ?? 0;
      const paperCash = osMap.get('cash_paper') ?? 0;
      const { rows: liveH } = await pool.query("SELECT COUNT(*) as cnt FROM overseas_holdings WHERE quantity > 0 AND is_paper = false");
      const { rows: paperH } = await pool.query("SELECT COUNT(*) as cnt FROM overseas_holdings WHERE quantity > 0 AND is_paper = true");

      const detail = `Live: $${liveCash.toFixed(0)} (${Number(liveH[0]?.cnt)}종목) / Paper: $${paperCash.toFixed(0)} (${Number(paperH[0]?.cnt)}종목)`;
      if (liveCash > 5000 && Number(liveH[0]?.cnt) === 0) {
        integrity.push({ id: 'os_cash', status: 'warn', label: '해외 Live 현금 이상', detail: `$${liveCash.toFixed(0)} 잔고 있으나 보유종목 0 — 오염 가능성` });
      } else {
        integrity.push({ id: 'os_cash', status: 'ok', label: '해외 현금 정합성', detail });
      }
    } catch {
      integrity.push({ id: 'os_cash', status: 'warn', label: '해외 데이터 조회 실패', detail: '-' });
    }

    // 1c. 주문-체인 정합성
    try {
      const { rows: orphanOrders } = await pool.query(`
        SELECT COUNT(*) as cnt FROM orders
        WHERE chain_id IS NULL AND status = 'FILLED' AND side = 'BUY' AND trigger_source != 'OVERSEAS'
          AND created_at >= NOW() - INTERVAL '7 days' AND trading_mode = $1`, [baseIsPaper ? 'paper' : 'live']);
      const orphans = Number(orphanOrders[0]?.cnt ?? 0);
      if (orphans > 0) {
        integrity.push({ id: 'orphan_orders', status: 'warn', label: '미연결 주문', detail: `${orphans}건의 체인 미연결 매수 주문 (7일내)` });
      } else {
        integrity.push({ id: 'orphan_orders', status: 'ok', label: '주문-체인 연결', detail: '정상' });
      }
    } catch {
      integrity.push({ id: 'orphan_orders', status: 'ok', label: '주문-체인', detail: '조회 실패' });
    }

    // ── 2. 리스크 레이더 ──
    const risk: { id: string; label: string; value: number; max: number; unit: string; level: 'ok' | 'warn' | 'danger' }[] = [];

    // 2a. 월간 MDD
    try {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const { rows: snapRows } = await pool.query(
        `SELECT total_value FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2 ORDER BY snapshot_at ASC`,
        [monthStart.toISOString(), config.isPaper]);
      if (snapRows.length >= 2) {
        const values = snapRows.map((r: any) => Number(r.total_value));
        const peak = Math.max(...values);
        const latest = values[values.length - 1];
        const mddPct = peak > 0 ? ((peak - latest) / peak) * 100 : 0;
        const mddLimit = baseIsPaper ? 40 : 8;
        risk.push({
          id: 'mdd', label: '월간 MDD', value: Math.round(mddPct * 10) / 10, max: mddLimit, unit: '%',
          level: mddPct >= mddLimit ? 'danger' : mddPct >= mddLimit * 0.75 ? 'warn' : 'ok',
        });
      }
    } catch {}

    // 2b. 일일 손실한도 소진율 — 총자산의 30%
    try {
      const { calcDailyLossLimit } = await import('../../../risk/seed-capital.js');
      const totalPortfolioKrw = kisNetAsset > 0 ? kisNetAsset : (kisCash + kisPositions.reduce((s: number, p: any) => s + ((p.avgBuyPrice ?? 0) * (p.quantity ?? 0)), 0));
      const limit = calcDailyLossLimit(totalPortfolioKrw);
      const evalKrw = kisPositions.reduce((s: number, p: any) => s + (p.evalAmount ?? 0), 0);
      const investedKrw = kisPositions.reduce((s: number, p: any) => s + ((p.avgBuyPrice ?? 0) * (p.quantity ?? 0)), 0);
      const unrealizedLoss = Math.max(0, investedKrw - evalKrw);
      const usedPct = limit.limitAmount > 0 ? (unrealizedLoss / limit.limitAmount) * 100 : 0;
      risk.push({
        id: 'daily_loss', label: `손실한도(총자산${limit.pct}%)`, value: Math.round(usedPct), max: 100, unit: '%',
        level: usedPct >= 80 ? 'danger' : usedPct >= 50 ? 'warn' : 'ok',
        detail: `${Math.round(unrealizedLoss).toLocaleString()}원 / ${Math.round(limit.limitAmount).toLocaleString()}원 (총자산 ${Math.round(totalPortfolioKrw).toLocaleString()}원)`,
      } as any);
    } catch {}

    // 2c. 현금 비율
    try {
      const totalVal = kisNetAsset > 0 ? kisNetAsset : kisCash;
      const evalAmt = kisPositions.reduce((s: number, p: any) => s + (p.evalAmount ?? 0), 0);
      const cashRatio = totalVal > 0 ? ((totalVal - evalAmt) / totalVal) * 100 : 100;
      risk.push({
        id: 'cash_ratio', label: '현금 비율', value: Math.round(cashRatio), max: 100, unit: '%',
        level: cashRatio < 10 ? 'danger' : cashRatio < 25 ? 'warn' : 'ok',
      });
    } catch {}

    // 2d. 종목 집중도 (HHI)
    try {
      if (kisPositions.length > 0) {
        const totalEval = kisPositions.reduce((s: number, p: any) => s + (p.evalAmount ?? 0), 0);
        if (totalEval > 0) {
          const hhi = kisPositions.reduce((s: number, p: any) => {
            const w = (p.evalAmount ?? 0) / totalEval;
            return s + w * w;
          }, 0);
          const hhiPct = Math.round(hhi * 10000) / 100;
          risk.push({
            id: 'concentration', label: '집중도(HHI)', value: hhiPct, max: 100, unit: '%',
            level: hhiPct >= 50 ? 'danger' : hhiPct >= 30 ? 'warn' : 'ok',
          });
        }
      }
    } catch {}

    // 2e. 승률 (30일)
    try {
      const { rows: winRows } = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE realized_pnl > 0) as wins
        FROM transaction_chains
        WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '30 days' AND is_paper = $1`,
        [baseIsPaper]);
      const total = Number(winRows[0]?.total ?? 0);
      const wins = Number(winRows[0]?.wins ?? 0);
      if (total >= 3) {
        const winRate = Math.round((wins / total) * 100);
        risk.push({
          id: 'win_rate', label: '승률(30일)', value: winRate, max: 100, unit: '%',
          level: winRate < 30 ? 'danger' : winRate < 45 ? 'warn' : 'ok',
        });
      }
    } catch {}

    // 2f. 연속 손실
    try {
      const { rows: recentChains } = await pool.query(`
        SELECT realized_pnl FROM transaction_chains
        WHERE status = 'CLOSED' AND is_paper = $1
        ORDER BY closed_at DESC LIMIT 10`, [baseIsPaper]);
      let streak = 0;
      for (const r of recentChains) {
        if (Number(r.realized_pnl) < 0) streak++;
        else break;
      }
      if (streak >= 2) {
        risk.push({
          id: 'loss_streak', label: '연속 손실', value: streak, max: 5, unit: '회',
          level: streak >= 5 ? 'danger' : streak >= 3 ? 'warn' : 'ok',
        });
      }
    } catch {}

    // ── 3. 액션 제안 ──
    const actions: { type: 'cut_loss' | 'take_profit' | 'rebalance' | 'anomaly' | 'opportunity'; icon: string; title: string; detail: string; urgency: 'high' | 'mid' | 'low' }[] = [];

    for (const pos of kisPositions) {
      const pnlPct = pos.profitLossPct ?? 0;
      if (pnlPct <= -5) {
        actions.push({
          type: 'cut_loss', icon: '!!', title: `${pos.stockName ?? pos.stockCode} 손절 검토`,
          detail: `${pnlPct.toFixed(1)}% 손실 — 추가 하락 리스크 평가 필요`,
          urgency: pnlPct <= -10 ? 'high' : 'mid',
        });
      }
    }

    for (const pos of kisPositions) {
      const pnlPct = pos.profitLossPct ?? 0;
      if (pnlPct >= 8) {
        actions.push({
          type: 'take_profit', icon: '$', title: `${pos.stockName ?? pos.stockCode} 익절 검토`,
          detail: `+${pnlPct.toFixed(1)}% 수익 — 일부 실현 고려`,
          urgency: pnlPct >= 15 ? 'high' : 'low',
        });
      }
    }

    const totalEval = kisPositions.reduce((s: number, p: any) => s + (p.evalAmount ?? 0), 0);
    for (const pos of kisPositions) {
      if (totalEval > 0) {
        const weight = ((pos.evalAmount ?? 0) / totalEval) * 100;
        if (weight >= 40) {
          actions.push({
            type: 'rebalance', icon: '%', title: `${pos.stockName ?? pos.stockCode} 비중 ${weight.toFixed(0)}%`,
            detail: `단일 종목 40% 초과 — 리밸런싱 검토`,
            urgency: 'mid',
          });
        }
      }
    }

    try {
      const { rows: oldHoldings } = await pool.query(`
        SELECT stock_code, bought_at, quantity, avg_price FROM overseas_holdings
        WHERE quantity > 0 AND is_paper = $1 AND bought_at < NOW() - INTERVAL '21 days'`,
        [baseIsPaper]);
      for (const h of oldHoldings) {
        const days = Math.round((Date.now() - new Date(h.bought_at).getTime()) / 86400000);
        actions.push({
          type: 'anomaly', icon: '?', title: `${h.stock_code} ${days}일 보유 중`,
          detail: `해외 최대 보유기간(21일) 초과 — 정리 검토`,
          urgency: 'low',
        });
      }
    } catch {}

    try {
      const totalEval = kisPositions.reduce((s: number, p: any) => s + (p.evalAmount ?? 0), 0);
      if (totalEval > 0) {
        const stress5 = Math.round(totalEval * 0.05);
        const stress10 = Math.round(totalEval * 0.10);
        actions.push({
          type: 'opportunity', icon: 'S',
          title: '스트레스 시나리오',
          detail: `시장 -5%: -${(stress5 / 10000).toFixed(1)}만원 / -10%: -${(stress10 / 10000).toFixed(1)}만원`,
          urgency: 'low',
        });
      }
    } catch {}

    const urgencyOrder = { high: 0, mid: 1, low: 2 };
    actions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    return c.json({
      timestamp: new Date().toISOString(),
      mode: baseIsPaper ? 'paper' : 'live',
      integrity,
      risk,
      actions,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
