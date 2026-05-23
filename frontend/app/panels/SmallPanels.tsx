'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import { api, fmt, fmtWon, fmtPct, pc, pbg } from '../lib/utils';

// ═══════════════════════════════════════
// ARC GAUGE
// ═══════════════════════════════════════

export function ArcGauge({ pct, color, label, sub }: { pct: number; color: string; label: string; sub: string }) {
  const r = 28; const cx = 36; const cy = 36;
  const circ = Math.PI * r; // half-circle
  const clamped = Math.max(0, Math.min(100, pct));
  const stroke = (clamped / 100) * circ;
  const trackColor = 'rgba(255,255,255,0.05)';
  const colorMap: Record<string, string> = {
    emerald: '#10b981', blue: '#3b82f6', amber: '#f59e0b', rose: '#f43f5e',
  };
  const strokeColor = colorMap[color] ?? colorMap.blue;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="72" height="44" viewBox="0 0 72 44">
        {/* track */}
        <path d={`M 8 36 A ${r} ${r} 0 0 1 64 36`} fill="none" stroke={trackColor} strokeWidth="6" strokeLinecap="round" />
        {/* fill */}
        <path d={`M 8 36 A ${r} ${r} 0 0 1 64 36`} fill="none" stroke={strokeColor} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${stroke} ${circ}`} style={{ transition: 'stroke-dasharray 0.6s ease' }} />
        <text x="36" y="34" textAnchor="middle" fontSize="11" fontWeight="700" fill="white">{clamped}%</text>
      </svg>
      <div className="text-[10px] font-semibold text-slate-300 text-center leading-tight">{label}</div>
      <div className="text-[9px] text-slate-600 text-center">{sub}</div>
    </div>
  );
}

// ═══════════════════════════════════════
// SCORE BAR
// ═══════════════════════════════════════

export function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', violet: 'bg-violet-500',
  };
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <div className="w-14 text-slate-500 shrink-0 text-right">{label}</div>
      <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colorMap[color] ?? colorMap.blue}`} style={{ width: `${Math.max(0, Math.min(100, value))}%`, transition: 'width 0.5s ease' }} />
      </div>
      <div className="w-7 text-right text-slate-400 font-semibold">{Math.round(value)}</div>
    </div>
  );
}

// ═══════════════════════════════════════
// RISK GAUGE PANEL
// ═══════════════════════════════════════

export function RiskGaugePanel({ investedPct, dailyLossPct, concentrationPct }: { investedPct: number; dailyLossPct: number; concentrationPct: number }) {
  const investedColor = investedPct > 75 ? 'rose' : investedPct > 50 ? 'amber' : 'emerald';
  const lossColor = dailyLossPct > 70 ? 'rose' : dailyLossPct > 40 ? 'amber' : 'emerald';
  const concColor = concentrationPct > 50 ? 'rose' : concentrationPct > 30 ? 'amber' : 'blue';
  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2">리스크 게이지</div>
      <div className="flex items-end justify-around gap-2">
        <ArcGauge pct={Math.round(investedPct)} color={investedColor} label="투자 비중" sub="한도 80%" />
        <ArcGauge pct={Math.round(dailyLossPct)} color={lossColor} label="손실 소진" sub="일일 한도" />
        <ArcGauge pct={Math.round(concentrationPct)} color={concColor} label="종목 집중도" sub="단일 최대" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// STRATEGY TIMELINE PANEL
// ═══════════════════════════════════════

export function StrategyTimelinePanel({ strategy }: { strategy: any }) {
  const [history, setHistory] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/strategy/history').then((r: any) => { if (Array.isArray(r)) setHistory(r.slice(0, 10)); }).catch(() => {});
  }, []);

  const modeColor: Record<string, string> = {
    SWING: 'bg-emerald-500/70 text-emerald-100',
    DEFENSE: 'bg-rose-500/70 text-rose-100',
    DIVIDEND: 'bg-amber-500/70 text-amber-100',
    SCALPING: 'bg-purple-500/70 text-purple-100',
    SNIPER: 'bg-orange-500/70 text-orange-100',
  };
  const currentMode = strategy?.mode ?? 'SWING';
  const currentColor = modeColor[currentMode] ?? 'bg-slate-500/70 text-slate-100';

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold text-slate-400">전략 모드 이력 (7일)</span>
        <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${currentColor}`}>{currentMode} 진행 중</span>
      </div>
      {history.length === 0 ? (
        <div className="text-[10px] text-slate-600 py-1">전략 전환 없음 — 안정 운영 중</div>
      ) : (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {history.slice().reverse().map((ev: any, i: number) => {
            const fromC = (modeColor[ev.from] ?? 'bg-slate-500/50 text-slate-300').split(' ');
            const toC = (modeColor[ev.to] ?? 'bg-slate-500/50 text-slate-300').split(' ');
            return (
              <div key={i} className="flex items-center gap-1 text-[9px] bg-white/[0.03] rounded-lg px-2 py-1">
                <span className={`px-1.5 py-0.5 rounded ${fromC[0]} ${fromC[1]}`}>{ev.from}</span>
                <span className="text-slate-600">→</span>
                <span className={`px-1.5 py-0.5 rounded ${toC[0]} ${toC[1]}`}>{ev.to}</span>
                <span className="text-slate-700 ml-1">{new Date(ev.ts).toLocaleDateString('ko', { month:'numeric', day:'numeric' })}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// TAX ESTIMATE PANEL
// ═══════════════════════════════════════

export function TaxEstimatePanel({ viewMode = 'live' }: { viewMode?: string }) {
  const [data, setData] = React.useState<any>(null);
  React.useEffect(() => {
    api(`/market/tax-estimate?viewMode=${viewMode}`).then(setData).catch(() => {});
  }, [viewMode]);
  if (!data) return null;
  return (
    <Panel title={`${data.year}년 세금 추정`}>
      <div className="px-4 pb-3 grid grid-cols-2 gap-2">
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">거래세 (0.23%)</p>
          <p className="text-sm font-bold text-amber-400">{Math.round(data.transactionTax).toLocaleString()}원</p>
        </div>
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">순실현손익</p>
          <p className={`text-sm font-bold ${pc(data.netGain)}`}>{data.netGain > 0 ? '+' : ''}{Math.round(data.netGain).toLocaleString()}원</p>
        </div>
        <div className="bg-slate-800/40 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">총 매도금액</p>
          <p className="text-sm font-bold text-slate-200">{Math.round(data.totalSellAmount / 10000).toLocaleString()}만원</p>
        </div>
        <div className="bg-emerald-950/30 border border-emerald-900/30 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">양도세 (소액주주)</p>
          <p className="text-sm font-bold text-emerald-400">비과세 ✓</p>
        </div>
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 52주 신고가 스캐너
// ═══════════════════════════════════════

export function HighScannerPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/52w-highs', { timeout: 30000 }).then((d: any) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  const nearHigh = items.filter(it => it.isNearHigh);
  if (nearHigh.length === 0) return null;
  return (
    <Panel title="52주 신고가 근접" badge={`${nearHigh.length}종목`}>
      <div className="px-4 pb-3 space-y-2">
        {nearHigh.map((it: any) => (
          <div key={it.stock_code} className="flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-slate-200">{it.stock_name}</span>
              <span className="ml-2 text-[10px] text-slate-500">{it.current.toLocaleString()}원</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-amber-400 font-bold">신고가 {it.high52w.toLocaleString()}원</span>
              <span className="ml-2 text-[10px] text-emerald-400">{it.dropFromHigh.toFixed(1)}%</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 공매도 비율 패널
// ═══════════════════════════════════════

const SHORT_RISK: Record<string, { color: string; label: string }> = {
  HIGH:   { color: 'text-rose-400',   label: '위험' },
  MEDIUM: { color: 'text-amber-400',  label: '주의' },
  LOW:    { color: 'text-emerald-400',label: '안전' },
};

export function ShortSellingPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/short-selling', { timeout: 20000 }).then((d: any) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  return (
    <Panel title="보유종목 공매도 현황">
      <div className="px-4 pb-3 divide-y divide-slate-800/30">
        {items.map((it: any) => {
          const risk = SHORT_RISK[it.riskLevel] ?? SHORT_RISK.LOW;
          return (
            <div key={it.stock_code} className="flex items-center justify-between py-2">
              <div>
                <span className="text-xs font-semibold text-slate-200">{it.stock_name}</span>
                {it.isIncreasing && <span className="ml-2 text-[9px] bg-rose-900/40 text-rose-400 px-1.5 py-0.5 rounded">증가↑</span>}
              </div>
              <div className="flex items-center gap-3 text-right">
                <span className="text-[11px] text-slate-400">{it.shortRatio.toFixed(1)}%</span>
                <span className={`text-[11px] font-bold ${risk.color}`}>{risk.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 업종 히트맵
// ═══════════════════════════════════════

export function SectorHeatmapPanel() {
  const [items, setItems] = React.useState<any[]>([]);
  React.useEffect(() => {
    api('/market/sector-heatmap', { timeout: 10000 }).then((d: any) => setItems(d.items ?? [])).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  const maxAbs = Math.max(...items.map((it: any) => Math.abs(it.pct)), 0.1);
  return (
    <Panel title="업종 현황">
      <div className="px-3 pb-3 flex flex-wrap gap-1.5">
        {items.map((it: any, i: number) => {
          const intensity = Math.min(1, Math.abs(it.pct) / maxAbs);
          const bg = it.pct > 0
            ? `rgba(52,211,153,${0.08 + intensity * 0.25})`
            : it.pct < 0
              ? `rgba(248,113,113,${0.08 + intensity * 0.25})`
              : 'rgba(100,116,139,0.1)';
          return (
            <div key={i} className="rounded-lg px-2 py-1.5 text-center min-w-[72px]" style={{ background: bg }}>
              <p className="text-[10px] text-slate-300 truncate">{it.name}</p>
              <p className={`text-[11px] font-bold ${it.pct > 0 ? 'text-emerald-400' : it.pct < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                {it.pct > 0 ? '+' : ''}{it.pct.toFixed(2)}%
              </p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 포트폴리오 상관관계 경고
// ═══════════════════════════════════════

export function CorrelationWarningPanel({ viewMode = 'live' }: { viewMode?: string }) {
  const [warnings, setWarnings] = React.useState<any[]>([]);
  React.useEffect(() => {
    api(`/market/correlation?viewMode=${viewMode}`).then((d: any) => setWarnings(d.warnings ?? [])).catch(() => {});
  }, [viewMode]);
  if (warnings.length === 0) return null;
  return (
    <Panel title="섹터 쏠림 경고" badge={`${warnings.length}건`}>
      <div className="px-4 pb-3 space-y-2">
        {warnings.map((w: any) => (
          <div key={w.sector} className="flex items-start gap-2 bg-amber-950/20 border border-amber-900/30 rounded-xl px-3 py-2">
            <span className="text-amber-400 text-sm">⚠</span>
            <div>
              <p className="text-xs font-bold text-amber-300">{w.sector} {w.count}종목 동시 보유</p>
              <p className="text-[10px] text-slate-500">{w.stocks.join(', ')}</p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// 봇 수익률 vs KOSPI 비교 차트
// ═══════════════════════════════════════

export function PerformanceVsKospiPanel({ viewMode = 'live' }: { viewMode?: string }) {
  const [data, setData] = React.useState<{ bot: any[]; kospi: any[] } | null>(null);
  React.useEffect(() => {
    api(`/market/performance-vs-kospi?viewMode=${viewMode}`, { timeout: 15000 }).then(setData).catch(() => {});
  }, [viewMode]);

  if (!data || (data.bot.length === 0 && data.kospi.length === 0)) return null;

  const allVals = [...data.bot.map(p => p.value), ...data.kospi.map(p => p.value)];
  const minV = Math.min(...allVals, 0);
  const maxV = Math.max(...allVals, 0);
  const range = maxV - minV || 1;
  const H = 80; const W = 300;

  const toY = (v: number) => H - ((v - minV) / range) * H;
  const botPath = data.bot.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(data.bot.length - 1, 1)) * W},${toY(p.value)}`).join(' ');
  const kospiPath = data.kospi.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(data.kospi.length - 1, 1)) * W},${toY(p.value)}`).join(' ');
  const zeroY = toY(0);
  const botLast = data.bot[data.bot.length - 1]?.value ?? 0;
  const kospiLast = data.kospi[data.kospi.length - 1]?.value ?? 0;

  return (
    <Panel title="봇 수익률 vs KOSPI">
      <div className="px-4 pb-3">
        <div className="flex items-center gap-4 mb-2 text-[11px]">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block rounded" /> 봇 <span className={pc(botLast)}>{botLast > 0 ? '+' : ''}{botLast.toFixed(2)}%</span></span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block rounded" /> KOSPI <span className={pc(kospiLast)}>{kospiLast > 0 ? '+' : ''}{kospiLast.toFixed(2)}%</span></span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20">
          <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#334155" strokeWidth="0.5" strokeDasharray="4 2" />
          {kospiPath && <path d={kospiPath} fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />}
          {botPath && <path d={botPath} fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
        <div className="flex justify-between text-[9px] text-slate-600 mt-1">
          <span>{data.bot[0]?.date ?? data.kospi[0]?.date ?? ''}</span>
          <span>오늘</span>
        </div>
      </div>
    </Panel>
  );
}

// ═══════════════════════════════════════
// PNL 3-WAY BREAKDOWN
// ═══════════════════════════════════════

export function PnlBreakdownPanel({ chains, trades }: { chains: any[]; trades: any[] }) {
  const filled = trades.filter((t: any) => t.status === 'FILLED' && t.side === 'SELL');

  // 시세차익 (SWING/DEFENSE/SCALPING 모드 매도 실현손익)
  const swingPnl = filled.filter((t: any) => ['SWING','DEFENSE','SCALPING','SNIPER'].includes(t.trading_mode ?? '')).reduce((sum: number, t: any) => {
    const pnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
    if (pnl === null) {
      const avgBuy = Number(t.transaction_chains?.avg_buy_price) || 0;
      const fp = Number(t.filled_price) || 0; const qty = Number(t.quantity) || 0;
      return avgBuy > 0 ? sum + (fp - avgBuy) * qty : sum;
    }
    return sum + pnl;
  }, 0);

  // 배당 적립 (DIVIDEND 모드 보유 종목 미실현 배당)
  const dividendAccrual = chains.filter((c: any) => c.strategy_mode === 'DIVIDEND').reduce((sum: number, c: any) => {
    const dvd = Number(c.dividendYield ?? 0);
    const holdDays = Number(c.holdingDays ?? 0);
    const invested = Number(c.invested ?? 0) || (Number(c.avg_buy_price) * Number(c.total_quantity));
    return sum + (invested * (dvd / 365 / 100) * holdDays);
  }, 0);

  // 파킹 ETF 수익 (stock_code === '333940')
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
