import React from 'react';
import { Panel, Indicator, EmptyMsg } from '@/components/ui';
import type { StockAnalysis } from '../../types';

interface StockAnalysisPanelProps {
  stockName: string;
  analysis: StockAnalysis | null;
  isLoading: boolean;
}

function StockAnalysisPanel({ stockName, analysis, isLoading }: StockAnalysisPanelProps) {
  const t = analysis?.technicals;
  const f = analysis?.flow;
  const sh = analysis?.shorts;
  const con = analysis?.consensus;

  return (
    <Panel title={`${stockName} 종목 분석`}>
      {isLoading ? (
        <div className="p-8 text-center"><div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" /></div>
      ) : t ? (
        <div className="p-4 sm:p-5 space-y-5">
          <div>
            <h4 className="text-xs font-semibold text-slate-400 mb-3">차트 건강 상태</h4>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              <Indicator label="과열/침체" value={t.rsi14 != null ? Number(t.rsi14).toFixed(0) : '-'} sub={Number(t.rsi14) > 70 ? '너무 올랐음' : Number(t.rsi14) < 30 ? '많이 빠짐 (기회)' : '적정 수준'} color={Number(t.rsi14) > 70 ? 'rose' : Number(t.rsi14) < 30 ? 'emerald' : 'slate'} />
              <Indicator label="추세 방향" value={Number(t.macdHistogram) > 0 ? '상승' : '하락'} sub={t.macdCrossover === 'golden' ? '상승 전환!' : t.macdCrossover === 'dead' ? '하락 전환' : '유지 중'} color={Number(t.macdHistogram) > 0 ? 'emerald' : 'rose'} />
              <Indicator label="가격 위치" value={t.bollingerPositionPct != null ? Number(t.bollingerPositionPct).toFixed(0) + '%' : '-'} sub={Number(t.bollingerPositionPct) > 80 ? '고가 영역' : Number(t.bollingerPositionPct) < 20 ? '저가 영역' : '중간'} color={Number(t.bollingerPositionPct) > 80 ? 'rose' : Number(t.bollingerPositionPct) < 20 ? 'emerald' : 'slate'} />
              <Indicator label="추세 강도" value={t.adx14 != null ? Number(t.adx14).toFixed(0) : '-'} sub={Number(t.adx14) > 25 ? '뚜렷한 방향' : '방향 없음'} color={Number(t.adx14) > 25 ? 'blue' : 'slate'} />
              <Indicator label="AI 종합" value={t.score != null ? Number(t.score).toFixed(0) + '점' : '-'} sub={Number(t.score) > 20 ? '매수 유리' : Number(t.score) < -20 ? '매수 위험' : '관망'} color={Number(t.score) > 20 ? 'emerald' : Number(t.score) < -20 ? 'rose' : 'slate'} />
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3 text-center text-[11px]">
              <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">5일 평균가</span><b>{Number(t.sma5 ?? 0).toLocaleString()}</b></div>
              <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">20일 평균가</span><b>{Number(t.sma20 ?? 0).toLocaleString()}</b></div>
              <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">60일 평균가</span><b>{Number(t.sma60 ?? 0).toLocaleString()}</b></div>
              <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">거래량 변화</span><b className={Number(t.volumeRatio) > 2 ? 'text-amber-400' : ''}>{Number(t.volumeRatio ?? 0).toFixed(1)}배</b></div>
              <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">매수/매도 힘</span><b>{Number(t.stochasticK ?? 0).toFixed(0)}</b></div>
              <div className="bg-slate-900/40 rounded-lg p-2"><span className="text-slate-500 block">변동성</span><b>{Number(t.atr14 ?? 0).toFixed(0)}</b></div>
            </div>
            {t.goldenCross && <p className="text-[11px] text-emerald-400 mt-2">단기 평균이 장기 평균을 돌파 — 상승 신호</p>}
            {t.deathCross && <p className="text-[11px] text-rose-400 mt-2">단기 평균이 장기 평균 아래로 — 하락 신호</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-slate-900/40 rounded-xl p-4">
              <h4 className="text-xs font-semibold text-slate-400 mb-2">큰손(외국인/기관) 동향</h4>
              {f ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">외국인</span><span className={(f.foreignNet ?? 0) > 0 ? 'text-emerald-400' : 'text-rose-400'}>{(f.foreignNet ?? 0) > 0 ? '사는 중 +' : '파는 중 '}{(f.foreignNet ?? 0).toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">기관</span><span className={(f.institutionNet ?? 0) > 0 ? 'text-emerald-400' : 'text-rose-400'}>{(f.institutionNet ?? 0) > 0 ? '사는 중 +' : '파는 중 '}{(f.institutionNet ?? 0).toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">연속 매수</span><span className="font-bold">{f.foreignStreak ?? 0}일째</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">흐름</span><span className={f.trend === 'STRONG_BUY' || f.trend === 'BUY' ? 'text-emerald-400' : f.trend === 'SELL' || f.trend === 'STRONG_SELL' ? 'text-rose-400' : 'text-slate-400'}>{f.trend === 'STRONG_BUY' ? '강하게 사는 중' : f.trend === 'BUY' ? '사는 중' : f.trend === 'SELL' ? '파는 중' : f.trend === 'STRONG_SELL' ? '강하게 파는 중' : '관망'}</span></div>
                </div>
              ) : <p className="text-[11px] text-slate-600">시장 마감 시간</p>}
            </div>

            <div className="bg-slate-900/40 rounded-xl p-4">
              <h4 className="text-xs font-semibold text-slate-400 mb-2">하락에 베팅하는 세력</h4>
              {sh ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">하락 베팅 비율</span><span className={sh.riskLevel === 'HIGH' ? 'text-rose-400 font-bold' : ''}>{Number(sh.shortRatio ?? 0).toFixed(1)}%</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">추세</span><span>{sh.isIncreasing ? '늘어나는 중' : '줄어드는 중'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">위험도</span><span className={sh.riskLevel === 'HIGH' ? 'text-rose-400' : sh.riskLevel === 'MEDIUM' ? 'text-amber-400' : 'text-emerald-400'}>{sh.riskLevel === 'HIGH' ? '높음 (주의)' : sh.riskLevel === 'MEDIUM' ? '보통' : '낮음 (안전)'}</span></div>
                </div>
              ) : <p className="text-[11px] text-slate-600">시장 마감 시간</p>}
            </div>

            <div className="bg-slate-900/40 rounded-xl p-4">
              <h4 className="text-xs font-semibold text-slate-400 mb-2">증권사 전문가 의견</h4>
              {con ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">예상 목표가</span><span className="font-bold">{con.targetPrice != null ? con.targetPrice.toLocaleString() + '원' : '-'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">얼마나 오를 수 있나</span><span className={(con.upsidePct ?? 0) > 0 ? 'text-emerald-400' : 'text-rose-400'}>{Number(con.upsidePct ?? 0) > 0 ? '+' : ''}{Number(con.upsidePct ?? 0).toFixed(1)}%</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">전문가 의견</span><span>사라 {con.buyCount}명 · 보유 {con.holdCount}명 · 팔아라 {con.sellCount}명</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">종합</span><span className={con.consensusRating === 'STRONG_BUY' || con.consensusRating === 'BUY' ? 'text-emerald-400' : 'text-slate-400'}>{con.consensusRating === 'STRONG_BUY' ? '적극 매수' : con.consensusRating === 'BUY' ? '매수' : con.consensusRating === 'HOLD' ? '보유' : con.consensusRating === 'SELL' ? '매도' : '의견 없음'}</span></div>
                </div>
              ) : <p className="text-[11px] text-slate-600">데이터 없음</p>}
            </div>
          </div>
        </div>
      ) : <EmptyMsg>시장 마감 시간이거나 데이터가 부족합니다</EmptyMsg>}
    </Panel>
  );
}

export default StockAnalysisPanel;
