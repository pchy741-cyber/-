/**
 * 통합 코파일럿 진단 — /review/copilot (정합성 + 리스크 + 액션)
 * 크로스오염 수정: viewIsPaper에 따라 KIS(live) 또는 DB(paper) 데이터 분리 사용
 */
import { Hono } from 'hono';
import { getKSTNow } from '../../../utils/time.js';

const app = new Hono();

/** KIS Position과 호환되는 통합 포지션 타입 */
interface CopilotPosition {
  stockCode: string;
  stockName: string;
  quantity: number;
  avgBuyPrice: number;
  evalAmount: number;
  profitLossPct: number;
}

app.get('/review/copilot', async (c) => {
  try {
    const { getPool } = await import('../../../db/client.js');
    const pool = getPool();

    const { resolveRequestMode } = await import('../../guards/live-pin.js');
    const viewIsPaper = resolveRequestMode(c);

    // ── 포지션 데이터 로드 (모드별 분리) ──
    let positions: CopilotPosition[] = [];
    let netAsset = 0;
    let cash = 0;

    if (!viewIsPaper) {
      // LIVE: KIS 실계좌 조회
      try {
        const { getAccountBalance } = await import('../../../kis/account.js');
        const bal = await getAccountBalance(true);
        positions = (bal.positions ?? []).map((p: any) => ({
          stockCode: p.stockCode,
          stockName: p.stockName ?? p.stockCode,
          quantity: p.quantity ?? 0,
          avgBuyPrice: p.avgBuyPrice ?? 0,
          evalAmount: p.evalAmount ?? 0,
          profitLossPct: p.profitLossPct ?? 0,
        }));
        netAsset = (bal as any).netAsset ?? 0;
        cash = bal.orderableCash ?? 0;
      } catch {}
    } else {
      // PAPER: DB에서 포지션 구성
      try {
        const { rows: chains } = await pool.query(`
          SELECT tc.stock_code, w.stock_name, tc.total_quantity, tc.avg_buy_price, tc.total_invested
          FROM transaction_chains tc
          LEFT JOIN watchlist w ON w.stock_code = tc.stock_code
          WHERE tc.status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND tc.is_paper = true`);
        positions = chains.map((r: any) => {
          const qty = Number(r.total_quantity) || 0;
          const avg = Number(r.avg_buy_price) || 0;
          const invested = Number(r.total_invested) || qty * avg;
          return {
            stockCode: r.stock_code,
            stockName: r.stock_name ?? r.stock_code,
            quantity: qty,
            avgBuyPrice: avg,
            evalAmount: invested, // paper는 현재가 없으므로 투자금 기준
            profitLossPct: 0,
          };
        });
        // paper 총자산은 최신 스냅샷에서
        const { rows: snap } = await pool.query(
          `SELECT total_value FROM portfolio_snapshots WHERE is_paper = true ORDER BY snapshot_at DESC LIMIT 1`,
        );
        if (snap.length > 0) {
          netAsset = Number(snap[0].total_value);
          const evalTotal = positions.reduce((s, p) => s + p.evalAmount, 0);
          cash = Math.max(0, netAsset - evalTotal);
        }
      } catch {}
    }

    // ── 1. 데이터 정합성 검증 ──
    const integrity: { id: string; status: 'ok' | 'warn' | 'danger'; label: string; detail: string }[] = [];

    // 1a. KIS↔DB 포지션 비교 (live만 의미 있음)
    if (!viewIsPaper) {
      try {
        const { rows: dbChains } = await pool.query(
          "SELECT stock_code, total_quantity FROM transaction_chains WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING') AND is_paper = $1",
          [viewIsPaper],
        );
        const dbMap = new Map(dbChains.map((r: any) => [r.stock_code, Number(r.total_quantity)]));
        const kisMap = new Map(positions.map((p) => [p.stockCode, p.quantity]));

        const mismatches: string[] = [];
        for (const [code, qty] of kisMap) {
          const dbQty = dbMap.get(code) ?? 0;
          if (Math.abs(qty - dbQty) >= 1) mismatches.push(`${code}: KIS ${qty}주 vs DB ${dbQty}주`);
        }
        for (const [code, qty] of dbMap) {
          if (!kisMap.has(code) && qty > 0) mismatches.push(`${code}: DB ${qty}주, KIS 없음`);
        }

        if (mismatches.length === 0) {
          integrity.push({
            id: 'kis_vs_db',
            status: 'ok',
            label: 'KIS↔DB 포지션',
            detail: `${positions.length}종목 일치`,
          });
        } else {
          integrity.push({
            id: 'kis_vs_db',
            status: 'danger',
            label: 'KIS↔DB 포지션 불일치',
            detail: mismatches.join(', '),
          });
        }
      } catch (e: any) {
        integrity.push({
          id: 'kis_vs_db',
          status: 'warn',
          label: 'KIS 잔고 조회 실패',
          detail: e.message?.slice(0, 80) ?? 'unknown',
        });
      }
    } else {
      // Paper: KIS 비교 불필요, DB 체인 상태만 표시
      integrity.push({
        id: 'kis_vs_db',
        status: 'ok',
        label: 'DB 포지션 (Paper)',
        detail: `${positions.length}종목 보유 중`,
      });
    }

    // 1b. 해외 현금 정합성 (모드별 분리) + 보유종목 현재가
    try {
      const { fetchExchangeRate } = await import('../../../automation/macro-data.js');
      const fxRate = await fetchExchangeRate();
      let osCashUsd = 0;
      let krwInfo = '';
      let syncAgo = '미동기화';

      if (!viewIsPaper) {
        // Live: KIS psamount API 실시간 조회 (DB 캐시 대신 직접)
        try {
          const { getOverseasBuyableAmount } = await import('../../../kis/overseas.js');
          const buyable = await getOverseasBuyableAmount();
          // buyable.usd = 외화 풀 주문가능 USD, buyable.maxUsd = 통합증거금 전체 USD
          // buyable.krw = 통합증거금 주문가능원화 (KIS 앱 표시값)
          if (buyable && (buyable.maxUsd > 0 || buyable.usd > 0 || (buyable.krw ?? 0) > 0)) {
            osCashUsd = buyable.maxUsd > 0 ? buyable.maxUsd : buyable.usd;
            const krwVal = buyable.krw ?? 0;
            krwInfo = krwVal > 0 ? ` (₩${Math.round(krwVal).toLocaleString()}, 외화$${buyable.usd.toFixed(0)})` : '';
            syncAgo = '실시간';
          }
        } catch {
          // KIS API 실패 시 DB 폴백
          const { rows: osState } = await pool.query("SELECT value, updated_at FROM overseas_state WHERE key = 'cash'");
          const osCashRaw = Number(osState[0]?.value ?? 0);
          const syncAt = osState[0]?.updated_at ? new Date(osState[0].updated_at) : null;
          syncAgo = syncAt ? `${Math.round((Date.now() - syncAt.getTime()) / 60000)}분전` : '미동기화';
          if (osCashRaw > 0) {
            osCashUsd = fxRate > 0 ? osCashRaw / fxRate : 0;
            krwInfo = ` (₩${Math.round(osCashRaw).toLocaleString()})`;
          }
        }
      } else {
        // Paper: orders 기반 결정론적 계산 (overseas_state['cash_paper']는 갱신 안 됨 → stale)
        const { computePaperCash } = await import('../../../scheduler/overseas/state.js');
        osCashUsd = await computePaperCash(fxRate);
        syncAgo = '실시간계산';
      }

      // 보유종목 현재가 조회 (병렬 — 순차 루프는 KIS 레이트리밋 + 타임아웃 유발)
      const { rows: holdingRows } = await pool.query(
        'SELECT stock_code, exchange, quantity, avg_price FROM overseas_holdings WHERE quantity > 0 AND is_paper = $1',
        [viewIsPaper],
      );
      const holdingCnt = holdingRows.length;
      let totalEval = 0;

      const { getOverseasPrice } = await import('../../../kis/overseas.js');
      const priceResults = await Promise.all(
        holdingRows.map(async (h: any) => {
          const code = h.stock_code;
          const qty = Number(h.quantity);
          const avgPx = Number(h.avg_price ?? 0);
          let curPx = avgPx;
          try {
            const px = await getOverseasPrice(code, h.exchange ?? 'NASDAQ');
            if (px?.currentPrice && px.currentPrice > 0) curPx = px.currentPrice;
          } catch {
            /* 시세 조회 실패 시 매입가 사용 */
          }
          return { code, qty, avgPx, curPx };
        }),
      );

      const holdingDetails: string[] = [];
      for (const { code, qty, avgPx, curPx } of priceResults) {
        const eval$ = curPx * qty;
        const pnl = avgPx > 0 ? ((curPx - avgPx) / avgPx) * 100 : 0;
        totalEval += eval$;
        holdingDetails.push(`${code} ${qty}주 @$${curPx.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%)`);
      }

      const modeLabel = viewIsPaper ? 'Paper' : 'Live';
      const totalAsset = osCashUsd + totalEval;
      const detail = `${modeLabel}: 현금$${osCashUsd.toFixed(0)}${krwInfo} + 평가$${totalEval.toFixed(0)} = 총$${totalAsset.toFixed(0)} [동기화:${syncAgo}]`;

      if (!viewIsPaper && osCashUsd > 5000 && holdingCnt === 0) {
        integrity.push({
          id: 'os_cash',
          status: 'warn',
          label: '해외 Live 현금 이상',
          detail: `$${osCashUsd.toFixed(0)} 잔고 있으나 보유종목 0 — 오염 가능성`,
        });
      } else {
        integrity.push({ id: 'os_cash', status: 'ok', label: `해외 자산 (${modeLabel})`, detail });
      }
      // 보유종목 상세
      if (holdingDetails.length > 0) {
        integrity.push({ id: 'os_holdings', status: 'ok', label: `해외 보유종목`, detail: holdingDetails.join(' | ') });
      }
    } catch {
      integrity.push({ id: 'os_cash', status: 'warn', label: '해외 데이터 조회 실패', detail: '-' });
    }

    // 1c. 주문-체인 정합성 (viewIsPaper 사용)
    try {
      const { rows: orphanOrders } = await pool.query(
        `
        SELECT COUNT(*) as cnt FROM orders
        WHERE chain_id IS NULL AND status = 'FILLED' AND side = 'BUY' AND trigger_source != 'OVERSEAS'
          AND created_at >= NOW() - INTERVAL '7 days' AND trading_mode IN ($1, CASE WHEN $1 = 'paper' THEN 'p_arch' ELSE $1 END)`,
        [viewIsPaper ? 'paper' : 'live'],
      );
      const orphans = Number(orphanOrders[0]?.cnt ?? 0);
      if (orphans > 0) {
        integrity.push({
          id: 'orphan_orders',
          status: 'warn',
          label: '미연결 주문',
          detail: `${orphans}건의 체인 미연결 매수 주문 (7일내)`,
        });
      } else {
        integrity.push({ id: 'orphan_orders', status: 'ok', label: '주문-체인 연결', detail: '정상' });
      }
    } catch {
      integrity.push({ id: 'orphan_orders', status: 'ok', label: '주문-체인', detail: '조회 실패' });
    }

    // ── 2. 리스크 레이더 ──
    const risk: {
      id: string;
      label: string;
      value: number;
      max: number;
      unit: string;
      level: 'ok' | 'warn' | 'danger';
      detail?: string;
    }[] = [];

    // 2a. 월간 MDD
    try {
      const monthStart = getKSTNow();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const { rows: snapRows } = await pool.query(
        `SELECT total_value FROM portfolio_snapshots WHERE snapshot_at >= $1 AND is_paper = $2 ORDER BY snapshot_at ASC`,
        [monthStart.toISOString(), viewIsPaper],
      );
      if (snapRows.length >= 2) {
        const values = snapRows.map((r: any) => Number(r.total_value));
        const peak = Math.max(...values);
        const latest = values[values.length - 1];
        const mddPct = peak > 0 ? ((peak - latest) / peak) * 100 : 0;
        const mddLimit = viewIsPaper ? 40 : 8;
        risk.push({
          id: 'mdd',
          label: '월간 MDD',
          value: Math.round(mddPct * 10) / 10,
          max: mddLimit,
          unit: '%',
          level: mddPct >= mddLimit ? 'danger' : mddPct >= mddLimit * 0.75 ? 'warn' : 'ok',
        });
      }
    } catch {}

    // 2b. 일일 손실한도 소진율 — Live 2.5% / Paper 30%
    try {
      const { calcDailyLossLimit } = await import('../../../risk/seed-capital.js');
      const totalPortfolioKrw =
        netAsset > 0 ? netAsset : cash + positions.reduce((s, p) => s + p.avgBuyPrice * p.quantity, 0);
      const limit = calcDailyLossLimit(totalPortfolioKrw, viewIsPaper);
      const evalKrw = positions.reduce((s, p) => s + p.evalAmount, 0);
      const investedKrw = positions.reduce((s, p) => s + p.avgBuyPrice * p.quantity, 0);
      const unrealizedLoss = Math.max(0, investedKrw - evalKrw);
      const usedPct = limit.limitAmount > 0 ? (unrealizedLoss / limit.limitAmount) * 100 : 0;
      risk.push({
        id: 'daily_loss',
        label: `손실한도(총자산${limit.pct}%)`,
        value: Math.round(usedPct),
        max: 100,
        unit: '%',
        level: usedPct >= 80 ? 'danger' : usedPct >= 50 ? 'warn' : 'ok',
        detail: `${Math.round(unrealizedLoss).toLocaleString()}원 / ${Math.round(limit.limitAmount).toLocaleString()}원 (총자산 ${Math.round(totalPortfolioKrw).toLocaleString()}원)`,
      });
    } catch {}

    // 2c. 현금 비율
    try {
      const totalVal = netAsset > 0 ? netAsset : cash;
      const evalAmt = positions.reduce((s, p) => s + p.evalAmount, 0);
      const cashRatio = Math.max(0, Math.min(100, totalVal > 0 ? ((totalVal - evalAmt) / totalVal) * 100 : 100));
      risk.push({
        id: 'cash_ratio',
        label: '현금 비율',
        value: Math.round(cashRatio),
        max: 100,
        unit: '%',
        level: cashRatio < 10 ? 'danger' : cashRatio < 25 ? 'warn' : 'ok',
      });
    } catch {}

    // 2d. 종목 집중도 (HHI)
    try {
      if (positions.length > 0) {
        const totalEval = positions.reduce((s, p) => s + p.evalAmount, 0);
        if (totalEval > 0) {
          const hhi = positions.reduce((s, p) => {
            const w = p.evalAmount / totalEval;
            return s + w * w;
          }, 0);
          const hhiPct = Math.round(hhi * 10000) / 100;
          risk.push({
            id: 'concentration',
            label: '집중도(HHI)',
            value: hhiPct,
            max: 100,
            unit: '%',
            level: hhiPct >= 50 ? 'danger' : hhiPct >= 30 ? 'warn' : 'ok',
          });
        }
      }
    } catch {}

    // 2e. 승률 (30일)
    try {
      const { rows: winRows } = await pool.query(
        `
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE realized_pnl > 0) as wins
        FROM transaction_chains
        WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '30 days' AND is_paper = $1`,
        [viewIsPaper],
      );
      const total = Number(winRows[0]?.total ?? 0);
      const wins = Number(winRows[0]?.wins ?? 0);
      if (total >= 3) {
        const winRate = Math.round((wins / total) * 100);
        risk.push({
          id: 'win_rate',
          label: '승률(30일)',
          value: winRate,
          max: 100,
          unit: '%',
          level: winRate < 30 ? 'danger' : winRate < 45 ? 'warn' : 'ok',
        });
      }
    } catch {}

    // 2f. 연속 손실
    try {
      const { rows: recentChains } = await pool.query(
        `
        SELECT realized_pnl FROM transaction_chains
        WHERE status = 'CLOSED' AND is_paper = $1
        ORDER BY closed_at DESC LIMIT 10`,
        [viewIsPaper],
      );
      let streak = 0;
      for (const r of recentChains) {
        if (Number(r.realized_pnl) < 0) streak++;
        else break;
      }
      if (streak >= 2) {
        risk.push({
          id: 'loss_streak',
          label: '연속 손실',
          value: streak,
          max: 5,
          unit: '회',
          level: streak >= 5 ? 'danger' : streak >= 3 ? 'warn' : 'ok',
        });
      }
    } catch {}

    // ── 3. 액션 제안 ──
    const actions: {
      type: 'cut_loss' | 'take_profit' | 'rebalance' | 'anomaly' | 'opportunity';
      icon: string;
      title: string;
      detail: string;
      urgency: 'high' | 'mid' | 'low';
    }[] = [];

    for (const pos of positions) {
      if (pos.profitLossPct <= -5) {
        actions.push({
          type: 'cut_loss',
          icon: '!!',
          title: `${pos.stockName} 손절 검토`,
          detail: `${pos.profitLossPct.toFixed(1)}% 손실 — 추가 하락 리스크 평가 필요`,
          urgency: pos.profitLossPct <= -10 ? 'high' : 'mid',
        });
      }
    }

    for (const pos of positions) {
      if (pos.profitLossPct >= 8) {
        actions.push({
          type: 'take_profit',
          icon: '$',
          title: `${pos.stockName} 익절 검토`,
          detail: `+${pos.profitLossPct.toFixed(1)}% 수익 — 일부 실현 고려`,
          urgency: pos.profitLossPct >= 15 ? 'high' : 'low',
        });
      }
    }

    const totalEval = positions.reduce((s, p) => s + p.evalAmount, 0);
    for (const pos of positions) {
      if (totalEval > 0) {
        const weight = (pos.evalAmount / totalEval) * 100;
        if (weight >= 40) {
          actions.push({
            type: 'rebalance',
            icon: '%',
            title: `${pos.stockName} 비중 ${weight.toFixed(0)}%`,
            detail: `단일 종목 40% 초과 — 리밸런싱 검토`,
            urgency: 'mid',
          });
        }
      }
    }

    try {
      const { rows: oldHoldings } = await pool.query(
        `
        SELECT stock_code, bought_at, quantity, avg_price FROM overseas_holdings
        WHERE quantity > 0 AND is_paper = $1 AND bought_at < NOW() - INTERVAL '21 days'`,
        [viewIsPaper],
      );
      for (const h of oldHoldings) {
        const days = Math.round((Date.now() - new Date(h.bought_at).getTime()) / 86400000);
        actions.push({
          type: 'anomaly',
          icon: '?',
          title: `${h.stock_code} ${days}일 보유 중`,
          detail: `해외 최대 보유기간(21일) 초과 — 정리 검토`,
          urgency: 'low',
        });
      }
    } catch {}

    try {
      if (totalEval > 0) {
        const stress5 = Math.round(totalEval * 0.05);
        const stress10 = Math.round(totalEval * 0.1);
        actions.push({
          type: 'opportunity',
          icon: 'S',
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
      mode: viewIsPaper ? 'paper' : 'live',
      integrity,
      risk,
      actions,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
