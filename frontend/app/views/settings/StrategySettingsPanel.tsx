'use client';

import React from 'react';
import { Panel, Sel } from '@/components/ui';
import { api } from '../../lib/utils';
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

const DEFAULT_ENSEMBLE: EnsembleConfig = {
  weights: { gemini: 0.30, gpt: 0.35, claude: 0.20, rss: 0.15 },
  strategy: 'weighted_avg',
  minModels: 2,
};

export function StrategySettingsPanel({ strategy, setField, viewMode = 'live' }: {
  strategy: StrategyConfig | null;
  setField: (field: string, val: string | number | boolean) => Promise<void>;
  viewMode?: 'live' | 'paper';
}) {
  if (!strategy) return null;

  const isEnsemble = strategy.ai_scoring_mode === 'ensemble';
  const ec: EnsembleConfig = strategy.ensemble_config ?? DEFAULT_ENSEMBLE;

  const saveEnsembleConfig = async (patch: Partial<EnsembleConfig>) => {
    const next = { ...ec, ...patch };
    try {
      const body = { ...strategy, ai_scoring_mode: strategy.ai_scoring_mode, ensemble_config: next };
      await api(`/strategy?viewMode=${viewMode}`, { method: 'PUT', body: JSON.stringify(body) });
    } catch { /* setField will show error */ }
  };

  const setWeight = async (model: keyof EnsembleConfig['weights'], val: number) => {
    const weights = { ...ec.weights, [model]: val };
    await saveEnsembleConfig({ weights });
  };

  return (
    <Panel title="전략 설정" badge={strategy.mode === 'SWING' ? '스윙' : strategy.mode === 'DEFENSE' ? '방어' : strategy.mode === 'SNIPER' ? '저격수' : '스윙'} badgeColor={strategy.mode === 'SWING' ? 'blue' : strategy.mode === 'DEFENSE' ? 'rose' : strategy.mode === 'SNIPER' ? 'amber' : 'blue'}>
      <div className="px-6 py-5 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Sel label="매매 방식" value={String(strategy.mode ?? 'SWING')} opts={[['SWING','스윙 (중단기)'],['DEFENSE','방어 (하락장)'],['SNIPER','저격수 (AI 88점+ 2종목 집중)']]} onChange={v => setField('mode', v)} />
          <Sel label="AI 확신도 (높을수록 신중)" value={Number(strategy.buy_threshold ?? 83)} opts={[[70,'70점'],[75,'75점'],[78,'78점'],[80,'80점'],[83,'83점 (현재)'],[85,'85점'],[88,'88점'],[90,'90점']]} onChange={v => setField('buy_threshold', Number(v))} />
          {!strategy.use_dynamic_tpsl && (
            <Sel label="손실 한계 (이 이상 빠지면 매도)" value={Number(strategy.stop_loss_pct ?? -3)} opts={[[-1.5,'-1.5% (타이트)'],[-2,'-2%'],[-2.5,'-2.5%'],[-3,'-3% (현재)'],[-4,'-4%'],[-5,'-5% (여유)']]} onChange={v => setField('stop_loss_pct', Number(v))} />
          )}
          {!strategy.use_dynamic_tpsl && (
            <Sel label="목표 수익 (이 이상 오르면 매도)" value={Number(strategy.take_profit_pct ?? 5.5)} opts={[[3,'+3%'],[4,'+4%'],[5,'+5%'],[5.5,'+5.5% (현재)'],[6,'+6%'],[7,'+7%'],[8,'+8%']]} onChange={v => setField('take_profit_pct', Number(v))} />
          )}
        </div>
        {/* 동적 TP/SL 토글 */}
        <div
          className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-all cursor-pointer ${strategy.use_dynamic_tpsl ? 'bg-violet-500/10 border-violet-500/40' : 'bg-white/[0.03] border-white/[0.06] hover:border-white/[0.10]'}`}
          onClick={() => setField('use_dynamic_tpsl', !strategy.use_dynamic_tpsl)}
        >
          <div>
            <p className="text-xs font-bold text-slate-200">동적 TP/SL <span className="text-[10px] font-normal text-slate-500 ml-1">— AI 진입 품질 기반 자동 계산</span></p>
            {strategy.use_dynamic_tpsl ? (
              <p className="text-[10px] text-violet-400 mt-0.5">ON — 점수·RSI·거래량·눌림 신호로 종목마다 다른 목표/손절 설정</p>
            ) : (
              <p className="text-[10px] text-slate-500 mt-0.5">OFF — 위에서 설정한 고정 수치 사용 (기본값)</p>
            )}
          </div>
          <div className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${strategy.use_dynamic_tpsl ? 'bg-violet-600' : 'bg-white/[0.08]'}`}>
            <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${strategy.use_dynamic_tpsl ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
        </div>
        {strategy.use_dynamic_tpsl && (
          <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl px-4 py-3 text-[11px] text-slate-400 leading-5">
            <span className="text-violet-300 font-bold">점수별 예시:</span>{' '}
            93점+ → TP 8.5% / SL -2.5% &nbsp;|&nbsp;
            88점+ → TP 7.5% / SL -2.8% &nbsp;|&nbsp;
            83점+ → TP 6.5% / SL -3.0%<br/>
            <span className="text-slate-500">+ 눌림신호 +0.5% · 거래량3배 +1.0% · RSI과매도 +0.5% · 확신도0.85+ +0.5%</span>
          </div>
        )}

        {/* 앙상블 AI 스코어링 토글 */}
        <div
          className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-all cursor-pointer ${isEnsemble ? 'bg-cyan-500/10 border-cyan-500/40' : 'bg-white/[0.03] border-white/[0.06] hover:border-white/[0.10]'}`}
          onClick={() => setField('ai_scoring_mode', isEnsemble ? 'fallback' : 'ensemble')}
        >
          <div>
            <p className="text-xs font-bold text-slate-200">앙상블 AI <span className="text-[10px] font-normal text-slate-500 ml-1">— 다중 모델 병렬 합산</span></p>
            {isEnsemble ? (
              <p className="text-[10px] text-cyan-400 mt-0.5">ON — Gemini + GPT + Claude + RSS 동시 실행, 가중 평균 합산</p>
            ) : (
              <p className="text-[10px] text-slate-500 mt-0.5">OFF — 순차 폴백 (Gemini → Flash → RSS → Claude → 기술적)</p>
            )}
          </div>
          <div className={`w-11 h-6 rounded-full transition-all relative flex-shrink-0 ${isEnsemble ? 'bg-cyan-600' : 'bg-white/[0.08]'}`}>
            <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${isEnsemble ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
        </div>

        {/* 앙상블 상세 설정 */}
        {isEnsemble && (
          <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl px-4 py-4 space-y-3">
            {/* 합산 전략 + 최소 모델 */}
            <div className="grid grid-cols-2 gap-3">
              <Sel
                label="합산 전략"
                value={ec.strategy}
                opts={[['weighted_avg','가중 평균'],['majority_vote','다수결 투표'],['conservative','보수적 (최저)']]}
                onChange={v => saveEnsembleConfig({ strategy: v as EnsembleConfig['strategy'] })}
              />
              <Sel
                label="최소 모델 수"
                value={ec.minModels}
                opts={[[1,'1개 (느슨)'],[2,'2개 (기본)'],[3,'3개 (엄격)']]}
                onChange={v => saveEnsembleConfig({ minModels: Number(v) })}
              />
            </div>

            {/* 모델별 가중치 */}
            <div className="space-y-2">
              <p className="text-[10px] text-slate-400 font-medium">모델별 가중치 (합계 1.0 권장, 자동 정규화됨)</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(Object.keys(ec.weights) as Array<keyof EnsembleConfig['weights']>).map(model => (
                  <div key={model} className="flex flex-col gap-1">
                    <span className="text-[10px] text-slate-400">{MODEL_LABELS[model]}</span>
                    <input
                      type="range" min="0" max="100" step="5"
                      value={Math.round(ec.weights[model] * 100)}
                      onChange={e => setWeight(model, Number(e.target.value) / 100)}
                      className="w-full h-1.5 bg-white/[0.08] rounded-full appearance-none cursor-pointer accent-cyan-500"
                    />
                    <span className="text-[10px] text-cyan-400 text-center font-mono">{(ec.weights[model] * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-[10px] text-slate-500 leading-4">
              API 키 미설정 모델은 자동 스킵되고, 나머지 모델의 가중치가 재분배됩니다.
              GPT-4o 사용 시 OPENAI_API_KEY 설정 필요.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}
