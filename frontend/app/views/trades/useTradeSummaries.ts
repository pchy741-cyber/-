import { useMemo } from 'react';
import type { Trade, DaySummary } from '../../types';

export function useTradeSummaries(filtered: Trade[], isOverseas: (t: Trade) => boolean) {
  return useMemo(() => {
    const groups = new Map<string, Trade[]>();
    for (const t of filtered) {
      const d = new Date(t.created_at);
      const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const dateKey = kst.toISOString().slice(0, 10);
      if (!groups.has(dateKey)) groups.set(dateKey, []);
      groups.get(dateKey)!.push(t);
    }

    const days: DaySummary[] = [];
    const weekNames = ['일', '월', '화', '수', '목', '금', '토'];
    for (const [date, dayTrades] of [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      const dt = new Date(date + 'T00:00:00+09:00');
      const label = `${date.slice(5)} (${weekNames[dt.getDay()]})`;
      const sellTrades = dayTrades.filter((t: Trade) => t.side === 'SELL');
      let pnl = 0;
      let pnlUsd = 0;
      let wins = 0;
      let losses = 0;

      for (const t of sellTrades) {
        const os = isOverseas(t);
        const chain = t.transaction_chains;
        const avgBuy = Number(chain?.avg_buy_price) || 0;
        const fillPrice = Number(t.filled_price) || 0;
        const qty = Number(t.filled_quantity ?? t.quantity) || 0;
        const apiPnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
        const apiPnlUsd = typeof t.realized_pnl_usd === 'number' ? Number(t.realized_pnl_usd) : null;
        const calcPnl = avgBuy > 0 && fillPrice > 0 ? (fillPrice - avgBuy) * qty : null;
        const tradePnl = os ? (apiPnlUsd ?? calcPnl) : (apiPnl ?? calcPnl);

        if (tradePnl !== null) {
          if (os) pnlUsd += tradePnl;
          else pnl += tradePnl;
          if (tradePnl > 0) wins++;
          else losses++;
        }
      }

      days.push({
        date,
        label,
        trades: dayTrades,
        buys: dayTrades.filter((t: Trade) => t.side === 'BUY').length,
        sells: sellTrades.length,
        realizedPnl: Math.round(pnl),
        realizedPnlUsd: Math.round(pnlUsd * 100) / 100,
        wins,
        losses,
        winRate: (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
      });
    }
    return days;
  }, [filtered]);
}
