'use client';

import React from 'react';
import { fmtWon, pc } from '../lib/utils';

export function PnlBreakdownPanel({ chains, trades }: { chains: any[]; trades: any[] }) {
  const filled = trades.filter((t: any) => t.status === 'FILLED' && t.side === 'SELL');

  // 시세차익
  const swingPnl = filled.filter((t: any) => ['SWING','DEFENSE','SCALPING','SNIPER'].includes(t.trading_mode ?? '')).reduce((sum: number, t: any) => {
    const pnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
    if (pnl === null) {
      const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
      const fp = Number(t.filled_price) || 0; const qty = Number(t.quantity) || 0;
      return avgBuy > 0 ? sum + (fp - avgBuy) * qty : sum;
    }
    return sum + pnl;
  }, 0);

  // 배당 적립
  const dividendAccrual = chains.filter((c: any) => c.strategy_mode === 'DIVIDEND').reduce((sum: number, c: any) => {
    const dvd = Number(c.dividendYield ?? 0);
    const holdDays = Number(c.holdingDays ?? 0);
    const invested = Number(c.invested ?? 0) || (Number(c.avg_buy_price) * Number(c.total_quantity));
    return sum + (invested * (dvd / 365 / 100) * holdDays);
  }, 0);

  // 파킹 ETF 수익
  const parkingPnl = filled.filter((t: any) => t.stock_code === '333940').reduce((sum: number, t: any) => {
    const pnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : 0;
    return sum + pnl;
  }, 0);

  if (swingPnl === 0 && dividendAccrual === 0 && parkingPnl === 0) return null;
  const total = swingPnl + dividendAccrual + parkingPnl;

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2">수익 구조 분해</div>
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[9px] text-slate-500 mb-1">📈 시세차익</div>
          <div className={`text-sm font-black ${swingPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{swingPnl >= 0 ? '+' : ''}{fmtWon(swingPnl)}</div>
          <div className="text-[9px] text-slate-600 mt-0.5">SWING/DEFENSE</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[9px] text-slate-500 mb-1">🏦 배당적립</div>
          <div className={`text-sm font-black ${dividendAccrual >= 0 ? 'text-amber-400' : 'text-rose-400'}`}>+{fmtWon(dividendAccrual)}</div>
          <div className="text-[9px] text-slate-600 mt-0.5">DIVIDEND 모드</div>
        </div>
        <div className="bg-white/[0.03] rounded-xl p-2.5 text-center">
          <div className="text-[9px] text-slate-500 mb-1">🅿️ 파킹ETF</div>
          <div className={`text-sm font-black ${parkingPnl >= 0 ? 'text-blue-400' : 'text-rose-400'}`}>{parkingPnl >= 0 ? '+' : ''}{fmtWon(parkingPnl)}</div>
          <div className="text-[9px] text-slate-600 mt-0.5">333940 파킹</div>
        </div>
      </div>
      {total !== 0 && (
        <div className="mt-2 pt-2 border-t border-white/[0.04] flex justify-between text-[11px]">
          <span className="text-slate-500">합산 실현+적립</span>
          <span className={`font-bold ${total >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{total >= 0 ? '+' : ''}{fmtWon(total)}</span>
        </div>
      )}
    </div>
  );
}
