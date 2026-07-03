'use client';

import React, { useEffect, useRef } from 'react';
import { api, fmtTime } from '../../lib/utils';
import { Spinner } from '@/components/ui';
import type { DartResult } from './research-types';
import { fmtBillion, fScoreColor, fundBg, FinancialGrid, StrengthsRisks, AiAnalysisBlock } from './research-shared';
import { useReportsFetcher } from './useReportsFetcher';

interface Props {
  krWatchlist: Array<{ code: string; name: string }>;
}

export default function DartReportsTab({ krWatchlist }: Props) {
  const krName = (code: string) => krWatchlist.find((s) => s.code === code)?.name ?? code;

  const { results: dartResults, setResults: setDartResults, loading: dartLoading, error: dartError, setError: setDartError, expanded: expandedDart, setExpanded: setExpandedDart, load: loadDartReports } = useReportsFetcher<DartResult>({
    fetchFn: async () => {
      const stockCodes = krWatchlist.map((s) => s.code).slice(0, 20);
      if (stockCodes.length === 0) {
        setDartError('감시목록에 KR 종목이 없습니다');
        return null;
      }
      const data = await api('/research/dart/batch', {
        method: 'POST',
        body: JSON.stringify({ stockCodes }),
        timeout: 90000,
      });
      if (data.ok && Array.isArray(data.results)) return data.results;
      throw new Error(data.error ?? '분석 실패');
    },
    watchlistLength: krWatchlist.length,
  });

  // 초기 로드: 캐시된 결과
  useEffect(() => {
    if (krWatchlist.length > 0) {
      const codes = krWatchlist.map((s) => s.code);
      api(`/research/dart/cached?codes=${codes.slice(0, 30).join(',')}`)
        .then((data) => {
          if (data.ok && Array.isArray(data.results) && data.results.length > 0) {
            setDartResults(data.results);
          }
        })
        .catch(() => {});
    }
  }, []);

  // KR 감시목록 증가 시 자동 분석
  const prevKrLenRef = useRef(0);
  useEffect(() => {
    const prev = prevKrLenRef.current;
    prevKrLenRef.current = krWatchlist.length;
    if (krWatchlist.length > prev && !dartLoading) {
      loadDartReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [krWatchlist.length]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500">
          {krWatchlist.length > 0 ? `감시목록 ${krWatchlist.length}종목` : '감시목록 로딩 중...'}
        </span>
        <button
          onClick={loadDartReports}
          disabled={dartLoading}
          className="px-3 py-1.5 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[11px] font-bold transition-all shadow-lg shadow-cyan-500/10"
        >
          {dartLoading ? (
            <span className="flex items-center gap-1.5">
              <Spinner size="xs" color="white" as="span" />
              분석 중...
            </span>
          ) : dartResults.length > 0 ? '새로고침' : 'Gemini 분석 실행'}
        </button>
      </div>

      {dartError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-rose-950/40 text-rose-400 border border-rose-800/30">
          <span>✗</span><span>{dartError}</span>
        </div>
      )}

      {dartLoading && dartResults.length === 0 && (
        <div className="text-center py-8">
          <Spinner size="xl" color="cyan" className="mx-auto" />
          <p className="text-xs text-slate-500 mt-3">DART API + Gemini AI 분석 중...</p>
          <p className="text-[10px] text-slate-600 mt-1">최초 실행 시 1~2분 소요 (이후 24h 캐시)</p>
        </div>
      )}

      {!dartLoading && dartResults.length === 0 && !dartError && (
        <div className="text-center py-6">
          <span className="text-3xl opacity-30">📊</span>
          <p className="text-xs text-slate-500 mt-2">감시목록 로드 완료 시 자동 분석 시작됩니다</p>
          <p className="text-[10px] text-slate-600 mt-1">Gemini GCP 크레딧 사용 · 24h 캐시 · 30분 자동 재분석</p>
        </div>
      )}

      {dartResults.length > 0 && (
        <div className="space-y-2">
          {dartResults.map((r) => {
            const isExpanded = expandedDart === r.stockCode;
            const f = r.financial;
            return (
              <div key={r.stockCode} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.02] transition-colors text-left"
                  onClick={() => setExpandedDart(isExpanded ? null : r.stockCode)}
                >
                  <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-slate-100">{krName(r.stockCode) || r.corpName || r.stockCode}</span>
                    <span className="text-[9px] text-slate-600 bg-slate-800/80 rounded px-1.5 py-0.5">{r.stockCode}</span>
                    {r.earningsDaysLeft != null && r.earningsDaysLeft >= 0 && r.earningsDaysLeft <= 30 && (
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border animate-pulse ${
                        r.earningsDaysLeft <= 3
                          ? 'bg-red-500/20 text-red-400 border-red-500/40'
                          : r.earningsDaysLeft <= 7
                          ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                          : 'bg-violet-500/15 text-violet-400 border-violet-500/30'
                      }`}>
                        실적 D-{r.earningsDaysLeft}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.fundamentalScore != null && (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${fundBg(r.fundamentalScore)}`}>
                        펀더멘털 {r.fundamentalScore}
                      </span>
                    )}
                    {r.piotroskiScore != null && (
                      <span className={`text-[10px] font-bold ${fScoreColor(r.piotroskiScore)}`}>
                        F{r.piotroskiScore}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-600 shrink-0">{isExpanded ? '▲' : '▼'}</span>
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-2.5 border-t border-white/[0.04]">
                    {f && (
                      <FinancialGrid f={f} labelPrefix="kr" />
                    )}
                    <StrengthsRisks strengths={r.keyStrengths} risks={r.keyRisks} />
                    <AiAnalysisBlock analysis={r.aiAnalysis} color="cyan" />
                    {r.analyzedAt && (
                      <div className="text-[9px] text-slate-600 text-right">분석: {fmtTime(r.analyzedAt)}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
