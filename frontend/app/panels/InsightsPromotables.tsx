'use client';

import React from 'react';
import { Button } from '@/components/ui';
import { categoryColor, categoryLabel } from './insight-types';

interface PromotableInsight {
  id: string | number;
  category?: string;
  insight?: string;
  content?: string;
  confidence?: number;
  sample_count?: number;
  recommendation?: string;
}

export function InsightsPromotables({ promotables, promoting, onPromote }: {
  promotables: PromotableInsight[];
  promoting: string | null;
  onPromote: (id: string | number) => void | Promise<void>;
}) {
  if (promotables.length === 0) return null;

  return (
    <div className="border-t border-cyan-900/30 bg-cyan-950/10">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cyan-900/20">
        <span className="text-[11px] font-semibold text-cyan-300">연습모드 추천</span>
        <span className="text-[9px] text-cyan-600">연습에서 검증된 좋은 패턴 — 실전 적용 시 신뢰도 0.7x</span>
        <span className="ml-auto text-[9px] bg-cyan-900/40 text-cyan-400 px-1.5 py-0.5 rounded-full">{promotables.length}개</span>
      </div>
      <div className="divide-y divide-cyan-900/10 max-h-48 overflow-y-auto">
        {promotables.map((p) => (
          <div key={p.id} className="px-4 py-2.5 hover:bg-cyan-900/10 transition-colors">
            <div className="flex items-start gap-3">
              <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5 ${categoryColor[p.category ?? ''] ?? 'text-slate-400 bg-slate-800'}`}>
                {categoryLabel[p.category ?? ''] ?? p.category}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-slate-300 leading-relaxed">{p.insight ?? p.content}</p>
                <p className="text-[9px] text-slate-500 mt-0.5">
                  신뢰도 {Math.round((p.confidence ?? 0) * 100)}% · 샘플 {p.sample_count ?? 0}건
                  {p.recommendation && <span className="text-cyan-500/60 ml-1.5">{'→'} {p.recommendation}</span>}
                </p>
              </div>
              <Button variant="ghost" size="sm" className="shrink-0 text-[10px] bg-cyan-800/50 hover:bg-cyan-700/70 text-cyan-200"
                disabled={promoting === p.id} onClick={() => onPromote(p.id)}>
                {promoting === p.id ? '적용중...' : '실전 적용'}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
