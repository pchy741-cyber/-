'use client';

import React from 'react';
import { Button } from '@/components/ui';

const TEMPLATES = [
  '거래량이 평균의 3배 이상 터질 때만 진입 — 작은 거래량 돌파는 페이크',
  '코스피 200일선 아래에서는 신규 매수 금지, 보유 종목 50% 이하로 유지',
  '개별 종목 최대 투자금은 전체 계좌의 20% 이하 유지',
  '매수 후 -7% 닿으면 이유 불문 손절 — 오를 거라는 기대 금지',
  '외국인/기관 순매도 전환 시 보유 중이면 다음날 개장에 50% 매도',
  '실적 발표 전날 신규 매수 금지 — 발표 후 반응 보고 진입',
  '상한가 다음날 추격 매수 금지 — 단타꾼 물량 출하 시점',
  '하락장(코스피 -1.5% 이상)에선 AI 점수 80점 이상만 매수 허용',
];

export function InsightsAddForm({ newInsight, setNewInsight, onAdd, adding }: {
  newInsight: string;
  setNewInsight: (v: string) => void;
  onAdd: () => void;
  adding: boolean;
}) {
  return (
    <div className="px-4 py-3 border-b border-white/[0.04] bg-purple-900/10 space-y-2">
      <div className="flex gap-2">
        <input
          value={newInsight}
          onChange={e => setNewInsight(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onAdd()}
          placeholder="예: 공매도 과열 종목은 반드시 제외할 것"
          className="flex-1 bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-purple-500/50"
        />
        <Button variant="violet" size="sm" disabled={adding} onClick={onAdd}>
          {adding ? '저장중...' : '저장'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATES.map(t => (
          <button key={t} onClick={() => setNewInsight(t)}
            className="text-[9px] bg-purple-900/30 hover:bg-purple-900/60 text-purple-300 px-2 py-1 rounded-md transition-all text-left leading-tight max-w-[180px] truncate">
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
