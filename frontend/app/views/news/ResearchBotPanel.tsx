'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../../lib/utils';
import type { WatchlistItem, UsDashboard, UsWatchlistItem } from '../../types';
import DartReportsTab from './DartReportsTab';
import SecReportsTab from './SecReportsTab';
import ResearchNotesPanel from './ResearchNotesPanel';
import UrlCrawlerForm from './UrlCrawlerForm';

export function ResearchBotPanel() {
  const [activeTab, setActiveTab] = useState<'reports' | 'dart' | 'sec' | 'url'>('dart');
  const [noteCount, setNoteCount] = useState(0);

  // 감시목록 동적 로드
  const [krWatchlist, setKrWatchlist] = useState<Array<{ code: string; name: string }>>([]);
  const [usWatchlist, setUsWatchlist] = useState<Array<{ ticker: string; name: string }>>([]);

  const loadNotes = async () => {
    try {
      const data = await api('/research/notes');
      setNoteCount((data.notes ?? []).length);
    } catch {
      setNoteCount(0);
    }
  };

  useEffect(() => {
    loadNotes();
    // KR 감시목록 로드
    api('/watchlist?viewMode=live')
      .then((items: WatchlistItem[]) => {
        if (Array.isArray(items)) {
          setKrWatchlist(items.map((i) => ({ code: i.stock_code, name: String(i.stock_name ?? i.stock_code) })));
        }
      })
      .catch(() => {});
    // US 감시목록 로드
    api('/overseas/dashboard?viewMode=live')
      .then((us: UsDashboard) => {
        if (Array.isArray(us?.watchlist))
          setUsWatchlist(
            (us.watchlist as UsWatchlistItem[]).map((i) => ({ ticker: i.code, name: String(i.name ?? i.code) })),
          );
      })
      .catch(() => {});
  }, []);

  return (
    <div className="rounded-2xl overflow-hidden border border-violet-500/15 bg-gradient-to-br from-violet-950/20 via-slate-950/60 to-transparent">
      {/* 헤더 */}
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center gap-3">
        <div className="relative">
          <span className="text-lg">🤖</span>
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-violet-500 rounded-full animate-pulse" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-slate-100">퀀트 리서치 봇</h3>
          <p className="text-[9px] text-slate-500">DART 재무분석 · Gemini AI · Track A 주입</p>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <div className="text-center">
            <div className="text-violet-400 font-bold">{noteCount}</div>
            <div className="text-slate-600">리포트</div>
          </div>
        </div>
      </div>

      {/* 상태 바 */}
      <div className="px-4 py-2 bg-white/[0.01] border-b border-white/[0.03] flex items-center gap-4 overflow-x-auto">
        {[
          { label: 'DART API', icon: '📋', active: true },
          { label: 'Gemini 분석', icon: '🧠', active: true },
          { label: 'F-Score', icon: '📊', active: true },
          { label: 'Track A 주입', icon: '💉', active: true },
        ].map((step, i) => (
          <div key={i} className="flex items-center gap-1.5 shrink-0">
            {i > 0 && <span className="text-violet-600 text-[8px]">→</span>}
            <span className="text-[10px]">{step.icon}</span>
            <span className={`text-[10px] font-medium ${step.active ? 'text-violet-300' : 'text-slate-600'}`}>{step.label}</span>
            {step.active && <span className="w-1 h-1 rounded-full bg-emerald-400" />}
          </div>
        ))}
      </div>

      <div className="p-4 space-y-3">
        {/* 4탭 전환 */}
        <div className="flex gap-1 bg-slate-900/50 rounded-lg p-0.5">
          <button
            onClick={() => setActiveTab('dart')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'dart' ? 'bg-cyan-600/30 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            KR 재무
          </button>
          <button
            onClick={() => setActiveTab('sec')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'sec' ? 'bg-blue-600/30 text-blue-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            US 재무
          </button>
          <button
            onClick={() => setActiveTab('reports')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'reports' ? 'bg-violet-600/30 text-violet-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            추천 사이트
          </button>
          <button
            onClick={() => setActiveTab('url')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'url' ? 'bg-violet-600/30 text-violet-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            + URL
          </button>
        </div>

        {activeTab === 'dart' && <DartReportsTab krWatchlist={krWatchlist} />}
        {activeTab === 'sec' && <SecReportsTab usWatchlist={usWatchlist} />}
        {activeTab === 'reports' && <ResearchNotesPanel />}
        {activeTab === 'url' && <UrlCrawlerForm onCrawlSuccess={loadNotes} />}
      </div>
    </div>
  );
}
