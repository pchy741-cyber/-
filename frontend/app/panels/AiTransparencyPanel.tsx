'use client';

import React from 'react';
import { api } from '../lib/utils';
import { ScoreBar } from './SmallPanels';

export default function AiTransparencyPanel({ watchlist, tab, usDash }: { watchlist: any[]; tab?: 'KR' | 'US'; usDash?: any }) {
  const [details, setDetails] = React.useState<Map<string, any>>(new Map());
  const [selected, setSelected] = React.useState<string | null>(null);
  const [usSel, setUsSel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (tab === 'US') return;
    const codes = watchlist.map((s: any) => s.stock_code).filter((c: string) => /^[0-9]{6}$/.test(c)).slice(0, 8);
    codes.forEach((code: string) => {
      api(`/stock/${code}/score-detail`).then((r: any) => {
        if (r && typeof r.composite === 'number') {
          setDetails((prev) => new Map(prev).set(code, r));
        }
      }).catch(() => {});
    });
    if (codes.length > 0 && !selected) setSelected(codes[0]);
  }, [watchlist, tab]);

  // US 탭: usDash?.watchlist에서 AI 점수 읽기
  if (tab === 'US') {
    const usStocks: any[] = (usDash?.watchlist ?? []).filter((s: any) => typeof s.score === 'number' || typeof s.ai_score === 'number').slice(0, 8);
    if (usStocks.length === 0) return null;
    const activeUsSel = usSel ?? usStocks[0]?.code ?? null;
    const selStock = usStocks.find((s: any) => s.code === activeUsSel);
    const score = selStock?.score ?? selStock?.ai_score ?? 0;
    const signal = selStock?.signal ?? '';
    return (
      <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
        <div className="text-[11px] font-semibold text-slate-400 mb-2">AI 판단 근거 투명성</div>
        <div className="flex gap-1 flex-wrap mb-3">
          {usStocks.map((s: any) => {
            const sc = s.score ?? s.ai_score ?? 0;
            const active = activeUsSel === s.code;
            return (
              <button key={s.code} onClick={() => setUsSel(s.code)}
                className={`text-[9px] px-2 py-0.5 rounded-full font-semibold transition-colors ${active ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'}`}>
                {s.name ?? s.code} <span className={sc >= 60 ? 'text-emerald-400' : sc <= 40 ? 'text-rose-400' : 'text-amber-400'}>{Math.round(sc)}</span>
              </button>
            );
          })}
        </div>
        {selStock && (
          <div className="space-y-1.5">
            <ScoreBar label="AI점수" value={score} color="blue" />
            {selStock.confidence != null && <ScoreBar label="신뢰도" value={selStock.confidence} color="emerald" />}
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/[0.04]">
              <span className="text-[10px] text-slate-500">시그널</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${signal === 'BUY' || signal === 'STRONG_BUY' ? 'bg-emerald-500/20 text-emerald-300' : signal === 'SELL' ? 'bg-rose-500/20 text-rose-300' : 'bg-white/[0.04] text-slate-400'}`}>{signal || 'HOLD'}</span>
              {selStock.price != null && <span className="text-[10px] text-slate-500 ml-auto">${selStock.price?.toFixed(2)}</span>}
            </div>
            {selStock.reason && (
              <div className="text-[10px] text-slate-500 leading-relaxed line-clamp-2">{selStock.reason}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  const stocks = watchlist.filter((s: any) => details.has(s.stock_code)).slice(0, 8);
  if (stocks.length === 0) return null;

  const sel = selected ?? stocks[0]?.stock_code;
  const detail = details.get(sel ?? '');

  return (
    <div className="glass rounded-2xl border border-white/[0.04] px-4 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2">AI 판단 근거 투명성</div>
      {/* 종목 탭 */}
      <div className="flex gap-1 flex-wrap mb-3">
        {stocks.map((s: any) => {
          const d = details.get(s.stock_code);
          const score = d?.composite ?? 0;
          const active = sel === s.stock_code;
          return (
            <button key={s.stock_code} onClick={() => setSelected(s.stock_code)}
              className={`text-[9px] px-2 py-0.5 rounded-full font-semibold transition-colors ${active ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'}`}>
              {s.stock_name ?? s.stock_code} <span className={score >= 60 ? 'text-emerald-400' : score <= 40 ? 'text-rose-400' : 'text-amber-400'}>{Math.round(score)}</span>
            </button>
          );
        })}
      </div>
      {/* 선택 종목 점수 분해 */}
      {detail && (
        <div className="space-y-1.5">
          <ScoreBar label="종합" value={detail.composite} color="blue" />
          <ScoreBar label="기본지표" value={detail.fundamental} color="emerald" />
          <ScoreBar label="기술지표" value={detail.technical} color="violet" />
          <ScoreBar label="시장심리" value={detail.sentiment} color="amber" />
          {detail.summary && (() => {
            let displayText = detail.summary;
            try {
              const parsed = typeof detail.summary === 'string' && detail.summary.trim().startsWith('{')
                ? JSON.parse(detail.summary) : null;
              if (parsed?.key_facts?.length > 0) {
                displayText = parsed.key_facts.slice(0, 3).join(' · ');
              } else if (parsed) {
                displayText = null;
              }
            } catch {}
            return displayText ? (
              <div className="mt-2 pt-2 border-t border-white/[0.04] text-[10px] text-slate-500 leading-relaxed line-clamp-2">
                {displayText}
              </div>
            ) : null;
          })()}
          {detail.updatedAt && (
            <div className="text-[9px] text-slate-700 text-right">
              {new Date(detail.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 분석
            </div>
          )}
        </div>
      )}
    </div>
  );
}
