'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui';
import { api, pc, FALLBACK_FX_RATE } from '../lib/utils';

interface DividendViewProps {
  toast: (msg: string, type?: 'ok' | 'err' | 'info') => void;
  viewMode: 'paper' | 'live';
  confirm: (opts: { title: string; description?: string; confirmLabel?: string; confirmVariant?: 'danger' | 'primary' }) => Promise<boolean>;
  mpData?: any;
  onRefreshMp?: () => void;
}

const BUDGET_PRESETS = [
  { krw: 100000, label: '10만' },
  { krw: 300000, label: '30만' },
  { krw: 500000, label: '50만' },
  { krw: 1000000, label: '100만' },
];

const DEFAULT_FX = FALLBACK_FX_RATE;
const TAX_RATE = 0.154;

const DIVIDEND_ETFS = [
  { code: 'JEPQ', name: '나스닥 커버드콜', yield: 9.5, growth: 8, price: 55, freq: '월', risk: '중', tier: 'core' },
  { code: 'SPYI', name: 'S&P 콜스프레드', yield: 12.0, growth: 8, price: 30, freq: '월', risk: '중', tier: 'core' },
  { code: 'SCHD', name: '배당성장 우량주', yield: 3.5, growth: 12, price: 82, freq: '분기', risk: '낮음', tier: 'core' },
  { code: 'QQQI', name: '나스닥 콜스프레드', yield: 13.4, growth: 6, price: 26, freq: '월', risk: '중', tier: 'satellite' },
  { code: 'JEPI', name: 'S&P 커버드콜', yield: 7.5, growth: 5, price: 57, freq: '월', risk: '낮음', tier: 'satellite' },
  { code: 'O', name: '리얼티인컴 리츠', yield: 5.5, growth: 3, price: 58, freq: '월', risk: '낮음', tier: 'anchor' },
];

const REGIME_LABEL: Record<string, { text: string; color: string; desc: string }> = {
  CALM: { text: '안정', color: 'text-emerald-400 bg-emerald-500/15', desc: '성장 중심 배분' },
  STRESS: { text: '경계', color: 'text-amber-400 bg-amber-500/15', desc: '프리미엄 수확 모드' },
  CRISIS: { text: '위기', color: 'text-rose-400 bg-rose-500/15', desc: '방어 중심 배분' },
  UNKNOWN: { text: '-', color: 'text-slate-400 bg-slate-500/15', desc: '기본 배분' },
  FALLBACK: { text: '-', color: 'text-slate-400 bg-slate-500/15', desc: '기본 배분' },
};

const TIER_LABEL: Record<string, { text: string; color: string }> = {
  core: { text: 'Core', color: 'text-blue-400 bg-blue-500/10' },
  satellite: { text: 'Sat', color: 'text-violet-400 bg-violet-500/10' },
  anchor: { text: 'Anc', color: 'text-cyan-400 bg-cyan-500/10' },
};

export default function DividendView({ toast, viewMode, confirm, mpData, onRefreshMp }: DividendViewProps) {
  const [loading, setLoading] = useState(true);
  const [investing, setInvesting] = useState(false);
  const [holdings, setHoldings] = useState<any[]>([]);
  const [customAmount, setCustomAmount] = useState('');
  const [tunedWeights, setTunedWeights] = useState<Record<string, number> | null>(null);

  const div = mpData?.dividend;
  const strategy = mpData?.strategy;
  const FX_RATE = mpData?.fx ?? DEFAULT_FX;
  const regime = strategy?.regime || 'UNKNOWN';
  const regimeInfo = REGIME_LABEL[regime] || REGIME_LABEL.UNKNOWN;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [hold, alloc] = await Promise.all([
        api(`/dividend/holdings?viewMode=${viewMode}`),
        api(`/dividend/allocation-tuned?viewMode=${viewMode}`).catch(() => null),
      ]);
      setHoldings(hold.holdings || []);
      if (alloc?.weights) setTunedWeights(alloc.weights);
    } catch (e: any) { toast(e.message || '로딩 실패', 'err'); }
    setLoading(false);
  }, [viewMode, toast]);

  useEffect(() => { load(); }, [load]);

  const handleInvest = async (krw: number) => {
    if (!await confirm({
      title: `₩${krw.toLocaleString()} 배당 ETF 자동투자`,
      description: `6개 ETF (JEPQ·SPYI·SCHD·QQQI·JEPI·O)에 VIX 기반 최적 비중으로 자동 배분합니다.\nSmart DRIP: 매월 배당금은 비중 부족 ETF에 집중 재투자됩니다.`,
      confirmLabel: '투자 시작',
      confirmVariant: 'primary',
    })) return;

    setInvesting(true);
    try {
      const res = await api('/dividend/auto-invest', {
        method: 'POST',
        body: JSON.stringify({ amount_krw: krw, mode: viewMode }),
        timeout: 30000,
      });
      if (res.ok) {
        toast(`배당 투자 완료: $${res.totalInvested} (${res.etfs.length} ETF)`, 'ok');
        load();
        onRefreshMp?.();
      } else {
        toast(res.error || '투자 실패', 'err');
      }
    } catch (e: any) { toast(e.message || '투자 실패', 'err'); }
    setInvesting(false);
  };

  if (loading) return <div className="p-8 text-center text-slate-500">로딩 중...</div>;

  const investedKrw = div?.investedKrw ?? holdings.reduce((s: number, h: any) => s + Number(h.avg_price || 0) * Number(h.quantity || 0) * FX_RATE, 0);
  const currentUsd = div?.currentValueUsd ?? holdings.reduce((s: number, h: any) => s + Number(h.avg_price || 0) * Number(h.quantity || 0), 0);
  const divUsd = div?.dividendsUsd ?? holdings.reduce((s: number, h: any) => s + Number(h.total_dividends_received ?? 0), 0);
  const monthlyDiv = div?.monthlyDivUsd ?? 0;
  const returnPct = div?.returnPct ?? 0;
  const hasHoldings = holdings.length > 0;

  const activeWeights = tunedWeights || strategy?.activeWeights || null;

  return (
    <div className="space-y-5">
      {/* ── VIX 레짐 인디케이터 ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
        <div className="px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-bold text-slate-200">배당 전략</h2>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${regimeInfo.color}`}>
              VIX {regimeInfo.text}
            </span>
          </div>
          <span className="text-[10px] text-slate-500">{regimeInfo.desc}</span>
        </div>
        <div className="px-5 pb-4">
          <div className="flex gap-1.5">
            {['Core 55%', 'Satellite 35%', 'Anchor 10%'].map((t, i) => (
              <span key={t} className={`text-[9px] px-2 py-0.5 rounded-full ${
                i === 0 ? 'bg-blue-500/10 text-blue-400' :
                i === 1 ? 'bg-violet-500/10 text-violet-400' :
                'bg-cyan-500/10 text-cyan-400'
              }`}>{t}</span>
            ))}
          </div>
          <p className="text-[9px] text-slate-600 mt-2">
            Multi-Tier + VIX 동적 배분 · SPYI/QQQI 차세대 콜스프레드 · Smart DRIP 리밸런싱
          </p>
        </div>
      </div>

      {/* ── 투자 입금 ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
        <div className="px-5 py-4 border-b border-white/[0.04]">
          <h2 className="text-sm font-bold text-slate-200">배당 ETF 자동투자</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">금액만 넣으면 6개 ETF VIX 기반 배분 · Smart DRIP 자동 리밸런싱</p>
        </div>
        <div className="p-5 space-y-4">
          {/* 프리셋 버튼 */}
          <div className="grid grid-cols-4 gap-2">
            {BUDGET_PRESETS.map(p => (
              <button key={p.krw} onClick={() => handleInvest(p.krw)} disabled={investing}
                className="py-3 bg-white/[0.04] hover:bg-emerald-500/10 ring-1 ring-white/[0.06] hover:ring-emerald-500/30 rounded-xl text-sm font-bold text-slate-300 hover:text-emerald-400 transition-all disabled:opacity-50">
                {p.label}
              </button>
            ))}
          </div>
          {/* 직접 입력 */}
          <div className="flex gap-2">
            <input
              type="number" min="10000" step="10000" placeholder="직접 입력 (원)"
              value={customAmount} onChange={e => setCustomAmount(e.target.value)}
              className="flex-1 bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-all"
            />
            <Button variant="primary" size="md" disabled={investing || !customAmount}
              onClick={() => customAmount && handleInvest(Number(customAmount))}>
              {investing ? '투자 중...' : '투자'}
            </Button>
          </div>
          {activeWeights ? (
            <div className="text-[9px] text-center">
              <span className="text-cyan-400/70">VIX+실적 자동 조정: </span>
              <span className="text-slate-500">
                {Object.entries(activeWeights).map(([k, v]) => `${k} ${((v as number) * 100).toFixed(0)}%`).join(' · ')}
              </span>
            </div>
          ) : (
            <p className="text-[9px] text-slate-600 text-center">JEPQ 25% · SPYI 20% · SCHD 15% · QQQI 15% · JEPI 15% · O 10%</p>
          )}
        </div>
      </div>

      {/* ── 내 현황 (보유 시만) ── */}
      {hasHoldings && (
        <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
          <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-200">내 배당 현황</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">Smart DRIP</span>
          </div>
          <div className="p-5">
            {/* 핵심 숫자 */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3.5 text-center">
                <div className="text-[9px] text-slate-500 mb-0.5">투자금</div>
                <div className="text-base font-bold text-slate-200 tabular-nums">₩{Math.round(investedKrw).toLocaleString()}</div>
              </div>
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3.5 text-center">
                <div className="text-[9px] text-slate-500 mb-0.5">현재 가치</div>
                <div className={`text-base font-bold tabular-nums ${returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  ₩{Math.round(currentUsd * FX_RATE).toLocaleString()}
                </div>
                <div className={`text-[10px] font-medium ${returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {Number.isFinite(returnPct) ? `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%` : '-'}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3.5 text-center">
                <div className="text-[9px] text-slate-500 mb-0.5">받은 배당</div>
                <div className="text-sm font-bold text-emerald-400 tabular-nums">${Number.isFinite(divUsd) ? divUsd.toFixed(2) : '0.00'}</div>
              </div>
              <div className="bg-white/[0.03] ring-1 ring-white/[0.06] rounded-xl p-3.5 text-center">
                <div className="text-[9px] text-slate-500 mb-0.5">월 예상 배당</div>
                <div className="text-sm font-bold text-emerald-400 tabular-nums">₩{Math.round(monthlyDiv * FX_RATE).toLocaleString()}</div>
              </div>
            </div>

            {/* 보유 ETF 목록 */}
            <div className="divide-y divide-white/[0.03]">
              {holdings.map((h: any) => (
                <div key={h.stock_code} className="py-2 px-1 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-slate-200">{h.stock_code}</span>
                    <span className="text-[10px] text-slate-500 ml-1.5">{h.name || ''}</span>
                    <span className="text-[10px] text-slate-600 ml-1.5">{Number(h.quantity)}주</span>
                  </div>
                  <span className="text-xs font-bold text-emerald-400 tabular-nums">
                    ${Number(h.total_dividends_received || 0).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── ETF 유니버스 & 시뮬레이터 ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
        <div className="px-5 py-3.5 border-b border-white/[0.04]">
          <h2 className="text-sm font-bold text-slate-200">ETF 유니버스</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">배당 + 시세 + 복리 DRIP · 가중 수익률 ~9.5%</p>
        </div>
        <div className="p-5 space-y-3">
          <div className="space-y-1">
            {DIVIDEND_ETFS.map(etf => {
              const totalReturn = etf.yield + etf.growth;
              const monthlyKrw = 1000000 / FX_RATE * etf.yield / 100 * (1 - TAX_RATE) / 12 * FX_RATE;
              const tierInfo = TIER_LABEL[etf.tier] || TIER_LABEL.core;
              return (
                <div key={etf.code} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-white/[0.02] transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[8px] px-1 py-0.5 rounded font-bold ${tierInfo.color}`}>{tierInfo.text}</span>
                      <span className="text-xs font-bold text-slate-200">{etf.code}</span>
                      <span className="text-[10px] text-slate-500 truncate">{etf.name}</span>
                      <span className={`text-[9px] px-1 py-0.5 rounded ${etf.risk === '낮음' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>{etf.risk}</span>
                    </div>
                    <div className="text-[10px] text-slate-600 ml-7">
                      배당 {etf.yield}% + 시세 {etf.growth}% = <span className="text-slate-400 font-medium">{totalReturn}%</span>
                      {' · '}{etf.freq} · ${etf.price}
                    </div>
                  </div>
                  <div className="text-right ml-3">
                    <div className="text-xs font-bold text-emerald-400">₩{Math.round(monthlyKrw).toLocaleString()}/월</div>
                    <div className="text-[9px] text-slate-600">100만원 기준</div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[9px] text-slate-600 text-center">* 배당소득세 15.4% 차감 · 과거 실적 기반 추정 · SPYI/QQQI: 2025 최우수 ETF</p>
        </div>
      </div>

      {/* ── 혁신 전략 설명 ── */}
      <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40">
        <div className="px-5 py-3.5 border-b border-white/[0.04]">
          <h2 className="text-sm font-bold text-slate-200">혁신 전략 v2</h2>
        </div>
        <div className="p-5 space-y-3">
          <div className="space-y-2.5">
            <div className="flex items-start gap-2.5">
              <span className="text-blue-400 text-sm shrink-0 mt-0.5">1</span>
              <div>
                <div className="text-[11px] font-bold text-slate-300">VIX 동적 배분</div>
                <div className="text-[10px] text-slate-500">변동성 낮을 때 성장주, 높을 때 커버드콜 프리미엄 수확</div>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="text-violet-400 text-sm shrink-0 mt-0.5">2</span>
              <div>
                <div className="text-[11px] font-bold text-slate-300">Smart DRIP 리밸런싱</div>
                <div className="text-[10px] text-slate-500">배당금을 비중 부족 ETF에 집중 → 자동 포트폴리오 균형</div>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="text-emerald-400 text-sm shrink-0 mt-0.5">3</span>
              <div>
                <div className="text-[11px] font-bold text-slate-300">차세대 ETF (SPYI · QQQI)</div>
                <div className="text-[10px] text-slate-500">콜스프레드 전략 → JEPI/QYLD 대비 NAV 보존 + 상승 참여 우수</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
