'use client';

import React, { useEffect } from 'react';
import { api, fmtTime } from '../../lib/utils';
import { Spinner } from '@/components/ui';
import type { DartResult } from './research-types';
import { fundBg, FinancialGrid, StrengthsRisks, AiAnalysisBlock } from './research-shared';
import { useReportsFetcher } from './useReportsFetcher';

interface Props {
  usWatchlist: Array<{ ticker: string; name: string }>;
}

export default function SecReportsTab({ usWatchlist }: Props) {
  const usName = (ticker: string) => usWatchlist.find((s) => s.ticker === ticker)?.name ?? ticker;

  const { results: secResults, loading: secLoading, error: secError, setError: setSecError, expanded: expandedSec, setExpanded: setExpandedSec, load: loadSecReports } = useReportsFetcher<DartResult>({
    fetchFn: async () => {
      const tickers = usWatchlist.map((s) => s.ticker).slice(0, 10);
      if (tickers.length === 0) {
        setSecError('감시목록에 US 종목이 없습니다');
        return null;
      }
      const data = await api('/research/sec/batch', {
        method: 'POST',
        body: JSON.stringify({ tickers }),
        timeout: 90000,
      });
      if (data.ok && Array.isArray(data.results)) {
        return data.results.map((r: any) => ({
          stockCode: r.ticker,
          corpName: r.companyName,
          financial: r.financial ? {
            revenue: r.financial.revenue,
            revenueYoy: r.financial.revenueYoy,
            operatingIncome: r.financial.operatingIncome,
            operatingIncomeYoy: r.financial.operatingIncomeYoy,
            operatingMargin: r.financial.operatingMargin,
            netIncome: r.financial.netIncome,
            totalAssets: r.financial.totalAssets,
            totalDebt: r.financial.totalLiabilities ?? 0,
            debtRatio: r.financial.debtRatio,
            year: String(r.financial.year),
            quarter: r.financial.quarter,
          } : undefined,
          aiAnalysis: r.aiAnalysis,
          fundamentalScore: r.fundamentalScore,
          piotroskiScore: undefined,
          keyRisks: r.keyRisks ?? [],
          keyStrengths: r.keyStrengths ?? [],
          analyzedAt: r.analyzedAt,
        }));
      }
      throw new Error(data.error ?? 'SEC 분석 실패');
    },
    watchlistLength: usWatchlist.length,
  });

  // US 감시목록 로드 완료 → SEC 자동 분석
  useEffect(() => {
    if (usWatchlist.length > 0 && secResults.length === 0 && !secLoading) {
      loadSecReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usWatchlist.length]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500">
          {usWatchlist.length > 0 ? `US 감시목록 ${usWatchlist.length}종목` : 'US 감시목록 로딩 중...'}
        </span>
        <button
          onClick={loadSecReports}
          disabled={secLoading}
          className="px-3 py-1.5 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[11px] font-bold transition-all shadow-lg shadow-blue-500/10"
        >
          {secLoading ? (
            <span className="flex items-center gap-1.5">
              <Spinner size="xs" color="white" as="span" />
              분석 중...
            </span>
          ) : secResults.length > 0 ? '새로고침' : 'SEC 분석 실행'}
        </button>
      </div>

      {secError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-rose-950/40 text-rose-400 border border-rose-800/30">
          <span>✗</span><span>{secError}</span>
        </div>
      )}

      {secLoading && secResults.length === 0 && (
        <div className="text-center py-8">
          <Spinner size="xl" className="mx-auto" />
          <p className="text-xs text-slate-500 mt-3">SEC EDGAR + Gemini AI 분석 중...</p>
          <p className="text-[10px] text-slate-600 mt-1">10-K 재무제표 파싱 (24h 캐시)</p>
        </div>
      )}

      {!secLoading && secResults.length === 0 && !secError && (
        <div className="text-center py-6">
          <span className="text-3xl opacity-30">🇺🇸</span>
          <p className="text-xs text-slate-500 mt-2">SEC EDGAR 10-K 재무분석</p>
          <p className="text-[10px] text-slate-600 mt-1">무료 API · Gemini 크레딧 · 실전/연습 공통</p>
        </div>
      )}

      {secResults.length > 0 && (
        <div className="space-y-2">
          {secResults.map((r) => {
            const isExpanded = expandedSec === r.stockCode;
            const f = r.financial;
            return (
              <div key={r.stockCode} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.02] transition-colors text-left"
                  onClick={() => setExpandedSec(isExpanded ? null : r.stockCode)}
                >
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-100">{usName(r.stockCode) || r.corpName}</span>
                    <span className="text-[9px] text-blue-400 bg-blue-900/30 rounded px-1.5 py-0.5">{r.stockCode}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.fundamentalScore != null && (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${fundBg(r.fundamentalScore)}`}>
                        펀더멘털 {r.fundamentalScore}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-600 shrink-0">{isExpanded ? '▲' : '▼'}</span>
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-2.5 border-t border-white/[0.04]">
                    {f && <FinancialGrid f={f} labelPrefix="us" />}
                    <StrengthsRisks strengths={r.keyStrengths} risks={r.keyRisks} />
                    <AiAnalysisBlock analysis={r.aiAnalysis} color="blue" />
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
