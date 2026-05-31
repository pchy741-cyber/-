'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui';
import { api, pc } from '../lib/utils';

interface FuturesViewProps {
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  viewMode: 'paper' | 'live';
  confirm: (opts: { title: string; description?: string; confirmLabel?: string; confirmVariant?: 'danger' | 'primary' }) => Promise<boolean>;
  mpData?: any;
  onRefreshMp?: () => void;
}

const DEFAULT_FX = 1350;

const BUDGET_PRESETS = [
  { krw: 20000, label: '2만' },
  { krw: 30000, label: '3만' },
  { krw: 50000, label: '5만' },
  { krw: 100000, label: '10만' },
];

const PRODUCTS = [
  { code: 'MES', name: 'S&P 500', margin: 1500, leverage: '~20x' },
  { code: 'MNQ', name: 'Nasdaq 100', margin: 2000, leverage: '~20x' },
  { code: 'M2K', name: 'Russell 2000', margin: 800, leverage: '~25x' },
  { code: 'MGC', name: 'Gold', margin: 1000, leverage: '~15x' },
  { code: 'MCL', name: 'Crude Oil', margin: 700, leverage: '~20x' },
];

export default function FuturesView({ toast, viewMode, confirm, mpData, onRefreshMp }: FuturesViewProps) {
  const FX_RATE = mpData?.fx ?? DEFAULT_FX;
  const [loading, setLoading] = useState(true);
  const [depositing, setDepositing] = useState(false);
  const [budget, setBudget] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [customAmount, setCustomAmount] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dash = await api('/futures/dashboard');
      setBudget(dash.budget);
      setPositions(dash.positions || []);
      setTrades(dash.trades || []);
      setStats(dash.stats);
    } catch (e: any) { toast(e.message || '로딩 실패', 'err'); }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const handleDeposit = async (krw: number) => {
    if (!await confirm({
      title: `₩${krw.toLocaleString()} 선물 자동매매 입금`,
      description: `AI가 최적의 상품·레버리지·TP/SL을 자동 설정하고\n루프가 매매를 100% 자동 운영합니다.`,
      confirmLabel: '입금 시작',
      confirmVariant: 'primary',
    })) return;

    setDepositing(true);
    try {
      const res = await api('/futures/auto-deposit', {
        method: 'POST',
        body: JSON.stringify({ amount_krw: krw }),
      });
      if (res.ok) {
        toast(`선물 입금 완료: 총 ₩${res.totalAllocatedKrw.toLocaleString()}`, 'ok');
        load();
        onRefreshMp?.();
      } else {
        toast(res.error || '입금 실패', 'err');
      }
    } catch (e: any) { toast(e.message || '입금 실패', 'err'); }
    setDepositing(false);
  };

  if (loading) return <div className="p-8 text-center text-slate-500">로딩 중...</div>;

  const allocatedKrw = Number(budget?.allocatedKrw || 0);
  const totalPnl = Number(budget?.totalPnlUsd || 0);
  const openPnl = positions.reduce((s: number, p: any) => s + Number(p.pnl_usd || 0), 0);
  const totalTrades = Number(stats?.total_trades || 0);
  const wins = Number(stats?.wins || 0);
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const currentKrw = allocatedKrw + totalPnl * FX_RATE;
  const returnPct = allocatedKrw > 0 ? ((currentKrw / allocatedKrw) - 1) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* ── 입금 ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
        <div className="px-5 py-4 border-b border-white/[0.04]">
          <h2 className="text-sm font-bold text-slate-200">선물 자동매매</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">소액 입금 → AI가 최적 레버리지 · TP/SL 자동 설정 · 루프 자동 매매</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {BUDGET_PRESETS.map(p => (
              <button key={p.krw} onClick={() => handleDeposit(p.krw)} disabled={depositing}
                className="py-3 bg-white/[0.04] hover:bg-violet-500/10 ring-1 ring-white/[0.06] hover:ring-violet-500/30 rounded-xl text-sm font-bold text-slate-300 hover:text-violet-400 transition-all disabled:opacity-50">
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="number" min="10000" step="10000" placeholder="직접 입력 (원)"
              value={customAmount} onChange={e => setCustomAmount(e.target.value)}
              className="flex-1 bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
            />
            <Button variant="violet" size="md" disabled={depositing || !customAmount}
              onClick={() => customAmount && handleDeposit(Number(customAmount))}>
              {depositing ? '입금 중...' : '입금'}
            </Button>
          </div>
        </div>
      </div>

      {/* ── 실적 ── */}
      {allocatedKrw > 0 && (
        <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
          <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-200">실적</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400 font-medium">자동</span>
          </div>
          <div className="p-5">
            {/* 핵심 숫자 */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3.5 text-center">
                <div className="text-[9px] text-slate-500 mb-0.5">넣은 돈</div>
                <div className="text-base font-bold text-slate-200 tabular-nums">₩{allocatedKrw.toLocaleString()}</div>
              </div>
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3.5 text-center">
                <div className="text-[9px] text-slate-500 mb-0.5">현재</div>
                <div className={`text-base font-bold tabular-nums ${returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  ₩{Math.round(currentKrw).toLocaleString()}
                </div>
                <div className={`text-[10px] font-medium ${returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {returnPct >= 0 ? '+' : ''}{returnPct.toFixed(1)}%
                </div>
              </div>
            </div>

            {/* 통계 */}
            <div className="flex items-center justify-between bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl px-4 py-2.5 mb-4">
              <div className="text-center">
                <div className="text-[9px] text-slate-500">거래</div>
                <div className="text-xs font-bold text-slate-300 tabular-nums">{totalTrades}건</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] text-slate-500">승률</div>
                <div className={`text-xs font-bold tabular-nums ${winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>{winRate.toFixed(0)}%</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] text-slate-500">누적 PnL</div>
                <div className={`text-xs font-bold tabular-nums ${pc(totalPnl)}`}>${totalPnl.toFixed(2)}</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] text-slate-500">진행 중</div>
                <div className="text-xs font-bold text-slate-300 tabular-nums">{positions.length}건</div>
              </div>
            </div>

            {/* 오픈 포지션 */}
            {positions.length > 0 && (
              <div className={`ring-1 rounded-xl p-3 mb-3 ${openPnl >= 0 ? 'ring-emerald-500/20 bg-emerald-500/5' : 'ring-rose-500/20 bg-rose-500/5'}`}>
                {positions.map((p: any) => (
                  <div key={p.id} className="flex justify-between text-[10px] py-0.5">
                    <span className="text-slate-400">{p.symbol} <span className={p.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}>{p.side} {p.quantity}</span></span>
                    <span className={pc(Number(p.pnl_usd || 0))}>${Number(p.pnl_usd || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 최근 거래 */}
            {trades.length > 0 && (
              <div>
                <div className="text-[10px] text-slate-500 mb-1.5">최근 거래</div>
                <div className="space-y-0.5 max-h-32 overflow-y-auto">
                  {trades.slice(0, 10).map((t: any, i: number) => (
                    <div key={i} className="flex justify-between text-[10px] px-1 py-1 rounded hover:bg-white/[0.02]">
                      <span className="text-slate-400">{t.symbol} {t.side} {t.quantity}</span>
                      {t.pnl_usd != null && <span className={pc(Number(t.pnl_usd))}>${Number(t.pnl_usd).toFixed(2)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 상품 안내 ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40 p-4 space-y-2">
        <div className="text-xs font-bold text-slate-300">마이크로 선물 상품</div>
        {PRODUCTS.map(p => (
          <div key={p.code} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.02] transition-colors">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-200">{p.code}</span>
              <span className="text-[10px] text-slate-500">{p.name}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="text-slate-400">~${p.margin}</span>
              <span className="text-slate-600">{p.leverage}</span>
            </div>
          </div>
        ))}
        <p className="text-[9px] text-rose-400/50 text-center">* 레버리지 상품 — 원금 전액 손실 가능</p>
      </div>
    </div>
  );
}
