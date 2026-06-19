'use client';

import React from 'react';
import { Panel } from '@/components/ui';
import type { StrategyConfig, EnsembleConfig } from '../../types';

const STRATEGY_LABELS: Record<string, string> = {
  weighted_avg: '가중 평균',
  majority_vote: '다수결 투표',
  conservative: '보수적 (최저점수)',
};

const MODEL_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  gpt: 'GPT-4o',
  claude: 'Claude',
  rss: 'RSS/NLP',
};

const MODE_LABELS: Record<string, string> = {
  SWING: '스윙 (중단기)',
  DEFENSE: '방어 (하락장)',
  SNIPER: '저격수 (AI 88점+ 집중)',
};

const DEFAULT_ENSEMBLE: EnsembleConfig = {
  weights: { gemini: 0.30, gpt: 0.35, claude: 0.20, rss: 0.15 },
  strategy: 'weighted_avg',
  minModels: 2,
};

export function StrategySettingsPanel({ strategy }: {
  strategy: StrategyConfig | null;
  setField?: (field: string, val: string | number | boolean) => Promise<void>;
  viewMode?: 'live' | 'paper';
}) {
  if (!strategy) return null;

  const ec: EnsembleConfig = strategy.ensemble_config ?? DEFAULT_ENSEMBLE;

  return (
    <Panel title="전략 설정" badge="AI 자동 관리" badgeColor="blue">
      <div className="px-6 py-5 space-y-4">
        {/* AI 자동 관리 배지 */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-violet-500/10 border border-violet-500/30 rounded-xl">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-[11px] text-violet-300 font-medium">AI가 시장 상황과 학습 데이터를 기반으로 자동 최적화 중</span>
        </div>

        {/* 현재 설정값 읽기전용 표시 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatusCard label="매매 방식" value={MODE_LABELS[strategy.mode ?? 'SWING'] ?? strategy.mode ?? 'SWING'} />
          <StatusCard label="AI 확신도" value={`${strategy.buy_threshold ?? 83}점`} />
          <StatusCard label="동적 TP/SL" value="ON" highlight />
          <StatusCard label="앙상블 AI" value="ON" highlight />
        </div>

        {/* 동적 TP/SL 설명 */}
        <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl px-4 py-3 text-[11px] text-slate-400 leading-5">
          <span className="text-violet-300 font-bold">동적 TP/SL:</span>{' '}
          AI 진입 품질(점수/RSI/거래량/눌림) 기반으로 종목마다 최적 목표가/손절가 자동 계산
        </div>

        {/* 앙상블 가중치 읽기전용 */}
        <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl px-4 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-cyan-300 font-bold">앙상블 가중치 (AI 자동 튜닝)</p>
            <span className="text-[9px] bg-cyan-900/40 text-cyan-400 px-2 py-0.5 rounded-full ring-1 ring-cyan-500/20">
              {STRATEGY_LABELS[ec.strategy] ?? ec.strategy} / 최소 {ec.minModels}모델
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(Object.keys(ec.weights) as Array<keyof EnsembleConfig['weights']>).map(model => (
              <div key={model} className="flex flex-col items-center gap-1 bg-white/[0.03] rounded-lg px-3 py-2">
                <span className="text-[10px] text-slate-400">{MODEL_LABELS[model]}</span>
                <div className="w-full bg-white/[0.06] rounded-full h-1.5">
                  <div
                    className="bg-cyan-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.round(ec.weights[model] * 100)}%` }}
                  />
                </div>
                <span className="text-[11px] text-cyan-400 font-mono font-bold">{(ec.weights[model] * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 leading-4">
            자기학습 시스템이 모델별 실거래 성과를 분석하여 가중치를 자동 조정합니다.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function StatusCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-3 py-2.5 text-center">
      <p className="text-[10px] text-slate-500 mb-0.5">{label}</p>
      <p className={`text-sm font-bold ${highlight ? 'text-violet-400' : 'text-slate-200'}`}>{value}</p>
    </div>
  );
}
