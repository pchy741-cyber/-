'use client';

import React, { useState } from 'react';
import { Panel, SideBadge, StatusBadge, EmptyMsg } from '@/components/ui';
import { ToggleGroup } from '@/components/ToggleGroup';
import { fmt, fmtWon, fmtUsd, fmtPct, fmtTime, pc } from '../lib/utils';
import { toDisplayName, isUnresolvedStockName, simplifyReason } from '../lib/helpers';

function TradesView({ trades, watchlist }: { trades: any[]; watchlist: any[] }) {
  // 종목명 조회 맵 (API stock_name 우선, 없으면 watchlist, 없으면 코드)
  const nameMap = new Map(watchlist.map((w: any) => [w.stock_code, w.stock_name]));
  const getName = (t: any) => {
    const apiName = toDisplayName(t.stock_name, t.stock_code);
    if (!isUnresolvedStockName(apiName, t.stock_code)) return apiName;
    return toDisplayName(nameMap.get(t.stock_code), t.stock_code);
  };
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mktFilter, setMktFilter] = useState<'ALL' | 'KR' | 'US'>('ALL');
  const filled = trades.filter((t: any) => t.status === 'FILLED' || (t.status === 'PENDING' && t.trigger_source === 'OVERSEAS'));
  const isOverseas = (t: any) => t.trigger_source === 'OVERSEAS';
  const domestic = filled.filter((t: any) => !isOverseas(t));
  const overseas = filled.filter((t: any) => isOverseas(t));
  const filtered = mktFilter === 'ALL' ? filled : mktFilter === 'KR' ? domestic : overseas;
  const buys = filtered.filter((t: any) => t.side === 'BUY');
  const sells = filtered.filter((t: any) => t.side === 'SELL');
  const todayCount = filtered.filter((t: any) => new Date(t.created_at).toDateString() === new Date().toDateString()).length;

  return (
    <div className="space-y-4">
      {/* 시장 필터 */}
      <ToggleGroup
        value={mktFilter}
        items={[
          { value: 'ALL' as const, label: '전체' },
          { value: 'KR' as const, label: '🇰🇷 국내' },
          { value: 'US' as const, label: '🇺🇸 해외' },
        ]}
        onChange={setMktFilter}
      />
      {/* 요약 통계 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">총 체결</div>
          <div className="text-lg font-black mt-1">{filtered.length}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-slate-500">오늘</div>
          <div className="text-lg font-black mt-1 text-blue-400">{todayCount}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-emerald-400/60">매수</div>
          <div className="text-lg font-black mt-1 text-emerald-400">{buys.length}건</div>
        </div>
        <div className="glass rounded-xl p-3.5 text-center border border-white/[0.04]">
          <div className="text-[10px] text-rose-400/60">매도</div>
          <div className="text-lg font-black mt-1 text-rose-400">{sells.length}건</div>
        </div>
      </div>

    <Panel title="매매내역" badge={`${filtered.length}건`}>
      {filtered.length === 0 ? (
        <div className="p-8 text-center space-y-2">
          <div className="text-2xl opacity-30">📋</div>
          <p className="text-sm text-slate-400">아직 매매 기록이 없습니다</p>
          <p className="text-[11px] text-slate-600">로봇이 매수/매도를 실행하면 여기에 기록됩니다.<br/>장 중(09:00~15:30) 10분 간격으로 자동 실행됩니다.</p>
        </div>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead><tr className="text-slate-500 border-b border-slate-700/30">
            <th className="px-4 py-3 text-left font-medium">시간</th>
            <th className="px-4 py-3 text-left font-medium">종목</th>
            <th className="px-4 py-3 text-center font-medium">구분</th>
            <th className="px-4 py-3 text-right font-medium">수량</th>
            <th className="px-4 py-3 text-right font-medium">체결가</th>
            <th className="px-4 py-3 text-right font-medium">손익</th>
            <th className="px-4 py-3 text-center font-medium">상태</th>
            <th className="px-4 py-3 text-center font-medium">모드</th>
            <th className="px-4 py-3 text-left font-medium">내용</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800/20">
            {filtered.map((t: any, i: number) => {
              const chain = t.transaction_chains;
              const tradeKey = t.id || t.kis_order_no || `t${i}`;
              const isOpen = expanded === tradeKey;
              const isSell = t.side === 'SELL';
              const overseas = isOverseas(t);
              const avgBuy = Number(chain?.avg_buy_price) || 0;
              const filledPrice = Number(t.filled_price) || 0;
              const qty = Number(t.quantity) || 0;
              const apiPnl = typeof t.realized_pnl === 'number' ? Number(t.realized_pnl) : null;
              const apiPnlPct = typeof t.realized_pnl_pct === 'number' ? Number(t.realized_pnl_pct) : null;
              const apiPnlUsd = typeof t.realized_pnl_usd === 'number' ? Number(t.realized_pnl_usd) : null;
              // 국내 폴백: avg_buy_price vs filled_price
              const fallbackPnl = !overseas && isSell && avgBuy > 0 && filledPrice > 0 ? (filledPrice - avgBuy) * qty : null;
              const fallbackPnlPct = !overseas && isSell && avgBuy > 0 && filledPrice > 0 ? ((filledPrice - avgBuy) / avgBuy) * 100 : null;
              // 해외 폴백: avg_buy_price 기반 (국내와 동일 로직, 단위 USD)
              const overseasFallbackPnl = overseas && isSell && avgBuy > 0 && filledPrice > 0 ? (filledPrice - avgBuy) * qty : null;
              const overseasFallbackPnlPct = overseas && isSell && avgBuy > 0 && filledPrice > 0 ? ((filledPrice - avgBuy) / avgBuy) * 100 : null;
              // 해외: API 계산값 우선 → ai_reasoning 패턴 → avg_buy_price 폴백
              const overseasReasonPct = overseas && isSell && apiPnlPct === null
                ? (() => { const m = String(t.ai_reasoning || '').match(/[익손절]+\(([+-]?[\d.]+)%\)/); return m ? Number(m[1]) : null; })()
                : null;
              const overseasPnlUsdAmt = overseasReasonPct !== null && filledPrice > 0 && qty > 0
                ? filledPrice * qty * (overseasReasonPct / 100) : null;
              const tradePnl = overseas ? (apiPnlUsd ?? overseasPnlUsdAmt ?? overseasFallbackPnl) : (apiPnl ?? fallbackPnl);
              const tradePnlPct = apiPnlPct ?? (overseas ? (overseasReasonPct ?? overseasFallbackPnlPct) : fallbackPnlPct);
              return (
              <React.Fragment key={tradeKey}>
              <tr onClick={() => setExpanded(isOpen ? null : tradeKey)} className={`hover:bg-slate-800/20 transition-colors cursor-pointer${overseas ? ' opacity-60' : ''}`}>
                <td className="px-4 py-3 text-slate-500">{fmtTime(t.created_at)}</td>
                <td className="px-4 py-3 font-semibold">
                  {overseas && <span className="text-[10px] mr-1">🌏</span>}
                  {getName(t)}
                </td>
                <td className="px-4 py-3 text-center"><SideBadge side={t.side} isAverageDown={t.side === 'BUY' && (String(t.ai_reasoning ?? '').includes('AVERAGE') || String(t.ai_reasoning ?? '').includes('물타기') || String(t.ai_reasoning ?? '').includes('추가 매수'))} /></td>
                <td className="px-4 py-3 text-right">{fmt(t.filled_quantity ?? t.quantity)}</td>
                <td className="px-4 py-3 text-right font-medium">{overseas ? fmtUsd(filledPrice) : fmtWon(filledPrice)}</td>
                <td className="px-4 py-3 text-right">
                  {tradePnl !== null && tradePnlPct !== null ? (
                    <div className={tradePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      <div className="font-semibold text-[12px]">{tradePnlPct >= 0 ? '+' : ''}{tradePnlPct.toFixed(1)}%</div>
                      <div className="text-[11px] opacity-80">
                        {tradePnl >= 0 ? '+' : ''}{overseas ? `$${Math.abs(tradePnl).toFixed(2)}` : `${Math.round(tradePnl).toLocaleString()}원`}
                      </div>
                    </div>
                  ) : <span className="text-slate-600 text-[11px]">-</span>}
                </td>
                <td className="px-4 py-3 text-center"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-center">
                  {chain?.strategy_mode
                    ? <span className="px-1.5 py-0.5 rounded text-[11px] bg-blue-900/30 text-blue-300">{chain.strategy_mode}</span>
                    : t.trigger_source === 'OVERSEAS'
                      ? <span className="px-1.5 py-0.5 rounded text-[11px] bg-purple-900/30 text-purple-300">미국</span>
                      : t.trigger_source === 'MANUAL'
                        ? <span className="px-1.5 py-0.5 rounded text-[11px] bg-slate-700/50 text-slate-400">수동</span>
                        : <span className="px-1.5 py-0.5 rounded text-[11px] bg-slate-700/50 text-slate-500">{t.trigger_source ?? '-'}</span>
                  }
                </td>
                <td className="px-4 py-3 text-slate-400 max-w-[200px]">
                  <div className="flex items-center gap-1">
                    <div className="truncate font-medium text-slate-300" title={t.ai_reasoning}>{simplifyReason(t.ai_reasoning, t.side)}</div>
                    <span className="text-[10px] text-slate-600 shrink-0">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </td>
              </tr>
              {isOpen && (
                <tr className="bg-slate-900/40">
                  <td colSpan={9} className="px-5 py-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">상세 내용</p>
                        <p className="text-slate-300 leading-relaxed whitespace-pre-wrap">{t.ai_reasoning || '기록 없음'}</p>
                      </div>
                      <div>
                        <p className="text-slate-500 font-medium mb-1.5">언제 팔 계획인지</p>
                        {chain?.strategy_mode ? (
                          <div className="space-y-1 text-slate-400">
                            <p>전략: <span className="text-slate-200 font-medium">{chain.strategy_mode}</span></p>
                            <p>평단가: <span className="text-slate-200">{Number(chain.avg_buy_price).toLocaleString()}원</span></p>
                            <p>상태: <span className="text-slate-200">{chain.status}</span></p>
                            {chain.strategy_mode === 'SWING' && (
                              <>
                                <p className="text-orange-400">수익 +3% 이상 & 고점 대비 -5% 이탈 → 전량 매도 (트레일링 스탑)</p>
                                <p className="text-rose-400">-5% 떨어지면 → 전부 팔아서 손실 차단</p>
                                <p className="text-blue-400">-3% 빠지면 → 더 싸게 추가 매수 (최대 3번)</p>
                              </>
                            )}
                            {chain.strategy_mode === 'DEFENSE' && (
                              <>
                                <p className="text-emerald-400">+5% 오르면 → 전부 팔아서 수익 확보</p>
                                <p className="text-rose-400">-3% 떨어지면 → 전부 팔아서 손실 차단</p>
                              </>
                            )}
                          </div>
                        ) : overseas ? (
                          <div className="space-y-1 text-slate-400">
                            <p>전략: <span className="text-slate-200 font-medium">미국주식 자동매매</span></p>
                            {(() => {
                              const isScalp = String(t.ai_reasoning || '').includes('scalp') || String(t.ai_reasoning || '').includes('SCALP');
                              const tpMatch = String(t.ai_reasoning || '').match(/tp[:\s]*\$?([\d.]+)/i);
                              const slMatch = String(t.ai_reasoning || '').match(/sl[:\s]*\$?([\d.]+)/i);
                              if (isScalp && tpMatch && slMatch) {
                                return (
                                  <>
                                    <p className="text-emerald-400">익절가 ${tpMatch[1]} 도달 → 전량 매도</p>
                                    <p className="text-rose-400">손절가 ${slMatch[1]} 이탈 → 전량 매도</p>
                                    <p className="text-amber-400">전략: 단타 (SCALP)</p>
                                  </>
                                );
                              }
                              return (
                                <>
                                  <p className="text-emerald-400">+10% 오르면 → 전량 매도 (익절)</p>
                                  <p className="text-rose-400">-2.5% 떨어지면 → 전량 매도 (손절)</p>
                                  <p className="text-orange-400">최고점 대비 -2.5% 빠지면 → 트레일링 스탑</p>
                                  <p className="text-sky-400">AI 매도 신호 (신뢰도 55%↑) → 전량 매도</p>
                                </>
                              );
                            })()}
                          </div>
                        ) : (
                          <p className="text-slate-500">체인 정보 없음</p>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </Panel>
    </div>
  );
}

export default TradesView;
