/**
 * 해외주식 전용 자기학습 분석기
 * - 섹터별 승률 → 바이어스 적용
 * - 체결사유별 TP/SL 최적화
 * - 데이터 축적 복리 신뢰도 부스트
 */
import { getPool } from '../../db/client.js';
import { SECTOR_CLASS } from '../../config/constants.js';
import { GLOBAL_WATCHLIST } from '../../scheduler/overseas/watchlist.js';
import { logger } from '../../utils/logger.js';
import { getCtxIsPaper } from '../../config/context.js';
import type { LearnedInsight } from './index.js';

/** 호출 시점 timestamp (모듈 로드 시 고정 방지) */
function now(): string { return new Date().toISOString(); }

interface OverseasTrade {
  stockCode: string;
  sector: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  filledPrice: number;
  avgBuyPrice: number;
  pnlPct: number;
  pnlUsd: number;
  closeReason: string;
  isPaper: boolean;
  createdAt: string;
}

// ── 해외 매매 내역 조회 ──
async function getOverseasTrades(days: number, isPaper: boolean): Promise<OverseasTrade[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { rows } = await getPool().query(
    `SELECT stock_code, side, quantity, filled_price, avg_buy_price,
            ai_reasoning, trading_mode, created_at
       FROM orders
      WHERE trigger_source = 'OVERSEAS'
        AND status = 'FILLED'
        AND side = 'SELL'
        AND created_at >= $1
        AND trading_mode = $2
      ORDER BY created_at DESC`,
    [cutoff.toISOString(), isPaper ? 'paper' : 'live'],
  );

  return rows.map((r: any) => {
    const avgBuy = Number(r.avg_buy_price ?? 0);
    const filled = Number(r.filled_price ?? 0);
    const qty = Number(r.quantity ?? 0);
    const pnlUsd = avgBuy > 0 && filled > 0 ? (filled - avgBuy) * qty : 0;
    const pnlPct = avgBuy > 0 && filled > 0 ? ((filled - avgBuy) / avgBuy) * 100 : 0;
    const wItem = GLOBAL_WATCHLIST.find(w => w.code === r.stock_code);
    const reasoning = String(r.ai_reasoning ?? '');
    // 체결사유 추출: AI reasoning에서 핵심 사유 파싱
    const closeReason = parseCloseReason(reasoning);
    return {
      stockCode: String(r.stock_code),
      sector: wItem?.sector ?? 'UNKNOWN',
      side: 'SELL' as const,
      quantity: qty,
      filledPrice: filled,
      avgBuyPrice: avgBuy,
      pnlPct,
      pnlUsd,
      closeReason,
      isPaper,
      createdAt: r.created_at,
    };
  });
}

function parseCloseReason(reasoning: string): string {
  const lower = reasoning.toLowerCase();
  if (lower.includes('trailing') || lower.includes('트레일링') || lower.includes('trail')) return 'TRAILING_STOP';
  if (lower.includes('partial') || lower.includes('부분익절') || lower.includes('partial_tp')) return 'PARTIAL_TP';
  if (lower.includes('stop') && lower.includes('loss') || lower.includes('손절') || lower.includes('SL')) return 'STOP_LOSS';
  if (lower.includes('take') && lower.includes('profit') || lower.includes('익절') || lower.includes('TP')) return 'TAKE_PROFIT';
  if (lower.includes('수동') || lower.includes('ceo') || lower.includes('manual')) return 'MANUAL';
  if (lower.includes('turtle') || lower.includes('터틀')) return 'TURTLE_EXIT';
  if (lower.includes('concentration') || lower.includes('집중도')) return 'CONCENTRATION_CAP';
  if (lower.includes('rotation') || lower.includes('순환') || lower.includes('리밸런싱')) return 'ROTATION';
  if (lower.includes('scalp') || lower.includes('단타')) return 'VISION_SCALP';
  if (lower.includes('sync') || lower.includes('외부')) return 'KIS_SYNC';
  return 'OTHER';
}

const CLOSE_REASON_KR: Record<string, string> = {
  TRAILING_STOP: '트레일링 스톱',
  PARTIAL_TP: '부분 익절',
  STOP_LOSS: '손절',
  TAKE_PROFIT: '익절',
  MANUAL: '수동 매도',
  TURTLE_EXIT: '터틀 탈출',
  CONCENTRATION_CAP: '집중도 캡',
  ROTATION: '순환 매도',
  VISION_SCALP: '단타 청산',
  KIS_SYNC: 'KIS 동기화',
  OTHER: '기타',
};

// ── 복리 신뢰도 부스트: 샘플 수가 많을수록 신뢰도 ↑ ──
function compoundConfidence(baseConfidence: number, sampleCount: number): number {
  // log2(samples/5)에 비례하여 0~0.15 부스트 (최대 0.95)
  if (sampleCount < 5) return baseConfidence;
  const boost = Math.min(0.15, Math.log2(sampleCount / 5) * 0.05);
  return Math.min(0.95, baseConfidence + boost);
}

// ══════════════════════════════════════════════════════════════
// 1. 섹터별 승률 분석 → 바이어스
// ══════════════════════════════════════════════════════════════
export async function analyzeOverseasSectorPerformance(isPaper: boolean): Promise<LearnedInsight[]> {
  const trades = await getOverseasTrades(120, isPaper);
  if (trades.length < 5) return [];

  const sectorStats = new Map<string, { wins: number; losses: number; totalPnlPct: number; totalPnlUsd: number }>();
  for (const t of trades) {
    const stat = sectorStats.get(t.sector) ?? { wins: 0, losses: 0, totalPnlPct: 0, totalPnlUsd: 0 };
    if (t.pnlPct > 0) stat.wins++; else stat.losses++;
    stat.totalPnlPct += t.pnlPct;
    stat.totalPnlUsd += t.pnlUsd;
    sectorStats.set(t.sector, stat);
  }

  const insights: LearnedInsight[] = [];
  let bestSector = '';
  let bestWinRate = 0;
  let worstSector = '';
  let worstWinRate = 1;

  for (const [sector, stat] of sectorStats) {
    const total = stat.wins + stat.losses;
    if (total < 3) continue;
    const winRate = stat.wins / total;
    const avgPnlPct = stat.totalPnlPct / total;
    if (winRate > bestWinRate) { bestWinRate = winRate; bestSector = sector; }
    if (winRate < worstWinRate) { worstWinRate = winRate; worstSector = sector; }

    if (winRate >= 0.70 && total >= 5) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `[해외] ${sector} 섹터 승률 ${(winRate * 100).toFixed(0)}% (${total}건, 평균 +${avgPnlPct.toFixed(1)}%) — 이 섹터 매수 시그널 적극 대응.`,
        confidence: compoundConfidence(0.75, total),
        sampleCount: total,
        lastUpdated: now(),
        details: { market: 'OVERSEAS', sector, winRate, avgPnlPct },
      });
    } else if (winRate <= 0.35 && total >= 5 && stat.totalPnlUsd < 0) {
      insights.push({
        category: 'LOSS_PATTERN',
        insight: `[해외] ${sector} 섹터 승률 ${(winRate * 100).toFixed(0)}% (${total}건, 평균 ${avgPnlPct.toFixed(1)}%) — 매수 기준 강화 또는 비중 축소.`,
        confidence: compoundConfidence(0.75, total),
        sampleCount: total,
        lastUpdated: now(),
        details: { market: 'OVERSEAS', sector, winRate, avgPnlPct },
      });
    }
  }

  // 최고 vs 최저 섹터 비교
  if (bestSector && worstSector && bestSector !== worstSector && bestWinRate - worstWinRate >= 0.25) {
    const bestTotal = (sectorStats.get(bestSector)?.wins ?? 0) + (sectorStats.get(bestSector)?.losses ?? 0);
    const worstTotal = (sectorStats.get(worstSector)?.wins ?? 0) + (sectorStats.get(worstSector)?.losses ?? 0);
    if (bestTotal >= 5 && worstTotal >= 3) {
      insights.push({
        category: 'SIZING',
        insight: `[해외] ${bestSector}(승률 ${(bestWinRate * 100).toFixed(0)}%) → ${worstSector}(승률 ${(worstWinRate * 100).toFixed(0)}%) 대비 우위. ${bestSector} 비중 확대, ${worstSector} 축소 권장.`,
        confidence: compoundConfidence(0.80, bestTotal + worstTotal),
        sampleCount: bestTotal + worstTotal,
        lastUpdated: now(),
        details: { bestSector, bestWinRate, worstSector, worstWinRate },
      });
    }
  }

  return insights;
}

// ══════════════════════════════════════════════════════════════
// 2. 체결사유별 승률 → TP/SL 자동 최적화
// ══════════════════════════════════════════════════════════════
export async function analyzeCloseReasonOptimization(isPaper: boolean): Promise<LearnedInsight[]> {
  const trades = await getOverseasTrades(120, isPaper);
  if (trades.length < 8) return [];

  const reasonStats = new Map<string, { wins: number; losses: number; totalPnlPct: number; avgHoldDays: number; count: number }>();
  for (const t of trades) {
    const stat = reasonStats.get(t.closeReason) ?? { wins: 0, losses: 0, totalPnlPct: 0, avgHoldDays: 0, count: 0 };
    if (t.pnlPct > 0) stat.wins++; else stat.losses++;
    stat.totalPnlPct += t.pnlPct;
    stat.count++;
    reasonStats.set(t.closeReason, stat);
  }

  const insights: LearnedInsight[] = [];

  // 최고 성과 exit 전략 찾기
  let bestReason = '';
  let bestAvgPnl = -Infinity;
  let bestWinRate = 0;

  for (const [reason, stat] of reasonStats) {
    const total = stat.wins + stat.losses;
    if (total < 3) continue;
    const avgPnl = stat.totalPnlPct / total;
    const winRate = stat.wins / total;

    if (avgPnl > bestAvgPnl) {
      bestAvgPnl = avgPnl;
      bestReason = reason;
      bestWinRate = winRate;
    }

    const krName = CLOSE_REASON_KR[reason] ?? reason;

    // 특정 exit 전략이 일관되게 좋으면 알림
    if (winRate >= 0.70 && total >= 5) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `[해외] '${krName}' 매도 전략 승률 ${(winRate * 100).toFixed(0)}% (${total}건, 평균 +${avgPnl.toFixed(1)}%) — 이 exit 전략이 가장 효과적.`,
        confidence: compoundConfidence(0.75, total),
        sampleCount: total,
        lastUpdated: now(),
        details: { market: 'OVERSEAS', closeReason: reason, winRate, avgPnl },
      });
    }

    // 특정 exit 전략이 일관되게 나쁘면 경고
    if (winRate <= 0.30 && total >= 5 && avgPnl < -1) {
      insights.push({
        category: 'LOSS_PATTERN',
        insight: `[해외] '${krName}' 매도 전략 승률 ${(winRate * 100).toFixed(0)}% (${total}건, 평균 ${avgPnl.toFixed(1)}%) — 이 exit 방식 개선 필요.`,
        confidence: compoundConfidence(0.80, total),
        sampleCount: total,
        lastUpdated: now(),
        details: { market: 'OVERSEAS', closeReason: reason, winRate, avgPnl },
      });
    }
  }

  // 트레일링 스톱 vs 고정 익절 비교
  const trailingStats = reasonStats.get('TRAILING_STOP');
  const tpStats = reasonStats.get('TAKE_PROFIT');
  if (trailingStats && tpStats) {
    const trailTotal = trailingStats.wins + trailingStats.losses;
    const tpTotal = tpStats.wins + tpStats.losses;
    if (trailTotal >= 3 && tpTotal >= 3) {
      const trailAvg = trailingStats.totalPnlPct / trailTotal;
      const tpAvg = tpStats.totalPnlPct / tpTotal;
      if (trailAvg > tpAvg + 2) {
        insights.push({
          category: 'SIZING',
          insight: `[해외] 트레일링 스톱(평균 +${trailAvg.toFixed(1)}%)이 고정 익절(평균 +${tpAvg.toFixed(1)}%)보다 우수. 트레일링 활성화 기준을 낮춰 더 많은 종목에 적용 권장.`,
          confidence: compoundConfidence(0.80, trailTotal + tpTotal),
          sampleCount: trailTotal + tpTotal,
          lastUpdated: now(),
        });
      } else if (tpAvg > trailAvg + 2) {
        insights.push({
          category: 'SIZING',
          insight: `[해외] 고정 익절(평균 +${tpAvg.toFixed(1)}%)이 트레일링 스톱(평균 +${trailAvg.toFixed(1)}%)보다 우수. 빠른 익절이 현재 시장에 더 적합.`,
          confidence: compoundConfidence(0.80, trailTotal + tpTotal),
          sampleCount: trailTotal + tpTotal,
          lastUpdated: now(),
        });
      }
    }
  }

  // 부분익절 효과 분석
  const partialStats = reasonStats.get('PARTIAL_TP');
  if (partialStats) {
    const partialTotal = partialStats.wins + partialStats.losses;
    if (partialTotal >= 3) {
      const partialAvg = partialStats.totalPnlPct / partialTotal;
      const partialWR = partialStats.wins / partialTotal;
      if (partialWR >= 0.70) {
        insights.push({
          category: 'WIN_PATTERN',
          insight: `[해외] 부분익절 승률 ${(partialWR * 100).toFixed(0)}% (${partialTotal}건, 평균 +${partialAvg.toFixed(1)}%) — 익절 시 전량보다 부분매도가 유리.`,
          confidence: compoundConfidence(0.75, partialTotal),
          sampleCount: partialTotal,
          lastUpdated: now(),
        });
      }
    }
  }

  return insights;
}

// ══════════════════════════════════════════════════════════════
// 3. 해외 종목별 승률 + 복리 신뢰도
// ══════════════════════════════════════════════════════════════
export async function analyzeOverseasStockPerformance(isPaper: boolean): Promise<LearnedInsight[]> {
  const trades = await getOverseasTrades(120, isPaper);
  if (trades.length < 5) return [];

  const stockStats = new Map<string, { wins: number; losses: number; totalPnlPct: number; sector: string }>();
  for (const t of trades) {
    const stat = stockStats.get(t.stockCode) ?? { wins: 0, losses: 0, totalPnlPct: 0, sector: t.sector };
    if (t.pnlPct > 0) stat.wins++; else stat.losses++;
    stat.totalPnlPct += t.pnlPct;
    stockStats.set(t.stockCode, stat);
  }

  const insights: LearnedInsight[] = [];
  for (const [code, stat] of stockStats) {
    const total = stat.wins + stat.losses;
    if (total < 3) continue;
    const winRate = stat.wins / total;
    const avgPnl = stat.totalPnlPct / total;

    if (winRate >= 0.75) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `[해외] ${code}(${stat.sector}) 승률 ${(winRate * 100).toFixed(0)}% (${total}건, 평균 +${avgPnl.toFixed(1)}%) — 고승률 종목, 매수 신호 시 적극 진입.`,
        confidence: compoundConfidence(0.75, total),
        sampleCount: total,
        lastUpdated: now(),
        details: { market: 'OVERSEAS', code, sector: stat.sector, winRate },
      });
    } else if (winRate <= 0.30 && total >= 3) {
      insights.push({
        category: 'LOSS_PATTERN',
        insight: `[해외] ${code}(${stat.sector}) 승률 ${(winRate * 100).toFixed(0)}% (${total}건, 평균 ${avgPnl.toFixed(1)}%) — 반복 손실 종목, 진입 기준 강화 필요.`,
        confidence: compoundConfidence(0.70, total),
        sampleCount: total,
        lastUpdated: now(),
        details: { market: 'OVERSEAS', code, sector: stat.sector, winRate },
      });
    }
  }

  return insights;
}

// ══════════════════════════════════════════════════════════════
// 4. 해외 보유기간 분석
// ══════════════════════════════════════════════════════════════
export async function analyzeOverseasHoldingPeriod(isPaper: boolean): Promise<LearnedInsight[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 120);

  // 매수/매도 쌍을 종목별로 매칭
  const { rows: buys } = await getPool().query(
    `SELECT stock_code, created_at, filled_price FROM orders
     WHERE trigger_source = 'OVERSEAS' AND status = 'FILLED' AND side = 'BUY'
       AND created_at >= $1 AND trading_mode = $2
     ORDER BY created_at`,
    [cutoff.toISOString(), isPaper ? 'paper' : 'live'],
  );
  const { rows: sells } = await getPool().query(
    `SELECT stock_code, created_at, filled_price, avg_buy_price FROM orders
     WHERE trigger_source = 'OVERSEAS' AND status = 'FILLED' AND side = 'SELL'
       AND created_at >= $1 AND trading_mode = $2
     ORDER BY created_at`,
    [cutoff.toISOString(), isPaper ? 'paper' : 'live'],
  );

  if (sells.length < 5) return [];

  // 간이 보유기간 추정: 같은 종목의 직전 매수~매도
  const holdingDays: { days: number; win: boolean }[] = [];
  for (const sell of sells) {
    const matchBuy = buys.filter((b: any) =>
      b.stock_code === sell.stock_code &&
      new Date(b.created_at) < new Date(sell.created_at),
    ).pop(); // 가장 가까운 매수
    if (!matchBuy) continue;
    const days = (new Date(sell.created_at).getTime() - new Date(matchBuy.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const win = Number(sell.filled_price) > Number(sell.avg_buy_price ?? matchBuy.filled_price);
    holdingDays.push({ days, win });
  }

  if (holdingDays.length < 5) return [];

  const wins = holdingDays.filter(h => h.win);
  const losses = holdingDays.filter(h => !h.win);
  const avgWinHold = wins.length > 0 ? wins.reduce((s, h) => s + h.days, 0) / wins.length : 0;
  const avgLossHold = losses.length > 0 ? losses.reduce((s, h) => s + h.days, 0) / losses.length : 0;

  const insights: LearnedInsight[] = [];

  if (avgWinHold > 0 && avgLossHold > avgWinHold * 1.5 && losses.length >= 3) {
    insights.push({
      category: 'TIMING',
      insight: `[해외] 수익 매매 평균 ${avgWinHold.toFixed(1)}일 vs 손실 매매 평균 ${avgLossHold.toFixed(1)}일 — 손절을 더 빨리 해야 함.`,
      confidence: compoundConfidence(0.80, holdingDays.length),
      sampleCount: holdingDays.length,
      lastUpdated: now(),
    });
  }

  if (avgWinHold < 3 && wins.length >= 5) {
    insights.push({
      category: 'TIMING',
      insight: `[해외] 수익 매매 평균 보유기간 ${avgWinHold.toFixed(1)}일 — 단기 트레이딩 전략이 효과적.`,
      confidence: compoundConfidence(0.70, wins.length),
      sampleCount: wins.length,
      lastUpdated: now(),
    });
  }

  return insights;
}

// ══════════════════════════════════════════════════════════════
// 5. 통합: 해외 전체 분석 실행
// ══════════════════════════════════════════════════════════════
export async function analyzeOverseasAll(isPaper: boolean): Promise<LearnedInsight[]> {
  try {
    const [sectorInsights, closeReasonInsights, stockInsights, holdingInsights] = await Promise.all([
      analyzeOverseasSectorPerformance(isPaper),
      analyzeCloseReasonOptimization(isPaper),
      analyzeOverseasStockPerformance(isPaper),
      analyzeOverseasHoldingPeriod(isPaper),
    ]);

    const all = [...sectorInsights, ...closeReasonInsights, ...stockInsights, ...holdingInsights];
    logger.info(`🌏 해외 자기학습: ${all.length}개 인사이트 (섹터 ${sectorInsights.length}, 사유 ${closeReasonInsights.length}, 종목 ${stockInsights.length}, 보유기간 ${holdingInsights.length})`, { component: 'LEARN' });
    return all;
  } catch (err) {
    logger.warn(`해외 자기학습 실패: ${err}`, { component: 'LEARN' });
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// 6. 해외 인사이트 → AI 프롬프트 컨텍스트
// ══════════════════════════════════════════════════════════════
export async function getOverseasInsightsForPrompt(): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT * FROM learned_insights
     WHERE insight LIKE '[해외]%' AND is_paper = $1
     ORDER BY confidence DESC, sample_count DESC
     LIMIT 10`,
    [getCtxIsPaper()],
  ).catch(() => ({ rows: [] }));

  if (rows.length === 0) return '';

  const lines = [
    '\n## 🌏 해외주식 학습 인사이트 — 해외 매매 판단에 반영하세요',
  ];

  for (const r of rows) {
    const tag = r.confidence >= 0.85 ? '【필수】' : r.confidence >= 0.75 ? '【권장】' : '【참고】';
    lines.push(`  ${tag} ${r.insight} (신뢰도 ${(r.confidence * 100).toFixed(0)}%, ${r.sample_count}건)`);
  }

  return lines.join('\n');
}
