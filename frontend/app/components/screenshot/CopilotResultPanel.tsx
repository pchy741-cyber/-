'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui';
import type { CopilotData, XrayData } from './screenshot-types';

function RiskGauge({ item }: { item: CopilotData['risk'][0] }) {
  const pct = Math.max(0, Math.min(100, (item.value / item.max) * 100));
  const barColor = item.level === 'danger' ? 'bg-red-500' : item.level === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  const textColor = item.level === 'danger' ? 'text-red-400' : item.level === 'warn' ? 'text-amber-400' : 'text-emerald-400';
  return (
    <div className="flex items-center gap-3">
      <div className="w-20 text-[10px] text-slate-400 shrink-0">{item.label}</div>
      <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
      <div className={`w-14 text-right text-xs font-bold tabular-nums ${textColor}`}>
        {item.value}{item.unit}
      </div>
    </div>
  );
}

export function CopilotResultPanel({ copilot, xray, healthScore, screenshotCount, onDownload, onCopy, onClose }: {
  copilot: CopilotData | null;
  xray: XrayData | null;
  healthScore: number;
  screenshotCount: number;
  onDownload: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const [activeSection, setActiveSection] = useState<'integrity' | 'risk' | 'actions'>('risk');

  const scoreColor = (s: number) => s >= 80 ? 'text-emerald-400' : s >= 50 ? 'text-amber-400' : 'text-red-400';
  const scoreBg = (s: number) => s >= 80 ? 'from-emerald-500/20 to-emerald-700/10 border-emerald-500/30' : s >= 50 ? 'from-amber-500/20 to-amber-700/10 border-amber-500/30' : 'from-red-500/20 to-red-700/10 border-red-500/30';

  const dangerCount = (copilot ? copilot.integrity.filter(i => i.status === 'danger').length + copilot.risk.filter(r => r.level === 'danger').length : 0)
    + (xray?.summary.danger ?? 0);
  const warnCount = (copilot ? copilot.integrity.filter(i => i.status === 'warn').length + copilot.risk.filter(r => r.level === 'warn').length : 0)
    + (xray?.summary.warn ?? 0);
  const highActions = copilot?.actions.filter(a => a.urgency === 'high').length ?? 0;

  return (
    <div className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="w-full sm:w-[440px] max-h-[90vh] bg-[#0a0e1a] border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className={`bg-gradient-to-b ${scoreBg(healthScore)} px-5 pt-5 pb-4 shrink-0`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">Copilot</h3>
              <p className="text-[10px] text-slate-400 mt-0.5">{copilot?.mode.toUpperCase() ?? xray?.mode.toUpperCase()} | {screenshotCount}장 캡처{xray ? ` | X-Ray ${xray.summary.danger}D/${xray.summary.warn}W` : ''}</p>
            </div>
            <div className="text-center">
              <div className={`text-3xl font-black tracking-tighter ${scoreColor(healthScore)}`}>{healthScore}</div>
              <div className="text-[10px] text-slate-500 font-semibold tracking-wider">HEALTH</div>
            </div>
          </div>
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {dangerCount > 0 && <span className="text-[9px] bg-red-500/20 text-red-300 border border-red-500/30 rounded-full px-2 py-0.5 font-semibold">위험 {dangerCount}</span>}
            {warnCount > 0 && <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5 font-semibold">주의 {warnCount}</span>}
            {highActions > 0 && <span className="text-[9px] bg-orange-500/20 text-orange-300 border border-orange-500/30 rounded-full px-2 py-0.5 font-semibold">긴급 {highActions}</span>}
            {dangerCount === 0 && warnCount === 0 && highActions === 0 && (
              <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full px-2 py-0.5 font-semibold">정상</span>
            )}
          </div>
        </div>

        {/* 탭 네비게이션 */}
        <div className="flex border-b border-white/5 shrink-0">
          {([
            { key: 'integrity' as const, label: '정합성', count: (copilot?.integrity.filter(i => i.status !== 'ok').length ?? 0) + (xray?.summary.danger ?? 0) + (xray?.summary.warn ?? 0) },
            { key: 'risk' as const, label: '리스크', count: copilot?.risk.filter(r => r.level !== 'ok').length ?? 0 },
            { key: 'actions' as const, label: '액션', count: copilot?.actions.length ?? 0 },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveSection(tab.key)}
              className={`flex-1 py-2.5 text-[11px] font-semibold transition-colors relative ${
                activeSection === tab.key ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className={`ml-1 text-[10px] px-1 py-px rounded-full font-bold ${
                  activeSection === tab.key ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                }`}>{tab.count}</span>
              )}
              {activeSection === tab.key && <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-blue-500 rounded-full" />}
            </button>
          ))}
        </div>

        {/* 콘텐츠 영역 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {activeSection === 'integrity' && [
            ...(copilot?.integrity ?? []),
            ...(xray?.checks ?? []).map(c => ({ ...c, _xray: true })),
          ].map((item: any, i) => (
            <div key={i} className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-xs ${
              item.status === 'danger' ? 'bg-red-950/40 border border-red-500/20' :
              item.status === 'warn' ? 'bg-amber-950/40 border border-amber-500/20' :
              'bg-emerald-950/20 border border-emerald-500/10'
            }`}>
              <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black ${
                item.status === 'danger' ? 'bg-red-600/30 text-red-300' :
                item.status === 'warn' ? 'bg-amber-600/30 text-amber-300' :
                'bg-emerald-600/30 text-emerald-300'
              }`}>{item.status === 'danger' ? '!' : item.status === 'warn' ? '?' : '\u2713'}</span>
              <div className="flex-1 min-w-0">
                <div className={`font-semibold ${
                  item.status === 'danger' ? 'text-red-300' :
                  item.status === 'warn' ? 'text-amber-300' :
                  'text-emerald-400'
                }`}>{item.label}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {item._xray && <span className="text-[10px] bg-violet-500/20 text-violet-300 border border-violet-500/30 rounded px-1 font-bold">X-RAY</span>}
                  <span className="text-slate-500 text-[10px] break-all">{item.detail}</span>
                </div>
              </div>
            </div>
          ))}

          {activeSection === 'risk' && (
            <div className="space-y-3">
              {(copilot?.risk ?? []).length === 0 ? (
                <div className="text-center text-slate-500 text-xs py-6">데이터 수집 중...</div>
              ) : (copilot?.risk ?? []).map((item, i) => (
                <RiskGauge key={i} item={item} />
              ))}
            </div>
          )}

          {activeSection === 'actions' && (
            <div className="space-y-2">
              {(copilot?.actions ?? []).length === 0 ? (
                <div className="text-center text-emerald-400/60 text-xs py-6">이상 없음 — 현재 포트폴리오 정상</div>
              ) : (copilot?.actions ?? []).map((action, i) => {
                const colors = {
                  cut_loss: { bg: 'bg-red-950/40', border: 'border-red-500/20', text: 'text-red-300', icon: 'bg-red-600/30 text-red-300' },
                  take_profit: { bg: 'bg-emerald-950/30', border: 'border-emerald-500/20', text: 'text-emerald-300', icon: 'bg-emerald-600/30 text-emerald-300' },
                  rebalance: { bg: 'bg-blue-950/30', border: 'border-blue-500/20', text: 'text-blue-300', icon: 'bg-blue-600/30 text-blue-300' },
                  anomaly: { bg: 'bg-amber-950/30', border: 'border-amber-500/20', text: 'text-amber-300', icon: 'bg-amber-600/30 text-amber-300' },
                  opportunity: { bg: 'bg-violet-950/30', border: 'border-violet-500/20', text: 'text-violet-300', icon: 'bg-violet-600/30 text-violet-300' },
                }[action.type] ?? { bg: 'bg-slate-800', border: 'border-white/5', text: 'text-slate-300', icon: 'bg-slate-700 text-slate-300' };

                return (
                  <div key={i} className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-xs ${colors.bg} border ${colors.border}`}>
                    <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black ${colors.icon}`}>
                      {action.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold ${colors.text}`}>{action.title}</span>
                        {action.urgency === 'high' && <span className="text-[10px] bg-red-500/30 text-red-300 px-1.5 py-px rounded-full font-bold animate-pulse">URGENT</span>}
                      </div>
                      <div className="text-slate-500 text-[10px] mt-0.5">{action.detail}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 하단 액션 바 */}
        <div className="flex gap-2 px-4 py-3 border-t border-white/5 shrink-0 bg-[#0a0e1a]">
          <Button variant="secondary" size="sm" className="flex-1 flex items-center justify-center gap-1 text-[11px] border border-white/10" onClick={onDownload}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {screenshotCount}장
          </Button>
          <Button variant="secondary" size="sm" className="flex-1 flex items-center justify-center gap-1 text-[11px] border border-white/10" onClick={onCopy}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            복사
          </Button>
          <Button variant="secondary" size="sm" className="px-4 text-[11px] text-slate-400 border border-white/10" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
