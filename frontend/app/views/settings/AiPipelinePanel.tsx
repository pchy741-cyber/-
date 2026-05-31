'use client';

import React, { useState } from 'react';
import type { NbSource } from './settings-types';

interface AiPipelinePanelProps {
  nbSources: NbSource[];
  setNbSources: React.Dispatch<React.SetStateAction<NbSource[]>>;
  geminiPrompt: string;
  setGeminiPrompt: (v: string) => void;
  claudePrompt: string;
  setClaudePrompt: (v: string) => void;
  onSave: () => void;
}

const colorMap: Record<string, { bg: string; border: string; text: string; dot: string; grad: string; activeBg: string }> = {
  amber:   { bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   text: 'text-amber-400',   dot: 'bg-amber-400',   grad: 'from-amber-500 to-orange-500', activeBg: 'bg-amber-950/20' },
  blue:    { bg: 'bg-blue-500/10',     border: 'border-blue-500/20',    text: 'text-blue-400',    dot: 'bg-blue-400',    grad: 'from-blue-500 to-cyan-500',    activeBg: 'bg-blue-950/20' },
  emerald: { bg: 'bg-emerald-500/10',  border: 'border-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400', grad: 'from-emerald-500 to-teal-500', activeBg: 'bg-emerald-950/20' },
};

export function AiPipelinePanel({ nbSources, setNbSources, geminiPrompt, setGeminiPrompt, claudePrompt, setClaudePrompt, onSave }: AiPipelinePanelProps) {
  const [activeStep, setActiveStep] = useState<number>(0);
  const [nbAddTitle, setNbAddTitle] = useState('');
  const [nbAddContent, setNbAddContent] = useState('');
  const [nbAdding, setNbAdding] = useState(false);
  const [nbEditId, setNbEditId] = useState<string | null>(null);
  const [nbEditTitle, setNbEditTitle] = useState('');
  const [nbEditContent, setNbEditContent] = useState('');
  const [nbPendingDeleteId, setNbPendingDeleteId] = useState<string | null>(null);

  const steps = [
    { label: '참고 소스', sub: '소스 관리', color: 'amber', key: 'notebooklm_prompt',
      value: null, onChange: null,
      desc: 'AI 분석에 참고할 자료(뉴스 요약, 리서치 핵심 포인트)를 추가·삭제하세요. 여기서 등록한 소스가 매일 분석의 입력으로 사용됩니다.',
      placeholder: '' },
    { label: '분석 지시', sub: 'AI 분석 설정', color: 'blue', key: 'gemini_prompt',
      value: geminiPrompt, onChange: (v: string) => setGeminiPrompt(v),
      desc: 'AI가 종목을 분석할 때 따라야 할 규칙을 적어주세요. 예: "기관이 3일 이상 순매수한 종목만 보기", "소형주 제외" 등.',
      placeholder: `## CEO 추가 지시사항\n\n### 분석 우선순위\n1. 기관/외국인 수급 데이터를 최우선으로 분석하라. 3일 연속 순매수 종목만 주목.\n2. 최근 실적(영업이익) 증가 확인 필수. 적자전환 또는 실적 악화 종목은 즉시 제외.\n3. 52주 고점 대비 -10%~-25% 구간의 눌림목 종목을 우선 분석.\n\n### 제외 조건\n- 시가총액 5000억 미만 소형주\n- 테마주/급등주 (하루 +15% 이상)\n- 최근 30일 내 유상증자/CB 발행 종목` },
    { label: '매매 지시', sub: '매수·매도 규칙', color: 'emerald', key: 'claude_prompt',
      value: claudePrompt, onChange: (v: string) => setClaudePrompt(v),
      desc: 'AI가 실제로 사고팔 때 지켜야 할 규칙을 적어주세요. 예: "장 시작 30분은 매수 금지", "손절은 반드시 지켜라" 등.',
      placeholder: `## 매매 실행 추가 규칙\n\n### 매수 원칙\n- 장 시작 30분(09:00~09:30) 매수 금지\n- 14:30 이후 신규 매수 금지\n- 동일 종목 하루 1회만 매수\n\n### 매도 원칙\n- 손절은 반드시 지켜라. 감정적 판단 금지.\n- 2일 연속 하락 + 거래량 증가 시 즉시 매도\n- 익절 시 "조금 더" 판단 금지, 기계적 실행` },
  ];

  return (
    <div className="glass rounded-2xl overflow-hidden shadow-xl shadow-black/40">
      {/* 헤더 + 저장 버튼 */}
      <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-100">AI 매매 지시 설정</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">AI가 분석하고 매매할 때 따르는 규칙을 탭별로 설정합니다</p>
        </div>
        <button onClick={onSave} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-xs font-semibold transition-all shadow-sm">저장</button>
      </div>

      {/* 스텝 네비게이션 */}
      <div className="flex border-b border-white/[0.04]">
        {steps.map((s, i) => {
          const sc = colorMap[s.color];
          const active = i === activeStep;
          return (
            <button key={s.label} onClick={() => setActiveStep(i)}
              className={`flex-1 py-3 px-2 text-center transition-all relative ${active ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}>
              {active && <div className={`absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r ${sc.grad}`} />}
              <div className="flex items-center justify-center gap-1.5">
                <div className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-black ${active ? `${sc.bg} ${sc.border} border ${sc.text}` : 'bg-slate-800 text-slate-500'}`}>{i + 1}</div>
                <div className="text-left hidden sm:block">
                  <div className={`text-[11px] font-bold ${active ? sc.text : 'text-slate-400'}`}>{s.label}</div>
                  <div className="text-[9px] text-slate-600">{s.sub}</div>
                </div>
                <div className={`sm:hidden text-[11px] font-bold ${active ? sc.text : 'text-slate-400'}`}>{s.label}</div>
              </div>
              {i < steps.length - 1 && <span className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-700 text-[10px]">&rarr;</span>}
            </button>
          );
        })}
      </div>

      {/* 모든 스텝 콘텐츠 */}
      {steps.map((s, i) => {
        const sc = colorMap[s.color];
        const hidden = i !== activeStep;

        // Step 0: NotebookLM 소스 관리
        if (i === 0) return (
          <div key={s.label} className={`p-4 sm:p-5 ${sc.activeBg} ${hidden ? 'hidden' : ''}`}>
            <p className="text-[11px] text-slate-400 mb-3">{s.desc}</p>

            {/* 소스 목록 */}
            <div className="space-y-2 mb-3">
              {nbSources.length === 0 && (
                <div className="text-[11px] text-slate-500 bg-slate-900/40 rounded-lg p-3 text-center">
                  소스가 없습니다. 아래에서 추가하세요.
                </div>
              )}
              {nbSources.map((src) => {
                const daysOld = src.created_at ? Math.floor((Date.now() - new Date(src.created_at).getTime()) / 86400000) : null;
                const isHarmful = src.harm_suspected === true;
                const isPendingDelete = nbPendingDeleteId === src.id;
                return (
                <div key={src.id} className={`bg-slate-900/60 border rounded-lg p-3 transition-all ${isHarmful ? 'border-rose-600/50 bg-rose-950/10' : 'border-amber-900/20'}`}>
                  {nbEditId === src.id ? (
                    <div className="space-y-2">
                      <input value={nbEditTitle} onChange={e => setNbEditTitle(e.target.value)}
                        className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                      <textarea value={nbEditContent} onChange={e => setNbEditContent(e.target.value)} rows={6}
                        className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                      <div className="flex gap-2">
                        <button onClick={() => {
                          setNbSources(prev => prev.map(x => x.id === src.id ? { ...x, title: nbEditTitle, content: nbEditContent } : x));
                          setNbEditId(null);
                        }} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded-lg text-[11px] font-bold transition-all">저장</button>
                        <button onClick={() => setNbEditId(null)} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-[11px] text-slate-400 transition-all">취소</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-[11px] font-semibold text-amber-300 truncate">{src.title || '제목 없음'}</p>
                          {isHarmful && (
                            <span className="text-[9px] px-1.5 py-0.5 bg-rose-900/60 text-rose-300 rounded-full shrink-0 animate-pulse">⚠️ 수익 악영향 의심</span>
                          )}
                          {daysOld !== null && (
                            <span className="text-[9px] text-slate-600">{daysOld}일 전 등록</span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1 whitespace-pre-wrap line-clamp-3">{src.content}</p>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <button onClick={() => { setNbEditId(src.id); setNbEditTitle(src.title); setNbEditContent(src.content); setNbPendingDeleteId(null); }}
                          className="text-[10px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-all">수정</button>
                        <button onClick={() => setNbSources(prev => prev.map(x => x.id === src.id ? { ...x, harm_suspected: !x.harm_suspected } : x))}
                          className={`text-[9px] px-2 py-1 rounded-lg transition-all ${isHarmful ? 'bg-rose-900/60 text-rose-300' : 'bg-slate-800 text-slate-500 hover:text-amber-400'}`}>
                          {isHarmful ? '⚠️ 플래그됨' : '⚠️ 악영향?'}
                        </button>
                        {isPendingDelete ? (
                          <button onClick={() => { setNbSources(prev => prev.filter(x => x.id !== src.id)); setNbPendingDeleteId(null); }}
                            className="text-[10px] px-2 py-1 bg-rose-600 text-white rounded-lg font-bold animate-pulse">승인 삭제</button>
                        ) : (
                          <button onClick={() => setNbPendingDeleteId(src.id)}
                            className="text-[10px] px-2 py-1 bg-rose-900/40 text-rose-400 hover:bg-rose-800/40 rounded-lg transition-all">삭제</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            {/* 소스 추가 폼 */}
            {nbAdding ? (
              <div className="bg-slate-900/60 border border-amber-700/30 rounded-lg p-3 space-y-2">
                <input value={nbAddTitle} onChange={e => setNbAddTitle(e.target.value)}
                  placeholder="소스 제목 (예: 이번 주 시장 전망)"
                  className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                <textarea value={nbAddContent} onChange={e => setNbAddContent(e.target.value)}
                  placeholder="뉴스 요약, 리서치 핵심 포인트 등 AI 분석에 참고할 내용을 붙여넣으세요..."
                  rows={6}
                  className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                <div className="flex gap-2">
                  <button onClick={() => {
                    if (!nbAddContent.trim()) return;
                    setNbSources(prev => [...prev, { id: crypto.randomUUID(), title: nbAddTitle.trim() || `소스 ${prev.length + 1}`, content: nbAddContent.trim(), created_at: new Date().toISOString() }]);
                    setNbAddTitle(''); setNbAddContent(''); setNbAdding(false);
                  }} className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 rounded-lg text-[11px] font-bold transition-all">추가</button>
                  <button onClick={() => { setNbAdding(false); setNbAddTitle(''); setNbAddContent(''); }}
                    className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-[11px] text-slate-400 transition-all">취소</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setNbAdding(true)}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-500 rounded-xl text-[11px] font-bold transition-all shadow-sm">+ 소스 추가</button>
            )}
          </div>
        );

        // Steps 1–2: 텍스트에어리어
        return (
          <div key={s.label} className={`p-4 sm:p-5 ${sc.activeBg} ${hidden ? 'hidden' : ''}`}>
            <p className="text-[11px] text-slate-400 mb-3">{s.desc}</p>
            <textarea value={s.value ?? ''} onChange={e => s.onChange?.(e.target.value)} rows={10}
              className="w-full bg-white/[0.04] border-0 ring-1 ring-white/[0.08] rounded-xl px-4 py-3.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
              placeholder={s.placeholder} />
          </div>
        );
      })}
    </div>
  );
}
