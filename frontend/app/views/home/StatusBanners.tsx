'use client';

import React from 'react';
import { Button } from '@/components/ui';
import { api } from '../../lib/utils';
import type { Dashboard, DefensePark, TradingStatus, TradingStatusBlock, AiStatus, ToastFn, ConfirmFn } from '../../types';

interface StatusBannersProps {
  dash: Dashboard | null;
  busyAction: string | null;
  guard: (key: string, fn: () => Promise<void>) => () => Promise<void>;
  toast: ToastFn;
  onRefresh: () => void;
  tradingStatus: TradingStatus | null;
  aiStatus: AiStatus | null;
  defensePark: DefensePark | undefined;
  confirm: ConfirmFn;
}

export default function StatusBanners({ dash, busyAction, guard, toast, onRefresh, tradingStatus, aiStatus, defensePark, confirm }: StatusBannersProps) {
  return (
    <>
      {/* ── 연속손실 쿨다운 배너 ── */}
      {(dash?.cooldown?.active || dash?.cooldown?.eodOnly) && (
        <div className="rounded-2xl border border-orange-500/50 bg-orange-500/10 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-base shrink-0">{dash.cooldown.eodOnly ? '🎰' : '🔒'}</span>
            <span className="text-sm font-bold text-orange-300">{dash.cooldown.eodOnly ? 'EOD-only 모드' : '매수 쿨다운 중'}</span>
            <span className="text-[11px] text-orange-200/70 ml-1">{dash.cooldown.eodOnly ? `${dash.cooldown.consecutive}연패 → 장중매수 차단, 종가베팅만 허용` : dash.cooldown.reason}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto bg-orange-500/20 hover:bg-orange-500/40 text-orange-200 shrink-0"
              disabled={!!busyAction}
              onClick={guard('cooldown', async () => {
                if (!await confirm({ title: `${dash!.cooldown!.consecutive}연패 쿨다운을 수동으로 해제할까요?`, description: '나는 이 결정에 책임집니다', confirmLabel: '쿨다운 해제', confirmVariant: 'danger' })) return;
                try {
                  await api('/cooldown/reset', { method: 'POST' });
                  toast?.('쿨다운 해제 완료 — 다음 루프에서 매수 재개', 'ok');
                  onRefresh();
                } catch (e: unknown) { toast?.('실패: ' + (e as Error).message, 'err'); }
              })}
            >🔓 쿨다운 수동 해제</Button>
          </div>
        </div>
      )}

      {/* ── 매매 상태 배너 ── */}
      {tradingStatus && tradingStatus.overallStatus !== 'ACTIVE' && (
        <div className={`rounded-2xl border px-4 py-3 ${
          tradingStatus.overallStatus === 'BLOCKED'
            ? 'border-rose-500/40 bg-rose-500/10'
            : 'border-amber-500/30 bg-amber-500/[0.07]'
        }`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
            <span className="text-base shrink-0">{tradingStatus.overallStatus === 'BLOCKED' ? '🚫' : '👀'}</span>
            <span className={`text-sm font-bold whitespace-nowrap ${tradingStatus.overallStatus === 'BLOCKED' ? 'text-rose-300' : 'text-amber-300'}`}>
              {tradingStatus.overallStatus === 'BLOCKED' ? '매수 완전 차단 중' : '관망 중'}
            </span>
            <span className="text-[10px] text-slate-500 ml-auto whitespace-nowrap">{tradingStatus.mode} · {tradingStatus.buyThreshold}점</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(tradingStatus.blocks ?? []).map((b: TradingStatusBlock, i: number) => (
              <div key={i} className={`flex items-center gap-1.5 text-[11px] rounded-lg px-2.5 py-1 ${
                b.severity === 'warn' ? 'bg-amber-500/15 text-amber-300' : 'bg-white/[0.04] text-slate-400'
              }`}>
                <span className="font-semibold">{b.reason}</span>
                <span className="text-[10px] opacity-70">— {b.detail}</span>
              </div>
            ))}
          </div>
          {(tradingStatus.topScore ?? 0) > 0 && (
            <div className="mt-2 text-[10px] text-slate-500">
              감시종목 최고점수 <b className="text-slate-300">{tradingStatus.topScore}점</b> / 기준 <b className="text-slate-300">{tradingStatus.buyThreshold}점</b>
              {(tradingStatus.candidateCount ?? 0) > 0 && <span className="ml-2 text-emerald-400">→ {tradingStatus.candidateCount}종목 후보 있음</span>}
            </div>
          )}
          {tradingStatus.mode === 'DEFENSE' && (
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="bg-rose-500/20 hover:bg-rose-500/40 text-rose-200"
                disabled={!!busyAction}
                onClick={guard('defense', async () => {
                  if (!await confirm({ title: 'DEFENSE 모드를 해제하고 SWING 매매(기준 70점)로 복귀할까요?', confirmLabel: 'DEFENSE 해제', confirmVariant: 'danger' })) return;
                  try {
                    const r = await api('/defense-mode/deactivate', { method: 'POST' });
                    toast?.(r?.message ?? 'DEFENSE 모드 해제 완료', 'ok');
                    onRefresh();
                  } catch (e: unknown) { toast?.('실패: ' + (e as Error).message, 'err'); }
                })}
              >🔓 DEFENSE 모드 수동 해제</Button>
            </div>
          )}
        </div>
      )}
      {tradingStatus && tradingStatus.overallStatus === 'ACTIVE' && (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="text-xs font-semibold text-emerald-300 whitespace-nowrap">자동매매 정상 운영 중</span>
          {(tradingStatus.candidateCount ?? 0) > 0 && (
            <span className="text-xs text-emerald-400/70">— {tradingStatus.candidateCount}종목 대기</span>
          )}
          <span className="text-[10px] text-slate-500 whitespace-nowrap">{tradingStatus.mode} · {tradingStatus.buyThreshold}점</span>
          {tradingStatus.kospiRegime?.boost && (
            <span className="text-[10px] text-emerald-400/80">🚀 KOSPI 상승장 부스트</span>
          )}
        </div>
      )}

      {/* ── KOSPI 레짐 상세 배너 (Live penalty >= 2 + 오버라이드 버튼) ── */}
      {tradingStatus && !tradingStatus.kospiRegime?.flashCrash && (tradingStatus.kospiRegime?.penalty ?? 0) >= 2 && tradingStatus.kospiRegime?.todayDown && (
        <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/[0.06] px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-base shrink-0">📉</span>
            <span className="text-sm font-bold text-yellow-300">KOSPI 하락장 (Live 매수 차단)</span>
            <span className="text-[11px] text-yellow-200/70 ml-1">KOSPI MA60 하회 + 당일 하락 — Paper는 정상 운영 중</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto bg-yellow-500/20 hover:bg-yellow-500/40 text-yellow-200 shrink-0"
              disabled={!!busyAction}
              onClick={guard('kospi-override', async () => {
                if (!await confirm({ title: 'KOSPI 하락장 차단을 이번 세션만 우회할까요?', description: '오늘 하루 동안만 Live 매수를 허용합니다. 리스크는 본인 책임입니다.', confirmLabel: '하락장 우회 (오늘만)', confirmVariant: 'danger' })) return;
                try {
                  await api('/kospi-regime/override', { method: 'POST' });
                  toast?.('KOSPI 레짐 차단 우회 완료 — 다음 루프에서 매수 재개', 'ok');
                  onRefresh();
                } catch (e: unknown) { toast?.('실패: ' + (e as Error).message, 'err'); }
              })}
            >🔓 하락장 차단 우회</Button>
          </div>
        </div>
      )}

      {/* ── 방어 파킹 배너 ── */}
      {defensePark?.isActive && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <span className="text-xl shrink-0">🛡️</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-300">방어 파킹 중 — {defensePark.parkStockName} 보유</p>
            <p className="text-xs text-amber-400/80 mt-0.5 truncate">진입 사유: {defensePark.entryReason ?? '하락세 감지'}</p>
            <p className="text-xs text-amber-400/60 mt-0.5">시장 회복 감지 시 자동으로 정상 매매 복귀합니다.</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="bg-amber-500/30 hover:bg-amber-500/50 text-amber-200 whitespace-nowrap shrink-0"
            disabled={!!busyAction}
            onClick={guard('park', async () => {
              if (!await confirm({ title: '파킹 강제 해제 + 보유 ETF 즉시 매도를 실행할까요?', confirmLabel: '강제 해제', confirmVariant: 'danger' })) return;
              try {
                const r = await api('/release-defense-park', { method: 'POST' });
                toast?.(r?.message ?? '파킹 해제 완료', 'ok');
                onRefresh();
              } catch (e: unknown) { toast?.('실패: ' + (e as Error).message, 'err'); }
            })}
          >강제 해제</Button>
        </div>
      )}

      {/* ── AI 엔진 상태 배너 ── */}
      {aiStatus && (aiStatus.claude === 'no_credit' || aiStatus.claude === 'error' || aiStatus.gemini === 'quota' || aiStatus.gemini === 'error') && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm">⚠️</span>
            <span className="text-xs font-bold text-amber-300">AI 엔진 경고 — 안정 모드로 운영 중 (신규 매수 중단)</span>
            {aiStatus.claude === 'no_credit' && (
              <span className="text-[11px] bg-rose-500/20 text-rose-300 rounded px-2 py-0.5">Claude 크레딧 소진</span>
            )}
            {aiStatus.claude === 'error' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Claude 오류</span>
            )}
            {aiStatus.gemini === 'quota' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Gemini 무료 한도 초과 — 30분 후 자동 재시도</span>
            )}
            {aiStatus.gemini === 'error' && (
              <span className="text-[11px] bg-amber-500/20 text-amber-300 rounded px-2 py-0.5">Gemini 오류 — 30분 후 자동 재시도</span>
            )}
            <span className="ml-auto text-[10px] text-slate-500">
              {aiStatus.activeEngine === 'technical' ? '기술 지표 모드' : aiStatus.activeEngine === 'none' ? '매매 대기' : ''}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
