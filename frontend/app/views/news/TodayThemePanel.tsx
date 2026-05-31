'use client';

import React from 'react';
import { Panel } from '@/components/ui';

interface ThemeData {
  theme: string;
  reason: string;
  stocks: Array<{ code: string; name: string; market: string }>;
}

export function TodayThemePanel({ theme, themeLoading, isInWatchlist, addingCode, addThemeStock }: {
  theme: ThemeData | null;
  themeLoading: boolean;
  isInWatchlist: (code: string) => boolean;
  addingCode: string | null;
  addThemeStock: (stock: { code: string; name: string; market: string }) => void;
}) {
  return (
    <Panel title="오늘의 테마">
      <div className="p-4">
        {themeLoading ? (
          <div className="flex items-center gap-2 py-2">
            <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="text-xs text-slate-500">AI가 오늘의 테마를 분석 중...</span>
          </div>
        ) : theme ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-bold text-violet-300">{theme.theme}</span>
              <span className="text-xs text-slate-400 leading-relaxed">{theme.reason}</span>
            </div>
            <div>
              <p className="text-[11px] text-slate-500 mb-2">이 테마 관련 종목 — 감시목록에 추가해서 자동매매</p>
              <div className="flex flex-wrap gap-2">
                {theme.stocks.map((s) => {
                  const inList = isInWatchlist(s.code);
                  return (
                    <button
                      key={s.code}
                      onClick={() => addThemeStock(s)}
                      disabled={inList || addingCode === s.code}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        inList
                          ? 'bg-emerald-950/40 border-emerald-700/40 text-emerald-400 cursor-default'
                          : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-violet-900/30 hover:border-violet-600/50'
                      }`}
                    >
                      {addingCode === s.code ? (
                        <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
                      ) : inList ? (
                        <span className="text-emerald-400">✓</span>
                      ) : (
                        <span className="text-slate-500">+</span>
                      )}
                      <span>{s.name}</span>
                      <span className="text-slate-600">{s.code}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">테마를 분석하지 못했습니다</p>
        )}
      </div>
    </Panel>
  );
}
