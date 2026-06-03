'use client';

import React from 'react';
import { Panel, Sel } from '@/components/ui';
import type { StrategyConfig } from '../../types';

export function StrategySettingsPanel({ strategy, setField }: {
  strategy: StrategyConfig | null;
  setField: (field: string, val: string | number | boolean) => Promise<void>;
}) {
  if (!strategy) return null;
  return (
    <Panel title="전략 설정" badge={strategy.mode === 'SWING' ? '스윙' : strategy.mode === 'DEFENSE' ? '방어' : strategy.mode === 'SNIPER' ? '저격수' : '단타'} badgeColor={strategy.mode === 'SWING' ? 'blue' : strategy.mode === 'DEFENSE' ? 'rose' : strategy.mode === 'SNIPER' ? 'amber' : 'amber'}>
      <div className="px-6 py-5 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Sel label="매매 방식" value={String(strategy.mode ?? 'SWING')} opts={[['SWING','스윙 (중단기)'],['DEFENSE','방어 (하락장)'],['SCALPING','단타 (당일)'],['SNIPER','🎯 저격수 (AI 88점+ 2종목 집중)']]} onChange={v => setField('mode', v)} />
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
      </div>
    </Panel>
  );
}
