'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui';
import { api } from '../lib/utils';

interface Ref {
  id: number;
  content: string;
  has_image: boolean;
  analysis: any;
  stock_codes: string[];
  sentiment: string;
  confidence: number;
  overrides_applied: string[];
  ttl_hours: number;
  expires_at: string;
  created_at: string;
}

const SENTIMENT_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  BULLISH: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', label: 'BULL' },
  BEARISH: { bg: 'bg-red-500/20', text: 'text-red-400', label: 'BEAR' },
  NEUTRAL: { bg: 'bg-slate-500/20', text: 'text-slate-400', label: 'NEUTRAL' },
};

function timeRemaining(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return '만료됨';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

export default function ReferencePanel({ toast, viewMode }: { toast?: (msg: string, type?: 'ok' | 'err' | 'info') => void; viewMode: string }) {
  const [refs, setRefs] = useState<Ref[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [content, setContent] = useState('');
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [imgBase64, setImgBase64] = useState('');
  const [mimeType, setMimeType] = useState('image/png');
  const [ttlHours, setTtlHours] = useState(24);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api(`/references?viewMode=${viewMode}`) as any;
      setRefs(res?.references ?? []);
    } catch { /* ignore */ }
  }, [viewMode]);

  useEffect(() => { load(); }, [load]);

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setMimeType(file.type);
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setImgPreview(dataUrl);
      setImgBase64(dataUrl.split(',')[1] ?? '');
    };
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    if (!content.trim() && !imgBase64) { toast?.('텍스트 또는 이미지를 입력하세요', 'err'); return; }
    setSubmitting(true);
    try {
      const body: any = { content: content.trim(), ttlHours };
      if (imgBase64) { body.imageBase64 = imgBase64; body.mimeType = mimeType; }
      const res = await api(`/references?viewMode=${viewMode}`, {
        method: 'POST',
        body: JSON.stringify(body),
        timeout: 60000,
      }) as any;
      if (res?.ok) {
        const a = res.analysis;
        toast?.(`${a.sentiment} (${a.confidence}점) ${a.stockCodes.join(',')} — ${res.overridesApplied.length}건 반영`, 'ok');
        setContent(''); setImgPreview(null); setImgBase64(''); setShowForm(false);
        load();
      } else {
        toast?.(res?.error ?? '등록 실패', 'err');
      }
    } catch (e) {
      toast?.((e as Error).message ?? '분석 실패', 'err');
    } finally { setSubmitting(false); }
  };

  const remove = async (id: number) => {
    setDeleting(id);
    try {
      await api(`/references/${id}?viewMode=${viewMode}`, { method: 'DELETE' });
      toast?.('레퍼런스 삭제됨', 'info');
      load();
    } catch { toast?.('삭제 실패', 'err'); }
    finally { setDeleting(null); }
  };

  return (
    <div className="glass rounded-2xl border border-white/[0.04] overflow-hidden shadow-xl shadow-black/40 animate-in">
      <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center gap-3">
        <h3 className="text-sm font-bold text-slate-100 tracking-tight">트레이딩 레퍼런스</h3>
        {refs.length > 0 && (
          <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-violet-500/20 text-violet-400">
            {refs.length}건 활성
          </span>
        )}
        <button onClick={() => setShowForm(!showForm)}
          className="ml-auto text-[10px] px-2 py-0.5 rounded-md bg-violet-500/20 text-violet-400 hover:bg-violet-500/30 transition-colors">
          {showForm ? '닫기' : '+ 추가'}
        </button>
      </div>
      {/* 등록 폼 */}
      {showForm && (
        <div className="px-4 py-3 border-b border-white/[0.04] bg-violet-900/10 space-y-3">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="인플루언서 의견, 커뮤니티 글, 뉴스 요약 등을 입력하세요...&#10;예: '삼성전자 실적 서프라이즈 예상, 외국인 3일연속 순매수'"
            className="w-full bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-violet-500/50 resize-none h-20"
          />

          {/* 이미지 업로드 */}
          <div
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            className="relative"
          >
            {imgPreview ? (
              <div className="relative">
                <img src={imgPreview} alt="preview" className="w-full max-h-32 object-contain rounded-lg border border-white/10" />
                <button onClick={() => { setImgPreview(null); setImgBase64(''); }}
                  className="absolute top-1 right-1 w-5 h-5 bg-red-600/80 text-white text-[10px] rounded-full flex items-center justify-center">X</button>
              </div>
            ) : (
              <label className="flex items-center justify-center h-12 border border-dashed border-white/10 rounded-lg cursor-pointer hover:border-violet-500/30 transition-colors">
                <span className="text-[10px] text-slate-600">이미지 드래그 또는 클릭 (캡쳐, 스크린샷)</span>
                <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              </label>
            )}
          </div>

          {/* TTL + 제출 */}
          <div className="flex items-center gap-2">
            <select value={ttlHours} onChange={e => setTtlHours(Number(e.target.value))}
              className="bg-white/[0.06] border border-white/[0.08] rounded-lg px-2 py-1.5 text-[10px] text-slate-300 outline-none">
              <option value={12}>12시간</option>
              <option value={24}>24시간</option>
              <option value={48}>48시간</option>
            </select>
            <Button variant="violet" size="sm" disabled={submitting} onClick={submit} className="flex-1">
              {submitting ? 'AI 분석 중...' : 'AI 분석 & 반영'}
            </Button>
          </div>
        </div>
      )}

      {/* 활성 레퍼런스 목록 */}
      {refs.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] text-slate-600">
          등록된 레퍼런스 없음 — 인플루언서 캡쳐, 뉴스, 트레이더 의견을 추가하세요
        </div>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {refs.map(r => {
            const style = SENTIMENT_STYLE[r.sentiment] ?? SENTIMENT_STYLE.NEUTRAL;
            const a = r.analysis as any;
            return (
              <div key={r.id} className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    {/* 헤더: sentiment + confidence + 종목 */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}>
                        {style.label}
                      </span>
                      <span className="text-[9px] text-slate-500">{r.confidence}점</span>
                      {r.stock_codes.map(c => (
                        <span key={c} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">{c}</span>
                      ))}
                      {r.has_image && <span className="text-[9px] text-slate-600">IMG</span>}
                    </div>
                    {/* 요약 */}
                    <p className="text-[10px] text-slate-400 mt-1 line-clamp-2">{a?.summary || r.content}</p>
                    {/* 오버라이드 + 남은 시간 */}
                    <div className="flex items-center gap-2 mt-1.5">
                      {r.overrides_applied.length > 0 && (
                        <span className="text-[9px] text-amber-400/70">{r.overrides_applied.length}건 반영</span>
                      )}
                      <span className="text-[9px] text-slate-600">{timeRemaining(r.expires_at)} 남음</span>
                    </div>
                  </div>
                  <button onClick={() => remove(r.id)} disabled={deleting === r.id}
                    className="text-[10px] text-slate-600 hover:text-red-400 transition-colors shrink-0 mt-0.5">
                    {deleting === r.id ? '...' : 'X'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
