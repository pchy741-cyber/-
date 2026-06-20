'use client';

import React, { useState, useEffect } from 'react';
import { api, fmtTime } from '../../lib/utils';

interface Note {
  id: number;
  url: string | null;
  title: string | null;
  memo: string | null;
  fetched_at: string;
  length: number;
}

interface DartAnalysis {
  stockCode: string;
  stockName: string;
  fundamentalScore: number;
  fScore: number;
  keyStrengths: string[];
  keyRisks: string[];
  analyzedAt: string;
}

export function ResearchBotPanel() {
  const [url, setUrl] = useState('');
  const [memo, setMemo] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [activeTab, setActiveTab] = useState<'reports' | 'dart'>('reports');

  const loadNotes = async () => {
    try {
      const data = await api('/research/notes');
      setNotes(data.notes ?? []);
    } catch {
      setNotes([]);
    } finally {
      setNotesLoading(false);
    }
  };

  useEffect(() => { loadNotes(); }, []);

  const crawl = async () => {
    if (!url.trim()) return;
    setCrawling(true);
    setMsg(null);
    try {
      const data = await api('/research/crawl', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), memo: memo.trim() || undefined }),
        timeout: 20000,
      });
      if (data.ok) {
        setMsg({ type: 'ok', text: `${data.title || url} (${data.length}자)` });
        setUrl('');
        setMemo('');
        loadNotes();
      } else {
        setMsg({ type: 'err', text: data.error ?? '저장 실패' });
      }
    } catch (err: unknown) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '크롤링 실패' });
    } finally {
      setCrawling(false);
    }
  };

  const deleteNote = async (id: number) => {
    setDeletingId(id);
    try {
      await api(`/research/notes/${id}`, { method: 'DELETE' });
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch { /* ignore */ } finally {
      setDeletingId(null);
    }
  };

  // 파일 크기 포맷
  const fmtSize = (len: number) => {
    if (len >= 10000) return `${(len / 1000).toFixed(0)}K`;
    if (len >= 1000) return `${(len / 1000).toFixed(1)}K`;
    return `${len}`;
  };

  const totalChars = notes.reduce((s, n) => s + (n.length || 0), 0);

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
          <p className="text-[9px] text-slate-500">Track A 자동 주입 · 증권사 리포트 + DART 공시</p>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <div className="text-center">
            <div className="text-violet-400 font-bold">{notes.length}</div>
            <div className="text-slate-600">리포트</div>
          </div>
          <div className="text-center">
            <div className="text-cyan-400 font-bold">{fmtSize(totalChars)}자</div>
            <div className="text-slate-600">데이터</div>
          </div>
        </div>
      </div>

      {/* 상태 바 — 파이프라인 표시 */}
      <div className="px-4 py-2 bg-white/[0.01] border-b border-white/[0.03] flex items-center gap-4 overflow-x-auto">
        {[
          { label: '뉴스 수집', icon: '📰', active: true },
          { label: 'DART 공시', icon: '📋', active: true },
          { label: 'Gemini 분석', icon: '🧠', active: true },
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
        {/* 탭 전환 */}
        <div className="flex gap-1 bg-slate-900/50 rounded-lg p-0.5">
          <button
            onClick={() => setActiveTab('reports')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'reports' ? 'bg-violet-600/30 text-violet-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            수집 리포트 ({notes.length})
          </button>
          <button
            onClick={() => setActiveTab('dart')}
            className={`flex-1 text-[11px] py-1.5 rounded-md font-medium transition-all ${
              activeTab === 'dart' ? 'bg-cyan-600/30 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            + URL 수동추가
          </button>
        </div>

        {/* 리포트 목록 */}
        {activeTab === 'reports' && (
          <>
            {notesLoading ? (
              <div className="flex justify-center py-6">
                <span className="w-5 h-5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : notes.length === 0 ? (
              <div className="text-center py-6">
                <span className="text-3xl opacity-30">📭</span>
                <p className="text-xs text-slate-600 mt-2">다음 Track A 실행 시 자동 수집됩니다</p>
                <p className="text-[10px] text-slate-700 mt-1">07:30 / 10:00 / 12:30 / 18:00 KST</p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
                {notes.map((n) => (
                  <div key={n.id} className="flex items-center gap-2.5 bg-white/[0.02] hover:bg-white/[0.04] rounded-xl px-3 py-2 group transition-colors">
                    <div className="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                      <span className="text-[11px]">📄</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-200 truncate font-medium">{n.title || n.url || '(제목 없음)'}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {n.fetched_at && <span className="text-[9px] text-slate-600">{fmtTime(n.fetched_at)}</span>}
                        {n.length > 0 && <span className="text-[9px] text-violet-500/60">{fmtSize(n.length)}자</span>}
                        {n.memo && <span className="text-[9px] text-slate-500 truncate">{n.memo}</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteNote(n.id)}
                      disabled={deletingId === n.id}
                      className="shrink-0 text-slate-700 hover:text-rose-400 transition-colors disabled:opacity-40 opacity-0 group-hover:opacity-100 text-xs"
                      title="삭제"
                    >
                      {deletingId === n.id ? '...' : '✕'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <button onClick={loadNotes} className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors">새로고침</button>
            </div>
          </>
        )}

        {/* 수동 URL 추가 */}
        {activeTab === 'dart' && (
          <div className="space-y-3">
            <div className="bg-cyan-950/20 border border-cyan-800/20 rounded-xl p-3">
              <p className="text-[11px] text-cyan-300 font-medium">증권사 리포트 URL 직접 추가</p>
              <p className="text-[10px] text-slate-500 mt-0.5">네이버 금융, 한경, 매경, 전자신문, Seeking Alpha 등의 URL을 크롤링해 Track A에 주입합니다.</p>
            </div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !crawling && crawl()}
              placeholder="https://finance.naver.com/research/..."
              className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/40 transition-colors"
            />
            <div className="flex gap-2">
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="메모 (선택)"
                className="flex-1 bg-white/[0.03] border border-white/[0.05] rounded-lg px-3 py-2 text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/30 transition-colors"
              />
              <button
                onClick={crawl}
                disabled={crawling || !url.trim()}
                className="px-5 py-2 bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-sm font-bold transition-all shrink-0 shadow-lg shadow-violet-500/10"
              >
                {crawling ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-[1.5px] border-white border-t-transparent rounded-full animate-spin" />
                    수집 중
                  </span>
                ) : '크롤링'}
              </button>
            </div>
            {msg && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${msg.type === 'ok' ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/30' : 'bg-rose-950/40 text-rose-400 border border-rose-800/30'}`}>
                <span>{msg.type === 'ok' ? '✓' : '✗'}</span>
                <span>{msg.text}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
