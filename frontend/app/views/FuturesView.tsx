'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api, pc } from '../lib/utils';

interface FuturesViewProps {
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  viewMode: 'paper' | 'live';
}

const FX_RATE = 1350;

// 마이크로 선물 설명 (초보자용)
const PRODUCTS = [
  { code: 'MES', name: 'S&P 500', margin: 1500, desc: '미국 대표 500대 기업', leverage: '~20x' },
  { code: 'MNQ', name: 'Nasdaq 100', margin: 2000, desc: 'IT/기술주 중심', leverage: '~20x' },
  { code: 'M2K', name: 'Russell 2000', margin: 800, desc: '미국 중소형주', leverage: '~25x' },
  { code: 'MGC', name: 'Gold', margin: 1000, desc: '금 선물', leverage: '~15x' },
  { code: 'MCL', name: 'Crude Oil', margin: 700, desc: '원유 선물', leverage: '~20x' },
];

export default function FuturesView({ toast, viewMode }: FuturesViewProps) {
  const [loading, setLoading] = useState(true);
  const [budget, setBudget] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dash = await api('/futures/dashboard');
      setBudget(dash.budget);
      setPositions(dash.positions || []);
      setStats(dash.stats);
    } catch (e: any) { toast(e.message || '로딩 실패', 'err'); }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-8 text-center text-slate-500">로딩 중...</div>;

  const allocatedKrw = Number(budget?.allocatedKrw || 0);
  const totalPnl = Number(budget?.totalPnlUsd || 0);
  const openPnl = positions.reduce((s: number, p: any) => s + Number(p.pnl_usd || 0), 0);
  const openCount = positions.length;
  const totalTrades = Number(stats?.total_trades || 0);
  const wins = Number(stats?.wins || 0);
  const losses = Number(stats?.losses || 0);
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const budgetUsd = allocatedKrw / FX_RATE;

  return (
    <div className="space-y-5">
      {/* 핵심 요약 */}
      <div className="bg-slate-800/40 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">해외선물</h2>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${allocatedKrw > 0 ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-700/50 text-slate-500'}`}>
            {allocatedKrw > 0 ? 'Paper 자동' : '대기'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-900/40 rounded-xl p-4 text-center">
            <div className="text-[10px] text-slate-500 mb-1">예산</div>
            <div className="text-lg font-bold text-slate-100">
              {allocatedKrw > 0 ? `${allocatedKrw.toLocaleString()}원` : '미할당'}
            </div>
            <div className="text-[10px] text-slate-600 mt-0.5">
              {allocatedKrw > 0 ? `$${budgetUsd.toFixed(0)} · 격리 운영` : '설정에서 할당'}
            </div>
          </div>
          <div className="bg-slate-900/40 rounded-xl p-4 text-center">
            <div className="text-[10px] text-slate-500 mb-1">누적 수익</div>
            <div className={`text-lg font-bold ${pc(totalPnl)}`}>
              ${totalPnl.toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-600 mt-0.5">
              {totalTrades > 0 ? `${totalTrades}건 · 승률 ${winRate.toFixed(0)}%` : '거래 없음'}
            </div>
          </div>
        </div>

        {/* 진행 중 포지션 */}
        {openCount > 0 && (
          <div className={`rounded-xl p-3 border ${openPnl >= 0 ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-rose-500/5 border-rose-500/10'}`}>
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-slate-500">진행 중 {openCount}건</span>
              <span className={`text-sm font-bold ${pc(openPnl)}`}>${openPnl.toFixed(2)}</span>
            </div>
            <div className="mt-2 space-y-1">
              {positions.map((p: any) => (
                <div key={p.id} className="flex justify-between text-[10px]">
                  <span className="text-slate-400">
                    {p.symbol}
                    <span className={`ml-1 ${p.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {p.side} {p.quantity}
                    </span>
                  </span>
                  <span className={pc(Number(p.pnl_usd || 0))}>${Number(p.pnl_usd || 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 수익률 바 */}
        {allocatedKrw > 0 && totalTrades > 0 && (
          <div>
            <div className="flex justify-between text-[10px] text-slate-500 mb-1">
              <span>수익률</span>
              <span className={pc(totalPnl)}>
                {((totalPnl / budgetUsd) * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${totalPnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
                style={{ width: `${Math.min(100, Math.abs(totalPnl / budgetUsd) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 상품 안내 (초보자용) */}
      <div className="bg-slate-800/40 rounded-2xl p-4 space-y-3">
        <div className="text-xs font-bold text-slate-300">50만원으로 거래 가능한 상품</div>
        <div className="space-y-1.5">
          {PRODUCTS.map(p => {
            const affordable = (500000 / FX_RATE) >= p.margin;
            return (
              <div key={p.code} className={`flex items-center justify-between py-2 px-2 rounded-lg ${affordable ? '' : 'opacity-40'}`}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-200">{p.code}</span>
                    <span className="text-[10px] text-slate-500">{p.name}</span>
                  </div>
                  <div className="text-[10px] text-slate-600">{p.desc}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-400">~${p.margin}</div>
                  <div className="text-[9px] text-slate-600">{p.leverage}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="text-[9px] text-center space-y-0.5">
          <div className="text-rose-400/50">* 레버리지 상품 — 원금 전액 손실 가능</div>
          <div className="text-slate-600">* Paper 모드에서 모의 거래로 수익률 먼저 확인</div>
        </div>
      </div>
    </div>
  );
}
