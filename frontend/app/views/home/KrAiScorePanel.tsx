'use client';

import React, { useState } from 'react';
import { Panel } from '@/components/ui';
import { ScoreSparkline } from '@/components/ScoreSparkline';
import { ScoreRefreshTimer } from '@/components/ScoreRefreshTimer';
import KrManualBuyModal from '../../panels/KrManualBuyModal';
import { api, fmtWon } from '../../lib/utils';
import type { Dashboard, StockScore, ToastFn, ConfirmFn, ViewMode } from '../../types';

interface KrAiScorePanelProps {
  dash: Dashboard | null;
  showAllKRScores: boolean;
  setShowAllKRScores: (fn: (v: boolean) => boolean) => void;
  buyingStock: string | null;
  setBuyingStock: (v: string | null) => void;
  busyAction: string | null;
  guard: (key: string, fn: () => Promise<void>) => () => Promise<void>;
  getStockName: (code: string) => string;
  toast: ToastFn;
  confirm: ConfirmFn;
  viewMode?: ViewMode;
}

export default function KrAiScorePanel({
  dash, showAllKRScores, setShowAllKRScores,
  buyingStock, setBuyingStock, busyAction, guard, getStockName, toast, confirm,
  viewMode = 'live',
}: KrAiScorePanelProps) {
  // CEO 자유도 매수 모달 상태
  const [modalStock, setModalStock] = useState<{
    code: string;
    name: string;
    score: number;
    confidence?: number;
    rsi?: number;
    volumeRatio?: number;
    pullbackSignal?: boolean;
    currentPrice: number;
  } | null>(null);

  return (
    <Panel title="AI가 보는 종목 점수" badge={(dash?.scores?.length ?? 0) > 0 ? `${dash!.scores!.length}종목` : undefined} badgeColor="blue">
      {(dash?.scores?.length ?? 0) > 0 ? (() => {
        const sorted = [...dash!.scores!].sort((a: StockScore, b: StockScore) => (b.composite_score ?? 0) - (a.composite_score ?? 0));
        const visible = showAllKRScores ? sorted : sorted.slice(0, 10);
        return (
          <div className="p-3.5">
            {/* 점수 갱신 카운트다운 */}
            <div className="mb-3">
              <ScoreRefreshTimer />
            </div>
            {visible.map((sc: StockScore) => {
              const score = Number(sc.composite_score);
              const barColor = score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-blue-500' : score >= 25 ? 'bg-amber-500' : 'bg-slate-600';
              const textColor = score >= 75 ? 'text-emerald-400' : score >= 50 ? 'text-blue-400' : 'text-slate-500';
              const signalLabel = score >= 85 ? '강력 추천' : score >= 70 ? '매수 추천' : score >= 50 ? '관망' : score >= 30 ? '위험' : '매도 추천';
              const curP = Number(sc.currentPrice) || 0;
              const aiTarget = Number(sc.target_price) || 0;
              const aiStop = Number(sc.stop_loss_price) || 0;
              const targetP = aiTarget > 0 ? aiTarget : (curP > 0 ? Math.round(curP * 1.16) : 0);
              const stopP = aiStop > 0 ? aiStop : (curP > 0 ? Math.round(curP * 0.92) : 0);
              const conf = sc.confidence != null ? Math.round(Number(sc.confidence) * 100) : null;
              const fundScore = sc.fundamental_score != null ? Number(sc.fundamental_score) : null;
              const techScore = sc.technical_score != null ? Number(sc.technical_score) : null;
              const sentScore = sc.sentiment_score != null ? Number(sc.sentiment_score) : null;
              const isBuying = buyingStock === sc.stock_code;
              const stockLabel = sc.stock_name && sc.stock_name !== sc.stock_code ? sc.stock_name : getStockName(sc.stock_code);
              return (
                <div key={sc.stock_code} className="px-2 py-2.5 border-b border-white/[0.03] last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-300 w-20 shrink-0 truncate">{stockLabel}</span>
                    <div className="flex-1">
                      <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
                      </div>
                    </div>
                    {/* 점수 추이 미니 그래프 */}
                    <ScoreSparkline stockCode={sc.stock_code} hours={24} width={60} height={20} />
                    <span className={`text-sm font-black w-8 text-right ${textColor}`}>{score}</span>
                    <span className={`text-[10px] font-medium w-14 text-right ${textColor}`}>{signalLabel}</span>
                    {curP > 0 && (
                      <button
                        disabled={isBuying || !!busyAction}
                        onClick={() =>
                          setModalStock({
                            code: sc.stock_code,
                            name: stockLabel,
                            score,
                            confidence: conf != null ? conf / 100 : undefined,
                            rsi: (sc as any).rsi ?? undefined,
                            volumeRatio: (sc as any).volume_ratio ?? undefined,
                            pullbackSignal: (sc as any).pullback_signal ?? undefined,
                            currentPrice: curP,
                          })
                        }
                        className="text-[10px] px-2 py-1 bg-blue-600/70 hover:bg-blue-500/70 disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0"
                      >
                        {isBuying ? '...' : '매수'}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 pl-1 flex-wrap">
                    {fundScore !== null && <span className="text-[9px] text-slate-500">기본 <b className={fundScore >= 50 ? 'text-emerald-400' : fundScore >= 0 ? 'text-blue-400' : 'text-rose-400'}>{fundScore}</b></span>}
                    {techScore !== null && <span className="text-[9px] text-slate-500">기술 <b className={techScore >= 50 ? 'text-emerald-400' : techScore >= 0 ? 'text-blue-400' : 'text-rose-400'}>{techScore}</b></span>}
                    {sentScore !== null && <span className="text-[9px] text-slate-500">심리 <b className={sentScore >= 50 ? 'text-emerald-400' : sentScore >= 0 ? 'text-blue-400' : 'text-rose-400'}>{sentScore}</b></span>}
                    {conf !== null && <span className="text-[9px] text-blue-400/70">확신 {conf}%</span>}
                  </div>
                  {curP > 0 && (
                    <div className="flex items-center gap-2 mt-1 pl-1 text-[9px] flex-wrap">
                      <span className="text-slate-500">진입 <b className="text-slate-300">{fmtWon(curP)}</b></span>
                      <span className="text-slate-600">→</span>
                      <span className="text-emerald-500">목표 {fmtWon(targetP)}</span>
                      <span className="text-slate-600">/</span>
                      <span className="text-rose-500">손절 {fmtWon(stopP)}</span>
                    </div>
                  )}
                </div>
              );
            })}
            {sorted.length > 10 && (
              <button onClick={() => setShowAllKRScores(v => !v)}
                className="w-full mt-1 py-1.5 text-[11px] text-slate-500 hover:text-blue-400 transition-colors">
                {showAllKRScores ? '접기' : `+ ${sorted.length - 10}종목 더 보기`}
              </button>
            )}
          </div>
        );
      })() : (
        <div className="p-6 text-center space-y-3">
          <div className="text-2xl opacity-30">🤖</div>
          <p className="text-sm text-slate-500">AI 스코어가 아직 없습니다</p>
          <p className="text-[11px] text-slate-600">매일 오전 7:30 / 오후 6시에 자동 실행됩니다.</p>
          <p className="text-[10px] text-blue-400/60">스코어 없는 동안 기술적 지표 기반으로 자동매매가 동작합니다</p>
        </div>
      )}
      {modalStock && (
        <KrManualBuyModal
          open={!!modalStock}
          stockCode={modalStock.code}
          stockName={modalStock.name}
          aiScore={modalStock.score}
          confidence={modalStock.confidence}
          rsi={modalStock.rsi}
          volumeRatio={modalStock.volumeRatio}
          pullbackSignal={modalStock.pullbackSignal}
          currentPrice={modalStock.currentPrice}
          viewMode={viewMode}
          onClose={() => setModalStock(null)}
          onSuccess={() => {
            toast?.(`${modalStock.code} 매수 접수`, 'ok');
            setModalStock(null);
          }}
          toast={toast}
        />
      )}
    </Panel>
  );
}
