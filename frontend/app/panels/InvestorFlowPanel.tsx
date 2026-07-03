'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import { api } from '../lib/utils';

interface InvestorFlowItem {
  stock_code: string;
  stock_name: string;
  trend: string;
  foreignStreak: number;
  foreignNet: number;
  institutionNet: number;
}

const TREND_META: Record<string, { color: string; label: string }> = {
  STRONG_BUY:  { color: 'text-emerald-300', label: '강매수' },
  BUY:         { color: 'text-emerald-400', label: '매수' },
  NEUTRAL:     { color: 'text-slate-400',   label: '관망' },
  SELL:        { color: 'text-rose-400',    label: '매도' },
  STRONG_SELL: { color: 'text-rose-300',    label: '강매도' },
};

function InvestorFlowPanel() {
  const [items, setItems] = React.useState<InvestorFlowItem[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    api('/market/investor-flow', { timeout: 30000 })
      .then((d: Record<string, unknown>) => setItems((d.items as InvestorFlowItem[]) ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const top = items.filter((it) => it.trend === 'STRONG_BUY' || it.trend === 'BUY').slice(0, 5);
  const warn = items.filter((it) => it.trend === 'STRONG_SELL' || it.trend === 'SELL').slice(0, 3);

  return (
    <Panel title="외국인·기관 수급" badge={items.length > 0 ? `${items.length}종목` : undefined}>
      {loading ? (
        <div className="px-4 py-6 text-center text-xs text-slate-500 animate-pulse">수급 데이터 불러오는 중...</div>
      ) : items.length === 0 ? (
        <div className="px-4 py-4 text-center text-xs text-slate-500">감시종목이 없거나 장중에만 조회 가능</div>
      ) : (
        <div className="divide-y divide-slate-800/30">
          {top.length > 0 && (
            <div className="px-4 py-2">
              <p className="text-[10px] text-slate-500 mb-2 font-semibold tracking-wide uppercase">순매수 우위</p>
              <div className="space-y-2">
                {top.map((it) => {
                  const meta = TREND_META[it.trend] ?? TREND_META.NEUTRAL;
                  const streak = it.foreignStreak;
                  return (
                    <div key={it.stock_code} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-semibold text-slate-200 truncate">{it.stock_name}</span>
                        {streak !== 0 && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${streak > 0 ? 'bg-emerald-900/40 text-emerald-400' : 'bg-rose-900/40 text-rose-400'}`}>
                            외국인 {streak > 0 ? '+' : ''}{streak}일
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-right">
                        <div className="text-[10px] text-slate-500">
                          <span>외 {it.foreignNet > 0 ? '+' : ''}{it.foreignNet.toLocaleString()}</span>
                          <span className="mx-1 text-slate-700">|</span>
                          <span>기 {it.institutionNet > 0 ? '+' : ''}{it.institutionNet.toLocaleString()}</span>
                        </div>
                        <span className={`text-[11px] font-bold ${meta.color}`}>{meta.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {warn.length > 0 && (
            <div className="px-4 py-2">
              <p className="text-[10px] text-rose-500 mb-2 font-semibold tracking-wide uppercase">순매도 주의</p>
              <div className="space-y-2">
                {warn.map((it) => {
                  const meta = TREND_META[it.trend] ?? TREND_META.NEUTRAL;
                  return (
                    <div key={it.stock_code} className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-400 truncate">{it.stock_name}</span>
                      <div className="flex items-center gap-3 shrink-0 text-right">
                        <div className="text-[10px] text-slate-500">
                          <span>외 {it.foreignNet > 0 ? '+' : ''}{it.foreignNet.toLocaleString()}</span>
                          <span className="mx-1 text-slate-700">|</span>
                          <span>기 {it.institutionNet > 0 ? '+' : ''}{it.institutionNet.toLocaleString()}</span>
                        </div>
                        <span className={`text-[11px] font-bold ${meta.color}`}>{meta.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

export default React.memo(InvestorFlowPanel);
