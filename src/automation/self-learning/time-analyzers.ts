import { IDLE_PARK_STOCK_CODE } from '../../ai/track-b/cash-manager.js';
import { getPool } from '../../db/client.js';
import { getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import type { EnrichedChain, LearnedInsight } from './index.js';

// 모듈 레벨 stale timestamp 제거 — 아래 함수 내부에서 생성
const _now = () => new Date().toISOString();

function calculateATR(candles: { high: number; low: number; close: number }[], period: number): number {
  if (candles.length < period + 1) return 0;

  const trueRanges = [];
  for (let i = 0; i < period; i++) {
    const currentCandle = candles[i];
    const prevCandle = candles[i + 1];
    const tr = Math.max(
      currentCandle.high - currentCandle.low,
      Math.abs(currentCandle.high - prevCandle.close),
      Math.abs(currentCandle.low - prevCandle.close),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length === 0) return 0;
  return trueRanges.reduce((sum, val) => sum + val, 0) / trueRanges.length;
}

export async function analyzeOptimalTrailingStop(enrichedChains: EnrichedChain[]): Promise<LearnedInsight[]> {
  const sniperTrades = enrichedChains.filter((c) => c.entryType === 'SNIPER' && c.sniperType && c.pnlPct > 0);
  if (sniperTrades.length < 5) return [];

  const tradesByType = new Map<string, EnrichedChain[]>();
  for (const trade of sniperTrades) {
    const existing = tradesByType.get(trade.sniperType!) ?? [];
    tradesByType.set(trade.sniperType!, [...existing, trade]);
  }

  const insights: LearnedInsight[] = [];
  const multipliersToTest = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0];

  for (const [type, trades] of tradesByType.entries()) {
    if (trades.length < 5) continue;

    const totalPnlByMultiplier = new Map<number, number>();
    for (const m of multipliersToTest) {
      totalPnlByMultiplier.set(m, 0);
    }

    for (const trade of trades) {
      const openDate = new Date(trade.chain.opened_at);
      const closeDate = new Date(trade.chain.closed_at);
      const holdingDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
      const daysToFetch = Math.ceil(holdingDays) + 30;

      const allChartData = await getDailyChart(trade.chain.stock_code, daysToFetch);
      if (!allChartData || allChartData.length < 20) continue;

      const tradeCandles = allChartData
        .filter((c) => c.date >= trade.chain.opened_at.split('T')[0] && c.date <= trade.chain.closed_at.split('T')[0])
        .sort((a, b) => a.date.localeCompare(b.date));

      if (tradeCandles.length === 0) continue;

      const avgBuyPrice = Number(trade.chain.avg_buy_price);
      const quantity = Number(trade.chain.total_quantity);

      for (const multiplier of multipliersToTest) {
        let peakPrice = avgBuyPrice;
        let simulatedPnl = Number(trade.chain.realized_pnl);

        for (const today of tradeCandles) {
          peakPrice = Math.max(peakPrice, today.high);

          const atrWindow = allChartData.filter((c) => c.date <= today.date).slice(0, 15);
          if (atrWindow.length < 15) continue;

          const atr = calculateATR(atrWindow, 14);
          if (atr === 0) continue;

          const stopPrice = peakPrice - atr * multiplier;

          if (today.close <= stopPrice) {
            simulatedPnl = (today.close - avgBuyPrice) * quantity;
            break;
          }
        }
        totalPnlByMultiplier.set(multiplier, (totalPnlByMultiplier.get(multiplier) ?? 0) + simulatedPnl);
      }
      await sleep(300); // KIS API Rate Limit
    }

    let bestMultiplier = -1;
    let maxPnl = -Infinity;
    for (const [multiplier, totalPnl] of totalPnlByMultiplier.entries()) {
      if (totalPnl > maxPnl) {
        maxPnl = totalPnl;
        bestMultiplier = multiplier;
      }
    }

    const defaultPnl = totalPnlByMultiplier.get(2.5) ?? 0;

    if (bestMultiplier !== -1 && bestMultiplier !== 2.5 && maxPnl > defaultPnl * 1.05 && defaultPnl > 0) {
      insights.push({
        category: 'TIMING',
        insight: `스나이퍼 '${type}' 타입은 ATR 트레일링 스탑 계수를 ${bestMultiplier}배로 설정 시 수익성이 가장 높았습니다 (기본 2.5배 대비 +${((maxPnl / defaultPnl - 1) * 100).toFixed(0)}%).`,
        confidence: 0.7,
        sampleCount: trades.length,
        lastUpdated: _now(),
        details: {
          param: 'ATR_MULTIPLIER',
          sniperType: type,
          value: bestMultiplier,
        },
      });
    }
  }

  return insights;
}

export function analyzeTimeOfDayPerformance(
  enrichedChains: {
    chain: any;
    pnlPct: number;
    holdingDays: number;
    entryType: string;
    sniperType: string | null;
    initialConfidence: number | null;
  }[],
): LearnedInsight[] {
  const insights: LearnedInsight[] = [];
  const now = new Date().toISOString();

  type HourBucket = { wins: number; total: number; pnlSum: number };
  const buckets: Record<number, HourBucket> = {};

  for (const { chain, pnlPct } of enrichedChains) {
    const entryTime = chain.opened_at ?? chain.created_at;
    if (!entryTime) continue;
    const hour = new Date(new Date(entryTime).getTime() + 9 * 3600_000).getUTCHours();
    if (!buckets[hour]) buckets[hour] = { wins: 0, total: 0, pnlSum: 0 };
    buckets[hour].total++;
    buckets[hour].pnlSum += pnlPct;
    if (pnlPct > 0) buckets[hour].wins++;
  }

  const hours = Object.entries(buckets)
    .filter(([, b]) => b.total >= 3)
    .map(([h, b]) => ({ hour: Number(h), winRate: b.wins / b.total, avgPnl: b.pnlSum / b.total, total: b.total }))
    .sort((a, b) => b.avgPnl - a.avgPnl);

  if (hours.length === 0) return insights;

  const best = hours[0];
  const worst = hours[hours.length - 1];

  if (best.avgPnl > 0.5) {
    insights.push({
      category: 'TIMING',
      insight: `${best.hour}시 진입 매매 평균 ${best.avgPnl.toFixed(1)}% 수익 (승률 ${Math.round(best.winRate * 100)}%, ${best.total}건). 이 시간대 진입 선호.`,
      confidence: Math.min(0.9, 0.5 + best.total * 0.05),
      sampleCount: best.total,
      lastUpdated: _now(),
    });
  }

  if (worst.avgPnl < -0.3 && worst.total >= 3) {
    insights.push({
      category: 'TIMING',
      insight: `${worst.hour}시 진입 매매 평균 ${worst.avgPnl.toFixed(1)}% 손실 (${worst.total}건). 이 시간대 신규 진입 주의.`,
      recommendation: `${worst.hour}시 대 진입 시 매수 임계치를 5점 높이거나 진입 보류.`,
      confidence: Math.min(0.85, 0.5 + worst.total * 0.05),
      sampleCount: worst.total,
      lastUpdated: _now(),
    });
  }

  return insights;
}

export function analyzeDayOfWeekPerformance(
  enrichedChains: {
    chain: any;
    pnlPct: number;
    holdingDays: number;
    entryType: string;
    sniperType: string | null;
    initialConfidence: number | null;
  }[],
): LearnedInsight[] {
  const insights: LearnedInsight[] = [];
  const now = new Date().toISOString();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  type DayBucket = { wins: number; total: number; pnlSum: number };
  const buckets: Record<number, DayBucket> = {};

  for (const { chain, pnlPct } of enrichedChains) {
    const entryTime = chain.opened_at ?? chain.created_at;
    if (!entryTime) continue;
    const day = new Date(new Date(entryTime).getTime() + 9 * 3600_000).getUTCDay();
    if (!buckets[day]) buckets[day] = { wins: 0, total: 0, pnlSum: 0 };
    buckets[day].total++;
    buckets[day].pnlSum += pnlPct;
    if (pnlPct > 0) buckets[day].wins++;
  }

  const days = Object.entries(buckets)
    .filter(([, b]) => b.total >= 3)
    .map(([d, b]) => ({ day: Number(d), winRate: b.wins / b.total, avgPnl: b.pnlSum / b.total, total: b.total }))
    .sort((a, b) => b.avgPnl - a.avgPnl);

  if (days.length === 0) return insights;

  const best = days[0];
  const worst = days[days.length - 1];

  if (best.avgPnl > 0.3) {
    insights.push({
      category: 'TIMING',
      insight: `${dayNames[best.day]}요일 진입이 평균 ${best.avgPnl.toFixed(1)}% 수익으로 가장 우수 (승률 ${Math.round(best.winRate * 100)}%, ${best.total}건).`,
      confidence: Math.min(0.85, 0.5 + best.total * 0.04),
      sampleCount: best.total,
      lastUpdated: _now(),
    });
  }

  if (worst.avgPnl < -0.2 && days.length > 2) {
    insights.push({
      category: 'TIMING',
      insight: `${dayNames[worst.day]}요일 진입 평균 ${worst.avgPnl.toFixed(1)}% 손실 (${worst.total}건). 해당 요일 신규 진입 시 더 높은 점수 요구.`,
      recommendation: `${dayNames[worst.day]}요일 매수 임계치 +5점 상향 검토.`,
      confidence: Math.min(0.8, 0.45 + worst.total * 0.04),
      sampleCount: worst.total,
      lastUpdated: _now(),
    });
  }

  return insights;
}

export async function analyzeParkingDecisions(): Promise<LearnedInsight[]> {
  const IDLE_PARK_CODE = IDLE_PARK_STOCK_CODE; // 현재: 삼성전자(005930)
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const { rows: parkChains } = await getPool().query(
      `SELECT tc.*, COALESCE(json_agg(o.*) FILTER (WHERE o.id IS NOT NULL), '[]') AS orders
         FROM transaction_chains tc
         LEFT JOIN orders o ON o.chain_id = tc.id
        WHERE tc.stock_code = $1
          AND tc.status = 'CLOSED'
          AND tc.closed_at >= $2
          AND tc.is_paper = false
        GROUP BY tc.id
        ORDER BY tc.closed_at DESC`,
      [IDLE_PARK_CODE, ninetyDaysAgo.toISOString()],
    );

    if (parkChains.length < 3) return [];

    const parkReturns = parkChains.map((c: any) => {
      const pnlPct = Number(c.total_invested) > 0 ? (Number(c.realized_pnl) / Number(c.total_invested)) * 100 : 0;
      const holdDays = (new Date(c.closed_at).getTime() - new Date(c.opened_at).getTime()) / (1000 * 60 * 60 * 24);
      return { pnlPct, holdDays, openedAt: c.opened_at, closedAt: c.closed_at };
    });

    const { rows: watchlistRows } = await getPool().query(
      `SELECT DISTINCT stock_code FROM watchlist WHERE is_active = true LIMIT 10`,
    );

    const insights: LearnedInsight[] = [];

    const avgParkPnlPct = parkReturns.reduce((s, r) => s + r.pnlPct, 0) / parkReturns.length;
    const avgHoldDays = parkReturns.reduce((s, r) => s + r.holdDays, 0) / parkReturns.length;
    const annualizedParkReturn = avgHoldDays > 0 ? (avgParkPnlPct / avgHoldDays) * 365 : 0;

    if (parkChains.length >= 3) {
      if (annualizedParkReturn > 2) {
        insights.push({
          category: 'TIMING',
          insight: `머니마켓 파킹 ${parkChains.length}회 분석: 평균 보유 ${avgHoldDays.toFixed(1)}일, 연환산 ${annualizedParkReturn.toFixed(1)}% 수익. 유휴 현금 파킹이 원금 보전에 효과적.`,
          confidence: 0.7,
          sampleCount: parkChains.length,
          lastUpdated: _now(),
        });
      }

      if (avgHoldDays > 3 && watchlistRows.length > 0) {
        insights.push({
          category: 'TIMING',
          insight: `파킹 평균 보유 기간이 ${avgHoldDays.toFixed(1)}일로 길어지고 있음. 매수 기회 포착이 지연되고 있는지 확인 필요. AI 스코어 임계값을 점검하세요.`,
          recommendation: `buy_threshold를 낮춰 매수 기회를 늘리거나, 기술 폴백 임계값 재검토.`,
          confidence: 0.65,
          sampleCount: parkChains.length,
          lastUpdated: _now(),
        });
      }
    }

    return insights;
  } catch (err) {
    logger.warn(`파킹 분석 실패: ${err}`, { component: 'LEARN' });
    return [];
  }
}
