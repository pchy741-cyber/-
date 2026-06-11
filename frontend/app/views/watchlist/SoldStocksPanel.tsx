import React, { useState, useEffect } from 'react';
import { Panel, EmptyMsg } from '@/components/ui';
import { api } from '../../lib/utils';
import { toDisplayName } from '../../lib/helpers';

interface SoldStock {
  stock_code: string;
  stock_name: string;
  buy_price: number | null;
  sell_price: number;
  sell_date: string;
  sell_pnl_pct: number;
  realized_pnl: number | null;
  current_price: number;
  post_sell_pct: number | null;
  close_reason: string;
}

function formatRelativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  return `${Math.floor(days / 30)}개월 전`;
}

function SoldStocksPanel({ toast, onReAdd, viewMode = 'live' }: { toast: (msg: string) => void; onReAdd: () => void; viewMode?: string }) {
  const [soldStocks, setSoldStocks] = useState<SoldStock[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api(`/watchlist/sold-tracking?viewMode=${viewMode}`)
      .then((data) => setSoldStocks(Array.isArray(data) ? data : []))
      .catch(() => setSoldStocks([]))
      .finally(() => setLoading(false));
  }, [viewMode]);

  const handleReAdd = async (stock: SoldStock) => {
    try {
      await api('/watchlist', {
        method: 'POST',
        body: JSON.stringify({ stock_code: stock.stock_code, stock_name: stock.stock_name, market: 'KOSPI' }),
      });
      toast(`${toDisplayName(stock.stock_name, stock.stock_code)} 감시목록에 다시 추가`);
      onReAdd();
    } catch (err: unknown) {
      toast(`추가 실패: ${(err as Error).message}`);
    }
  };

  if (loading) {
    return (
      <Panel title="최근 매도 추적" badge="불러오는 중...">
        <div className="p-8 text-center">
          <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </Panel>
    );
  }

  if (soldStocks.length === 0) return null;

  return (
    <Panel title="최근 매도 추적" badge={`${soldStocks.length}종목`}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
        {soldStocks.map((s) => {
          const displayName = toDisplayName(s.stock_name, s.stock_code);
          const psp = s.post_sell_pct;
          const missedGain = psp != null && psp >= 5;
          const goodSell = psp != null && psp < 0;

          let cardBorder = 'border-white/[0.06]';
          if (missedGain) cardBorder = 'border-amber-500/20';
          else if (goodSell) cardBorder = 'border-sky-500/20';

          return (
            <div key={s.stock_code} className={`group relative rounded-xl border px-3 py-3 ${cardBorder}`}>
              <div className="flex items-start justify-between gap-1">
                <span className="font-bold text-[13px] truncate leading-tight">{displayName}</span>
                <span className="text-[9px] text-slate-600 shrink-0 mt-0.5">{formatRelativeDate(s.sell_date)}</span>
              </div>

              <div className="text-[10px] text-slate-500 mt-1">
                {s.buy_price != null
                  ? <>{s.buy_price.toLocaleString()} → <span className="text-slate-400">{s.sell_price.toLocaleString()}원</span></>
                  : <>매도가 {s.sell_price.toLocaleString()}원</>}
              </div>

              <div className="mt-1.5 flex flex-col gap-0.5">
                <div className={`text-[10px] font-medium ${s.sell_pnl_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {s.sell_pnl_pct >= 0 ? '+' : ''}{s.sell_pnl_pct.toFixed(1)}%
                  {s.realized_pnl != null && (
                    <span className="ml-1 text-[9px] opacity-70">
                      ({s.realized_pnl >= 0 ? '+' : ''}{Math.round(s.realized_pnl).toLocaleString()}원)
                    </span>
                  )}
                </div>
                <div className={`text-[11px] font-bold ${
                  psp == null ? 'text-slate-600' :
                  missedGain ? 'text-amber-400' : goodSell ? 'text-sky-400' : psp >= 0 ? 'text-amber-400/70' : 'text-sky-400/70'
                }`}>
                  {psp == null
                    ? '매도 후 추적중...'
                    : missedGain
                      ? `아쉽다 ↑+${psp.toFixed(1)}%`
                      : goodSell
                        ? `잘 팔았다 ↓${psp.toFixed(1)}%`
                        : psp >= 0
                          ? `매도 후 ↑+${psp.toFixed(1)}%`
                          : `매도 후 ↓${psp.toFixed(1)}%`}
                </div>
                {s.current_price > 0 && (
                  <div className="text-[10px] text-slate-600">
                    현재 {s.current_price.toLocaleString()}원
                  </div>
                )}
              </div>

              <button
                onClick={() => handleReAdd(s)}
                className="mt-2 w-full text-[10px] py-1 rounded-lg bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-slate-200 transition-colors">
                다시 추가
              </button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export default SoldStocksPanel;
