'use client';

import React from 'react';
import { Panel, Button } from '@/components/ui';

export function KillSwitchPanel({ killSwitch, toggleKill }: { killSwitch: any; toggleKill: (scope?: 'KR' | 'OVERSEAS') => void }) {
  return (
    <Panel title="긴급 제어">
      <div className="px-6 py-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">자동매매 제어</p>
            <p className={`text-[12px] mt-1 font-medium ${(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? 'text-rose-400' : 'text-emerald-400'}`}>
              현재: {(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? '매매 중단 중' : '자동매매 실행 중'}
            </p>
          </div>
          <Button
            variant={(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? 'success' : 'danger'}
            size="sm"
            className="px-5 py-2.5 shrink-0"
            onClick={() => toggleKill()}
          >
            {(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? '▶ 전체 재개' : '⏸ 전체 중단'}
          </Button>
        </div>
        {/* 국내/해외 개별 상태 */}
        {(killSwitch?.kr?.active || killSwitch?.overseas?.active) && (
          <div className="space-y-2 pt-2 border-t border-white/[0.06]">
            {killSwitch?.kr?.active && (
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-rose-400">국내 (KR) 중단 중</p>
                  {killSwitch.kr.reason && <p className="text-[10px] text-slate-500 mt-0.5 truncate">{killSwitch.kr.reason}</p>}
                </div>
                <Button variant="amber" size="sm" className="shrink-0 text-[11px]" onClick={() => toggleKill('KR')}>
                  국내 해제
                </Button>
              </div>
            )}
            {killSwitch?.overseas?.active && (
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-violet-400">해외 (US) 중단 중</p>
                  {killSwitch.overseas.reason && <p className="text-[10px] text-slate-500 mt-0.5 truncate">{killSwitch.overseas.reason}</p>}
                </div>
                <Button variant="violet" size="sm" className="shrink-0 text-[11px]" onClick={() => toggleKill('OVERSEAS')}>
                  해외 해제
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
