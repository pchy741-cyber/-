'use client';

import React, { useState, useEffect } from 'react';
import { Panel } from '@/components/ui';
import { api } from '../../lib/utils';

interface Note {
  id: number;
  url: string | null;
  title: string | null;
  memo: string | null;
  fetched_at: string;
  length: number;
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
        setMsg({ type: 'ok', text: `저장: ${data.title || url} (${data.length}자)` });
        setUrl('');
        setMemo('');
        loadNotes();
      } else {
        setMsg({ type: 'err', text: data.error ?? '저장 실패' });
      }
    } catch (err: any) {
      setMsg({ type: 'err', text: err.message ?? '크롤링 실패' });
    } finally {
      setCrawling(false);
    }
  };

  const deleteNote = async (id: number) => {
    setDeletingId(id);
    try {
      await api(`/research/notes/${id}`, { method: 'DELETE' });
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch { /* 무시 */ } finally {
      setDeletingId(null);
    }
  };

  return (
    <Panel
      title="퀀트 리서치 봇"
      badge={`리포트 ${notes.length}건 · Track A 자동반영`}
    >
      <div className="p-4 space-y-3">
        {/* 자동 수집 안내 */}
        <div className="flex items-start gap-2.5 bg-violet-950/30 border border-violet-800/30 rounded-xl p-3">
          <span className="text-violet-400 text-lg leading-none shrink-0">⚡</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-violet-200 font-medium">자동 수집 활성화</p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Track A 실행 시 (07:30 / 10:00 / 12:30 / 18:00) 네이버 금융 리서치에서 감시 종목 리포트를 자동 수집해 Gemini에 주입합니다.
              아래에서 수동으로 특정 URL을 추가할 수도 있습니다.
            </p>
          </div>
        </div>

        {/* 저장된 리포트 목록 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] text-slate-500 font-medium">수집된 리포트 ({notes.length}건)</p>
            <div className="flex gap-2">
              <button onClick={() => setShowManual((v) => !v)} className="text-[10px] text-violet-400 hover:text-violet-300 transition-colors">
                {showManual ? '수동추가 닫기' : '+ URL 수동추가'}
              </button>
              <button onClick={loadNotes} className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors">새로고침</button>
            </div>
          </div>

          {notesLoading ? (
            <div className="flex justify-center py-3">
              <span className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : notes.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-3">
              다음 Track A 실행 시 자동 수집됩니다
            </p>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {notes.map((n) => (
                <div key={n.id} className="flex items-start gap-2 text-xs bg-slate-900/40 rounded-lg p-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-300 truncate">{n.title || n.url || '(제목 없음)'}</p>
                    <p className="text-slate-600 text-[10px] mt-0.5">
                      {n.fetched_at ? new Date(n.fetched_at).toLocaleDateString('ko-KR') : ''}
                      {n.length ? ` · ${Math.round(n.length / 100) / 10}K자` : ''}
                      {n.memo && <span className="text-slate-500 ml-1">· {n.memo}</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteNote(n.id)}
                    disabled={deletingId === n.id}
                    className="shrink-0 text-slate-700 hover:text-rose-400 transition-colors disabled:opacity-40 text-base leading-none"
                    title="삭제"
                  >
                    {deletingId === n.id ? '…' : '×'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 수동 URL 추가 (토글) */}
        {showManual && (
          <div className="border-t border-slate-800/60 pt-3 space-y-2">
            <p className="text-[11px] text-slate-500">증권사 리포트 URL 직접 추가</p>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !crawling && crawl()}
              placeholder="https://finance.naver.com/research/..."
              className="w-full bg-white/[0.05] ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
            />
            <div className="flex gap-2">
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="메모 (선택)"
                className="flex-1 bg-white/[0.04] ring-1 ring-white/[0.06] rounded-lg px-3 py-1.5 text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none"
              />
              <button
                onClick={crawl}
                disabled={crawling || !url.trim()}
                className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 rounded-lg text-sm font-medium transition-all shrink-0"
              >
                {crawling ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-[1.5px] border-white border-t-transparent rounded-full animate-spin" />
                    수집 중
                  </span>
                ) : '추가'}
              </button>
            </div>
            {msg && (
              <p className={`text-xs ${msg.type === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
                {msg.text}
              </p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
