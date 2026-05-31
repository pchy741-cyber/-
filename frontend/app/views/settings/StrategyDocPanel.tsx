'use client';

import React from 'react';

export function StrategyDocPanel({ strategyDoc, setStrategyDoc, riskPrompt, setRiskPrompt, strategyDocTab, setStrategyDocTab, onSave }: {
  strategyDoc: string;
  setStrategyDoc: (v: string) => void;
  riskPrompt: string;
  setRiskPrompt: (v: string) => void;
  strategyDocTab: 'doc' | 'risk';
  setStrategyDocTab: (v: 'doc' | 'risk') => void;
  onSave: () => void;
}) {
  return (
    <div className="glass rounded-2xl overflow-hidden shadow-xl shadow-black/40">
      <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-100">나의 매매 철학 & 위기 대응</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">AI가 판단을 내릴 때 참고하는 나만의 투자 원칙을 적어두세요</p>
        </div>
        <button onClick={onSave} className="px-4 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-xs font-semibold transition-all shadow-sm">저장</button>
      </div>
      {/* 탭 */}
      <div className="flex border-b border-white/[0.04]">
        {([['doc', '전략서', '매매 철학·원칙'], ['risk', '리스크 프롬프트', 'AI 리스크 판단 지시']] as const).map(([id, label, sub]) => (
          <button key={id} onClick={() => setStrategyDocTab(id)}
            className={`flex-1 py-3 px-4 text-left transition-all relative ${strategyDocTab === id ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}>
            {strategyDocTab === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 to-fuchsia-500" />}
            <div className="text-[11px] font-bold text-slate-200">{label}</div>
            <div className="text-[9px] text-slate-600 mt-0.5">{sub}</div>
          </button>
        ))}
      </div>
      {strategyDocTab === 'doc' && (
        <div className="p-4 sm:p-5 bg-violet-950/10">
          <p className="text-[11px] text-slate-400 mb-3">
            매매 철학, 종목 선정 기준, 시장 상황별 대응 원칙 등을 자유롭게 작성하세요.
            AI 분석 맥락에 주입됩니다.
          </p>
          <textarea
            value={strategyDoc}
            onChange={e => setStrategyDoc(e.target.value)}
            rows={16}
            placeholder={`# 매매 전략서\n\n## 투자 철학\n- 추세 추종 + 분할 매수로 리스크 분산\n- 손절은 기계적으로, 익절은 단계적으로`}
            className="w-full bg-white/[0.04] border-0 ring-1 ring-violet-500/20 rounded-xl px-4 py-3.5 text-[12px] leading-relaxed resize-y font-mono text-slate-200 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
          />
        </div>
      )}
      {strategyDocTab === 'risk' && (
        <div className="p-4 sm:p-5 bg-rose-950/10">
          <p className="text-[11px] text-slate-400 mb-3">
            리스크 상황별 AI 판단 지시사항입니다. 급락장·하락장 대응, 포지션 축소 기준, 대통령 발언 등 외부 충격 대응 원칙을 작성하세요.
          </p>
          <textarea
            value={riskPrompt}
            onChange={e => setRiskPrompt(e.target.value)}
            rows={16}
            placeholder={`## 리스크 운영 지시사항\n\n### 하락장 감지 시\n- 전 종목 신규 매수 금지`}
            className="w-full bg-white/[0.04] border-0 ring-1 ring-rose-500/20 rounded-xl px-4 py-3.5 text-[12px] leading-relaxed resize-y font-mono text-slate-200 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-rose-500/40 transition-all"
          />
        </div>
      )}
    </div>
  );
}
