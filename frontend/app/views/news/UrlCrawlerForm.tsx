'use client';

import React, { useState } from 'react';
import { api } from '../../lib/utils';
import { Spinner } from '@/components/ui';

interface Props {
  onCrawlSuccess: () => void;
}

export default function UrlCrawlerForm({ onCrawlSuccess }: Props) {
  const [url, setUrl] = useState('');
  const [memo, setMemo] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
        onCrawlSuccess();
      } else {
        setMsg({ type: 'err', text: data.error ?? '저장 실패' });
      }
    } catch (err: unknown) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : '크롤링 실패' });
    } finally {
      setCrawling(false);
    }
  };

  return (
    <div className="space-y-3 max-h-[50vh] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#4c1d95_transparent]">
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
              <Spinner size="xs" color="white" as="span" />
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
  );
}
