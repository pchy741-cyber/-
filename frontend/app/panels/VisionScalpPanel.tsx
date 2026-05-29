'use client';

import React from 'react';
import { api } from '../lib/utils';

export default function VisionScalpPanel({ toast }: { toast?: (msg: string, type?: string) => void }) {
  const [imgPreview, setImgPreview] = React.useState<string | null>(null);
  const [imgBase64, setImgBase64] = React.useState<string>('');
  const [mimeType, setMimeType] = React.useState<string>('image/png');
  const [signal, setSignal] = React.useState<any>(null);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [executing, setExecuting] = React.useState(false);
  const [amountUsd, setAmountUsd] = React.useState(0); // 0 = 서버 자동 계산
  const [result, setResult] = React.useState<any>(null);
  const [analyzeError, setAnalyzeError] = React.useState<string | null>(null);

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setMimeType(file.type);
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setImgPreview(dataUrl);
      setImgBase64(dataUrl.split(',')[1] ?? '');
      setSignal(null);
      setResult(null);
    };
    reader.readAsDataURL(file);
  };

  const analyze = async () => {
    if (!imgBase64) return;
    setAnalyzing(true);
    setSignal(null);
    setAnalyzeError(null);
    try {
      const res = await api('/overseas/vision-scalp/analyze', {
        method: 'POST',
        body: JSON.stringify({ imageBase64: imgBase64, mimeType }),
        timeout: 45000,
      });
      setSignal(res);
      if (!res?.ticker) toast?.('미국 주식 신호를 찾지 못했습니다', 'info');
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'AI 분석 시간 초과 (45초) — 재시도해 주세요' : '분석 실패 — 서버 로그 확인';
      setAnalyzeError(msg);
      toast?.(msg, 'err');
    }
    finally { setAnalyzing(false); }
  };

  const execute = async () => {
    if (!signal?.ticker) return;
    setExecuting(true);
    try {
      const res = await api('/overseas/vision-scalp/execute', {
        method: 'POST',
        body: JSON.stringify({
          ticker: signal.ticker,
          exchange: signal.exchange ?? 'NASDAQ',
          ...(amountUsd > 0 ? { amountUsd } : {}), // 0이면 서버 자동 계산
          reasoning: signal.reasoning,
        }),
      });
      if (res?.ok) {
        setResult(res);
        toast?.(`${signal.ticker} 단타 매수 완료 — ${res.qty}주 @ $${res.price?.toFixed(2)}`, 'ok');
        setSignal(null);
        setImgPreview(null);
        setImgBase64('');
      } else {
        toast?.(res?.error ?? '실행 실패', 'err');
      }
    } catch { toast?.('실행 오류', 'err'); }
    finally { setExecuting(false); }
  };

  const confidenceColor = (c: number) =>
    c >= 75 ? 'text-emerald-400' : c >= 50 ? 'text-yellow-400' : 'text-rose-400';

  return (
    <div className="border-b border-white/[0.04] px-3.5 py-3">
      <div className="text-[11px] font-semibold text-slate-400 mb-2.5 flex items-center gap-1.5">
        <span>제보 단타</span> <span className="text-slate-600 font-normal">(캡처 {'→'} AI 분석 {'→'} 미국주식 단타)</span>
      </div>
      <div className="flex flex-col sm:flex-row gap-2.5">
        {/* 업로드 영역 */}
        <label className="relative flex-shrink-0 cursor-pointer">
          <div
            className="w-24 h-20 rounded-xl border-2 border-dashed border-slate-700/60 hover:border-blue-500/50 bg-slate-800/40 flex items-center justify-center overflow-hidden transition-all"
            onDragOver={e => { e.preventDefault(); }}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          >
            {imgPreview
              ? <img src={imgPreview} alt="preview" className="w-full h-full object-cover rounded-xl" />
              : <span className="text-2xl opacity-30">+</span>}
          </div>
          <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        </label>

        <div className="flex-1 space-y-2 min-w-0">
          {/* 분석 결과 */}
          {signal && signal.ticker ? (
            <div className="bg-slate-800/60 rounded-xl px-3 py-2 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-white">{signal.ticker}</span>
                <span className="text-[10px] text-slate-500">{signal.exchange}</span>
                <span className={`text-xs font-bold ${confidenceColor(signal.confidence)}`}>{signal.confidence}점</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${signal.riskLevel === 'LOW' ? 'bg-emerald-900/40 text-emerald-400' : signal.riskLevel === 'HIGH' ? 'bg-rose-900/40 text-rose-400' : 'bg-yellow-900/40 text-yellow-400'}`}>{signal.riskLevel}</span>
              </div>
              <p className="text-[10px] text-slate-400 leading-relaxed">{signal.reasoning}</p>
              <div className="text-[9px] text-slate-600">TP +2.5% · SL -1.5% 자동 설정</div>
            </div>
          ) : signal && !signal.ticker ? (
            <div className="bg-slate-800/60 rounded-xl px-3 py-2 text-[11px] text-slate-500">{signal.reasoning}</div>
          ) : null}

          {/* 분석 오류 */}
          {analyzeError && (
            <div className="bg-rose-900/30 border border-rose-800/40 rounded-xl px-3 py-2 text-[10px] text-rose-400">{analyzeError}</div>
          )}

          {/* 실행 결과 */}
          {result && (
            <div className="bg-emerald-900/30 border border-emerald-800/40 rounded-xl px-3 py-2 text-[10px] text-emerald-400">
              {result.ticker} {result.qty}주 @ ${result.price?.toFixed(2)} · TP ${result.tpPrice} · SL ${result.slPrice}
            </div>
          )}

          <div className="flex items-center gap-2">
            {imgBase64 && !signal && (
              <button
                onClick={analyze}
                disabled={analyzing}
                className="px-3 py-1.5 rounded-lg bg-blue-600/80 hover:bg-blue-600 text-white text-xs font-medium disabled:opacity-50 transition-all"
              >
                {analyzing ? '분석 중...' : 'AI 분석'}
              </button>
            )}
            {signal?.ticker && (
              <>
                <input
                  type="number"
                  value={amountUsd || ''}
                  placeholder="자동"
                  onChange={e => setAmountUsd(Math.max(0, Math.min(2000, Number(e.target.value) || 0)))}
                  className="w-20 bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-slate-300 text-center"
                  min={0} max={2000} step={50}
                />
                <span className="text-[10px] text-slate-600">USD</span>
                <button
                  onClick={execute}
                  disabled={executing}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-50 transition-all"
                >
                  {executing ? '실행 중...' : '단타 실행'}
                </button>
                <button onClick={() => { setSignal(null); setImgPreview(null); setImgBase64(''); }} className="text-[10px] text-slate-600 hover:text-slate-400">취소</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
