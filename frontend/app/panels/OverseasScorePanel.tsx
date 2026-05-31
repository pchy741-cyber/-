'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import { api } from '../lib/utils';

export const US_SECTOR_MAP: Record<string, string> = {
  NVDA: 'AI반도체', AMD: 'AI반도체', AVGO: 'AI반도체',
  TSM: '대만반도체', UMC: '대만반도체',
  META: '빅테크', AAPL: '빅테크', MSFT: '빅테크',
  RTX: '방산', LMT: '방산', GEV: '방산', PLTR: '방산',
  ETN: '산업인프라', PWR: '산업인프라', ANET: '산업인프라', VRT: '산업인프라',
  AMZN: '클라우드', GOOGL: '클라우드', ORCL: '클라우드', NOW: '클라우드', MELI: '클라우드',
  TM: '일본', SONY: '일본', MUFG: '일본',
};
export const US_SECTORS = ['전체', 'AI반도체', '빅테크', '방산', '클라우드', '산업인프라', '대만반도체', '일본'];

export default function OverseasScorePanel({ usDash, toast }: { usDash?: any; toast?: (msg: string, type?: string) => void }) {
  const allScored = (usDash?.watchlist ?? []).filter((s: any) => typeof s.score === 'number');
  const [sector, setSector] = React.useState('전체');
  const [buyingCode, setBuyingCode] = React.useState<string | null>(null);
  const [confirmCode, setConfirmCode] = React.useState<string | null>(null);
  const [manualAmount, setManualAmount] = React.useState(0); // 0 = 서버 자동
  const [showAll, setShowAll] = React.useState(false);
  const signalMap: Record<string, string> = { STRONG_BUY: '강력 추천', BUY: '매수', HOLD: '관망', SELL: '매도', STRONG_SELL: '강력 매도' };
  const filtered = sector === '전체' ? allScored : allScored.filter((s: any) => US_SECTOR_MAP[s.code] === sector);
  const sorted = [...filtered].sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));
  const visible = showAll ? sorted : sorted.slice(0, 10);

  const openConfirm = (code: string) => { setConfirmCode(code); setManualAmount(0); };
  const cancelConfirm = () => setConfirmCode(null);

  const manualBuy = async (sc: any) => {
    setBuyingCode(sc.code);
    setConfirmCode(null);
    try {
      const ex = sc.exchange ?? (sc.code?.length <= 4 ? 'NASDAQ' : 'NYSE');
      const body: any = { ticker: sc.code, exchange: ex, reasoning: `수동진입 점수${sc.score?.toFixed(0)} RSI${sc.rsi?.toFixed(0)} ${sc.signal}` };
      if (manualAmount > 0) body.amountUsd = manualAmount;
      const res = await api('/overseas/vision-scalp/execute', { method: 'POST', body: JSON.stringify(body) });
      toast?.(`${sc.code} ${res.qty}주 @$${res.price?.toFixed(2)} ($${res.amountUsed}) TP+${res.tpPct}%/SL-${res.slPct}%`, 'ok');
    } catch (e: any) { toast?.(e.message, 'err'); }
    setBuyingCode(null);
  };

  return (
    <Panel title="AI가 보는 해외 종목 점수" badge={allScored.length > 0 ? `${allScored.length}종목` : undefined} badgeColor="blue">
      {allScored.length > 0 ? (
        <div className="p-3.5">
          {/* 섹터 탭 */}
          <div className="flex gap-1.5 flex-wrap mb-3">
            {US_SECTORS.map(s => (
              <button key={s} onClick={() => { setSector(s); setShowAll(false); }}
                className={`text-[10px] px-2 py-1 rounded-lg transition-all ${sector === s ? 'bg-blue-600 text-white' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]'}`}>
                {s}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            {visible.map((sc: any) => {
              const raw = Number(sc.score);
              const pct = Math.max(2, Math.min(100, (raw + 100) / 2));
              const barColor = pct >= 75 ? 'bg-emerald-500' : pct >= 60 ? 'bg-blue-500' : pct >= 45 ? 'bg-amber-500' : 'bg-slate-600';
              const textColor = pct >= 75 ? 'text-emerald-400' : pct >= 60 ? 'text-blue-400' : 'text-slate-500';
              const label = signalMap[sc.signal] ?? sc.signal ?? '';
              const sectorLabel = US_SECTOR_MAP[sc.code] ?? '';
              const isBuying = buyingCode === sc.code;
              const isConfirming = confirmCode === sc.code;
              return (
                <div key={sc.code} className="px-2 py-2.5 border-b border-white/[0.03] last:border-0">
                  <div className="flex items-center gap-2">
                    <div className="w-20 shrink-0">
                      <div className="text-xs font-bold text-slate-300 truncate">{sc.name ?? sc.code}</div>
                      <div className="text-[9px] text-slate-600">{sc.code} · {sectorLabel}</div>
                    </div>
                    <div className="flex-1">
                      <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barColor} transition-all`} data-w={pct} ref={el => { if (el) el.style.width = `${pct}%`; }} />
                      </div>
                    </div>
                    <span className={`text-sm font-black w-9 text-right ${textColor}`}>{raw > 0 ? '+' : ''}{raw}</span>
                    <span className={`text-[10px] font-medium w-14 text-right ${textColor}`}>{label}</span>
                    {isBuying ? (
                      <span className="text-[10px] px-2 py-1 text-slate-500 animate-pulse">매수 중...</span>
                    ) : isConfirming ? (
                      <button onClick={cancelConfirm} className="text-[10px] px-2 py-1 text-slate-600 hover:text-slate-400 shrink-0">취소</button>
                    ) : (
                      <button onClick={() => openConfirm(sc.code)}
                        className="text-[10px] px-2 py-1 bg-blue-600/70 hover:bg-blue-500/70 rounded-lg whitespace-nowrap shrink-0">
                        매수
                      </button>
                    )}
                  </div>
                  {/* 인라인 매수 확인 패널 */}
                  {isConfirming && (
                    <div className="mt-2 mx-1 px-3 py-2.5 bg-white/[0.03] ring-1 ring-blue-500/20 rounded-xl">
                      <div className="text-[10px] text-slate-400 mb-2">{sc.name ?? sc.code} 수동 매수</div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={manualAmount || ''}
                          placeholder="자동"
                          onChange={e => setManualAmount(Math.max(0, Math.min(5000, Number(e.target.value) || 0)))}
                          className="w-20 bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-2 py-1.5 text-xs text-slate-300 text-center focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                          min={0} max={5000} step={50}
                        />
                        <span className="text-[10px] text-slate-600">USD</span>
                        <span className="text-[9px] text-slate-600 flex-1">{manualAmount > 0 ? '' : '잔고 기반 최적 금액'}</span>
                        <button onClick={() => manualBuy(sc)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-medium rounded-lg shrink-0 transition-all shadow-sm">
                          확인
                        </button>
                      </div>
                      <div className="text-[9px] text-slate-600 mt-1.5">동적 TP/SL 자동 (섹터·변동성·VIX 기반)</div>
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-1 pl-1 text-[9px] flex-wrap">
                    {sc.rsi != null && <span className="text-slate-500">RSI <b className={Number(sc.rsi) > 70 ? 'text-rose-400' : Number(sc.rsi) < 30 ? 'text-emerald-400' : 'text-slate-300'}>{Number(sc.rsi).toFixed(0)}</b></span>}
                    {sc.price > 0 && <span className="text-slate-400">${Number(sc.price).toFixed(2)}</span>}
                    <span className={Number(sc.changePct) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{Number(sc.changePct) >= 0 ? '+' : ''}{Number(sc.changePct ?? 0).toFixed(2)}%</span>
                  </div>
                </div>
              );
            })}
            {sorted.length > 10 && (
              <button onClick={() => setShowAll(v => !v)}
                className="w-full mt-1 py-1.5 text-[11px] text-slate-500 hover:text-blue-400 transition-colors">
                {showAll ? '접기' : `+ ${sorted.length - 10}종목 더 보기`}
              </button>
            )}
            {sorted.length === 0 && <div className="py-4 text-center text-[11px] text-slate-600">해당 섹터 점수 없음</div>}
          </div>
        </div>
      ) : (
        <div className="p-6 text-center space-y-3">
          <div className="text-2xl opacity-30">🌐</div>
          <p className="text-sm text-slate-500">해외 점수 계산 중...</p>
          <p className="text-[11px] text-slate-600">잠시 후 새로고침하면 기술적 분석 점수가 표시됩니다</p>
        </div>
      )}
    </Panel>
  );
}
