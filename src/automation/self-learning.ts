import { getPool, logSystem } from '../db/client.js';
import { getDailyChart } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 🧠 자기학습 모듈 (Self-Learning / Reinforcement)
 *
 * 핵심 아이디어:
 * "수익이 좋았던 매매 로그를 분석 → 어떤 조건에서 잘 벌었는지 패턴 추출
 *  → 다음 매매 시 AI 프롬프트에 성공 패턴을 주입"
 *
 * 매주 일요일 실행:
 * 1. 최근 30일 청산 완료된 체인 분석
 * 2. 수익 매매 vs 손실 매매 패턴 비교
 * 3. 성공 패턴 → "학습된 인사이트"로 DB 저장
 * 4. Track B Claude에 학습 인사이트를 컨텍스트로 주입
 *
 * → 시간이 지날수록 AI가 "이 종목, 이 조건이면 잘 벌었다"를 기억
 */

export interface LearnedInsight {
  id?: string;
  category: 'WIN_PATTERN' | 'LOSS_PATTERN' | 'TIMING' | 'SIZING';
  insight: string;
  confidence: number; // 0~1
  sampleCount: number; // 근거 매매 건수
  lastUpdated: string;
  details?: Record<string, any>;
}

interface EnrichedChain {
  chain: any; // Original chain data
  pnlPct: number;
  holdingDays: number;
  entryType: 'SNIPER' | 'TRACK_B' | 'UNKNOWN';
  sniperType?: string;
  initialConfidence?: number;
}

const now = new Date().toISOString();

/**
 * 과거 매매 분석 → 패턴 추출
 */
export async function analyzeTradeHistory(): Promise<LearnedInsight[]> {
  logger.info('🧠 자기학습 분석 시작', { component: 'LEARN' });

  // 최근 90일 청산 체인 + 관련 주문
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const { rows: chains } = await getPool().query(
    `SELECT tc.*,
       COALESCE(json_agg(o.*) FILTER (WHERE o.id IS NOT NULL), '[]') AS orders
     FROM transaction_chains tc
     LEFT JOIN orders o ON o.chain_id = tc.id
     WHERE tc.status = 'CLOSED' AND tc.closed_at >= $1
     GROUP BY tc.id
     ORDER BY tc.closed_at DESC`,
    [ninetyDaysAgo.toISOString()],
  );

  if (!chains || chains.length < 10) {
    logger.info('학습 데이터 부족 (최소 10건 필요)', { component: 'LEARN' });
    return [];
  }

  // 1. 데이터 전처리 (Enrichment)
  const enrichedChains: EnrichedChain[] = chains.map((chain) => {
    const open = new Date(chain.opened_at);
    const close = new Date(chain.closed_at);
    const holdingDays = (close.getTime() - open.getTime()) / (1000 * 60 * 60 * 24);
    const pnlPct = (Number(chain.realized_pnl) / Number(chain.total_invested)) * 100;

    const firstOrder = (chain.orders as any[])?.find((o) => o.side === 'BUY');
    let entryType: EnrichedChain['entryType'] = 'UNKNOWN';
    let sniperType: string | undefined;
    let initialConfidence: number | undefined;

    if (firstOrder?.ai_reasoning) {
      const reasoning = firstOrder.ai_reasoning;
      if (reasoning.includes('[SNIPER')) {
        entryType = 'SNIPER';
        const sniperMatch = reasoning.match(/\[SNIPER\s(.*?)]/);
        if (sniperMatch) sniperType = sniperMatch[1];

        const confidenceMatch = reasoning.match(/신뢰도\s(\d+)%/);
        if (confidenceMatch) initialConfidence = parseInt(confidenceMatch[1], 10);
      } else if (reasoning.includes('Track B')) {
        entryType = 'TRACK_B';
      }
    }

    return { chain, pnlPct, holdingDays, entryType, sniperType, initialConfidence };
  });

  const wins = enrichedChains.filter((c) => Number(c.chain.realized_pnl) > 0);
  const losses = enrichedChains.filter((c) => Number(c.chain.realized_pnl) <= 0);

  // 2. 개별 분석기 실행
  const insights: LearnedInsight[] = [
    ...analyzeAveraging(wins, losses),
    ...analyzeHoldingPeriod(wins, losses),
    ...analyzeModePerformance(enrichedChains),
    ...analyzeStockPerformance(enrichedChains),
    ...analyzeWinRateTrend(chains),
    ...analyzeSniperPerformance(wins, losses),
    ...analyzeConfidenceCorrelation(enrichedChains),
    ...analyzeHoldingPeriodByEntry(wins),
    ...(await analyzeOptimalTrailingStop(enrichedChains)),
    ...analyzeSniperByMarketRegime(enrichedChains),
  ];

  // 3. DB에 인사이트 저장 및 알림
  if (insights.length > 0) {
    await saveInsights(insights);
  }

  return insights;
}

function calculateATR(candles: { high: number; low: number; close: number }[], period: number): number {
  // Expects candles sorted newest to oldest
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

function analyzeAveraging(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
  if (wins.length < 3) return [];
  const avgAvgCountWin = wins.reduce((s, c) => s + c.chain.current_averaging_count, 0) / wins.length;
  const avgAvgCountLoss =
    losses.length > 0 ? losses.reduce((s, c) => s + c.chain.current_averaging_count, 0) / losses.length : 0;

  if (avgAvgCountWin > avgAvgCountLoss + 0.5) {
    return [
      {
        category: 'WIN_PATTERN',
        insight: `물타기를 적극 활용한 매매가 수익률이 높음 (수익 평균 ${avgAvgCountWin.toFixed(1)}회 vs 손실 ${avgAvgCountLoss.toFixed(1)}회). 물타기 기회를 놓치지 말 것.`,
        confidence: 0.7,
        sampleCount: wins.length,
        lastUpdated: now,
      },
    ];
  } else if (avgAvgCountWin < avgAvgCountLoss - 0.3) {
    return [
      {
        category: 'WIN_PATTERN',
        insight: `물타기 없이 1차 매수만으로 수익낸 경우가 많음. 물타기보다 진입 타이밍이 중요.`,
        confidence: 0.65,
        sampleCount: wins.length,
        lastUpdated: now,
      },
    ];
  }
  return [];
}

function analyzeHoldingPeriod(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
  if (wins.length < 3) return [];
  const insights: LearnedInsight[] = [];
  const avgWinHold = wins.reduce((s, d) => s + d.holdingDays, 0) / wins.length;
  const avgLossHold = losses.length > 0 ? losses.reduce((s, d) => s + d.holdingDays, 0) / losses.length : 0;

  if (avgWinHold < 3) {
    insights.push({
      category: 'TIMING',
      insight: `수익 매매는 평균 ${avgWinHold.toFixed(1)}일 보유. 빠른 단기 매매의 성과가 좋음.`,
      confidence: 0.75,
      sampleCount: wins.length,
      lastUpdated: now,
    });
  }
  if (avgLossHold > avgWinHold * 1.5 && avgLossHold > 0) {
    insights.push({
      category: 'LOSS_PATTERN',
      insight: `손실 매매는 평균 ${avgLossHold.toFixed(1)}일로 수익(${avgWinHold.toFixed(1)}일) 대비 오래 보유. 손절을 더 빨리 할 것.`,
      confidence: 0.8,
      sampleCount: losses.length,
      lastUpdated: now,
    });
  }
  return insights;
}

function analyzeModePerformance(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  const modeResults = new Map<string, { wins: number; losses: number; totalPnl: number }>();
  for (const { chain } of enrichedChains) {
    const mode = chain.strategy_mode ?? 'SWING';
    const existing = modeResults.get(mode) ?? { wins: 0, losses: 0, totalPnl: 0 };
    existing.totalPnl += Number(chain.realized_pnl);
    if (Number(chain.realized_pnl) > 0) existing.wins++;
    else existing.losses++;
    modeResults.set(mode, existing);
  }

  const insights: LearnedInsight[] = [];
  for (const [mode, stats] of modeResults) {
    const total = stats.wins + stats.losses;
    if (total >= 5) {
      const winRate = (stats.wins / total) * 100;
      insights.push({
        category: 'WIN_PATTERN',
        insight: `${mode} 모드 성과: 승률 ${winRate.toFixed(0)}% (${stats.wins}승 ${stats.losses}패), 총 수익 ${stats.totalPnl.toLocaleString()}원`,
        confidence: total >= 10 ? 0.85 : 0.6,
        sampleCount: total,
        lastUpdated: now,
      });
    }
  }
  return insights;
}

function analyzeStockPerformance(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  const stockResults = new Map<string, { wins: number; losses: number; totalPnl: number }>();
  for (const { chain } of enrichedChains) {
    const code = chain.stock_code;
    const existing = stockResults.get(code) ?? { wins: 0, losses: 0, totalPnl: 0 };
    existing.totalPnl += Number(chain.realized_pnl);
    if (Number(chain.realized_pnl) > 0) existing.wins++;
    else existing.losses++;
    stockResults.set(code, existing);
  }

  const insights: LearnedInsight[] = [];
  for (const [code, stats] of stockResults) {
    const total = stats.wins + stats.losses;
    if (total < 3) continue;
    const winRate = stats.wins / total;

    if (winRate >= 0.75) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `종목 '${code}'는 승률 ${(winRate * 100).toFixed(0)}% (${total}건)로, 현재 전략과 궁합이 좋음.`,
        confidence: 0.75,
        sampleCount: total,
        lastUpdated: now,
      });
    } else if (winRate <= 0.33 && total >= 3) {
      insights.push({
        category: 'LOSS_PATTERN',
        insight: `종목 '${code}'는 승률 ${(winRate * 100).toFixed(0)}% (${total}건)로, 현재 전략과 맞지 않음. 진입에 신중할 것.`,
        confidence: 0.7,
        sampleCount: total,
        lastUpdated: now,
      });
    }
  }
  return insights;
}

function analyzeWinRateTrend(chains: any[]): LearnedInsight[] {
  if (chains.length >= 20) {
    const recent10 = chains.slice(0, 10);
    const older10 = chains.slice(10, 20);
    const recentWinRate = recent10.filter((c) => Number(c.realized_pnl) > 0).length / 10;
    const olderWinRate = older10.filter((c) => Number(c.realized_pnl) > 0).length / 10;

    if (recentWinRate > olderWinRate + 0.15) {
      return [
        {
          category: 'TIMING',
          insight: `최근 승률이 개선 중 (${(recentWinRate * 100).toFixed(0)}% vs 이전 ${(olderWinRate * 100).toFixed(0)}%). 현재 전략이 시장에 잘 맞는 시기.`,
          confidence: 0.7,
          sampleCount: 20,
          lastUpdated: now,
        },
      ];
    } else if (recentWinRate < olderWinRate - 0.15) {
      return [
        {
          category: 'LOSS_PATTERN',
          insight: `최근 승률이 하락 중 (${(recentWinRate * 100).toFixed(0)}% vs 이전 ${(olderWinRate * 100).toFixed(0)}%). 포지션 축소 또는 전략 조정 필요.`,
          confidence: 0.8,
          sampleCount: 20,
          lastUpdated: now,
        },
      ];
    }
  }
  return [];
}

function analyzeSniperPerformance(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
  const sniperStats = new Map<string, { wins: number; losses: number }>();
  const allSniperTrades = [...wins, ...losses].filter((c) => c.entryType === 'SNIPER' && c.sniperType);

  for (const trade of allSniperTrades) {
    const stats = sniperStats.get(trade.sniperType!) ?? { wins: 0, losses: 0 };
    if (Number(trade.chain.realized_pnl) > 0) stats.wins++;
    else stats.losses++;
    sniperStats.set(trade.sniperType!, stats);
  }

  const insights: LearnedInsight[] = [];
  for (const [type, stats] of sniperStats.entries()) {
    const total = stats.wins + stats.losses;
    if (total < 3) continue;
    const winRate = stats.wins / total;

    if (winRate >= 0.8) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `스나이퍼 '${type}' 타입의 승률이 ${(winRate * 100).toFixed(0)}%로 매우 높음. 해당 시그널을 우선적으로 고려할 것.`,
        confidence: 0.8,
        sampleCount: total,
        lastUpdated: now,
      });
    }
  }
  return insights;
}

function analyzeConfidenceCorrelation(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  const sniperTrades = enrichedChains.filter((c) => c.entryType === 'SNIPER' && c.initialConfidence);
  if (sniperTrades.length < 10) return [];

  const highConfTrades = sniperTrades.filter((c) => c.initialConfidence! >= 85);
  const midConfTrades = sniperTrades.filter((c) => c.initialConfidence! < 85);

  if (highConfTrades.length < 3 || midConfTrades.length < 5) return [];

  const highConfWinRate = highConfTrades.filter((c) => Number(c.chain.realized_pnl) > 0).length / highConfTrades.length;
  const midConfWinRate = midConfTrades.filter((c) => Number(c.chain.realized_pnl) > 0).length / midConfTrades.length;

  if (highConfWinRate > midConfWinRate + 0.2) {
    return [
      {
        category: 'SIZING',
        insight: `초기 신뢰도 85% 이상 스나이퍼 시그널의 승률(${(highConfWinRate * 100).toFixed(0)}%)이 그 이하(${(midConfWinRate * 100).toFixed(0)}%)보다 월등히 높음. 고신뢰도 시그널에 대한 투자 비중 확대는 유효한 전략.`,
        confidence: 0.8,
        sampleCount: sniperTrades.length,
        lastUpdated: now,
      },
    ];
  }
  return [];
}

function analyzeHoldingPeriodByEntry(wins: EnrichedChain[]): LearnedInsight[] {
  const pullbackWins = wins.filter((c) => c.sniperType === 'PULLBACK_BOUNCE');
  if (pullbackWins.length < 3) return [];

  const otherWins = wins.filter((c) => c.sniperType !== 'PULLBACK_BOUNCE');
  if (otherWins.length < 3) return [];

  const avgPullbackHold = pullbackWins.reduce((sum, c) => sum + c.holdingDays, 0) / pullbackWins.length;
  const avgOtherHold = otherWins.reduce((sum, c) => sum + c.holdingDays, 0) / otherWins.length;

  if (avgPullbackHold < avgOtherHold * 0.7) {
    return [
      {
        category: 'TIMING',
        insight: `'눌림목 반등' 시그널은 평균 ${avgPullbackHold.toFixed(1)}일 보유로, 다른 수익 매매(${avgOtherHold.toFixed(1)}일)보다 단기 수익 실현에 더 적합함.`,
        confidence: 0.7,
        sampleCount: pullbackWins.length,
        lastUpdated: now,
      },
    ];
  }
  return [];
}

async function analyzeOptimalTrailingStop(enrichedChains: EnrichedChain[]): Promise<LearnedInsight[]> {
  // 수익이 난 스나이퍼 거래만 분석 대상으로 함
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
    if (trades.length < 5) continue; // 타입별 최소 5건의 데이터 필요

    const totalPnlByMultiplier = new Map<number, number>();
    for (const m of multipliersToTest) {
      totalPnlByMultiplier.set(m, 0);
    }

    for (const trade of trades) {
      const openDate = new Date(trade.chain.opened_at);
      const closeDate = new Date(trade.chain.closed_at);
      const holdingDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
      const daysToFetch = Math.ceil(holdingDays) + 30; // ATR 계산을 위한 버퍼

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
        let simulatedPnl = Number(trade.chain.realized_pnl); // 시뮬레이션에서 청산 안되면 실제 수익으로 계산

        for (const today of tradeCandles) {
          peakPrice = Math.max(peakPrice, today.high);

          const atrWindow = allChartData.filter((c) => c.date <= today.date).slice(0, 15);
          if (atrWindow.length < 15) continue;

          const atr = calculateATR(atrWindow, 14);
          if (atr === 0) continue;

          const stopPrice = peakPrice - atr * multiplier;

          if (today.close <= stopPrice) {
            simulatedPnl = (today.close - avgBuyPrice) * quantity;
            break; // 해당 계수 시뮬레이션 종료
          }
        }
        totalPnlByMultiplier.set(multiplier, (totalPnlByMultiplier.get(multiplier) ?? 0) + simulatedPnl);
      }
      await new Promise((r) => setTimeout(r, 300)); // KIS API Rate Limit
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

    // 최적 계수가 기본값(2.5)이 아니고, 5% 이상 수익 개선 효과가 있을 때만 인사이트 생성
    if (bestMultiplier !== -1 && bestMultiplier !== 2.5 && maxPnl > defaultPnl * 1.05 && defaultPnl > 0) {
      insights.push({
        category: 'TIMING',
        insight: `스나이퍼 '${type}' 타입은 ATR 트레일링 스탑 계수를 ${bestMultiplier}배로 설정 시 수익성이 가장 높았습니다 (기본 2.5배 대비 +${((maxPnl / defaultPnl - 1) * 100).toFixed(0)}%).`,
        confidence: 0.7,
        sampleCount: trades.length,
        lastUpdated: now,
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

function analyzeSniperByMarketRegime(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  const regimeStats = new Map<string, Map<string, { wins: number; losses: number; totalPnl: number }>>();

  const sniperTrades = enrichedChains.filter((c) => c.entryType === 'SNIPER' && c.sniperType);

  for (const trade of sniperTrades) {
    const mode = trade.chain.strategy_mode ?? 'SWING';
    const type = trade.sniperType!;

    if (!regimeStats.has(mode)) {
      regimeStats.set(mode, new Map());
    }
    const modeMap = regimeStats.get(mode)!;

    const stats = modeMap.get(type) ?? { wins: 0, losses: 0, totalPnl: 0 };
    if (trade.pnlPct > 0) {
      stats.wins++;
    } else {
      stats.losses++;
    }
    stats.totalPnl += Number(trade.chain.realized_pnl);
    modeMap.set(type, stats);
  }

  const insights: LearnedInsight[] = [];

  for (const [mode, typeStats] of regimeStats.entries()) {
    if (typeStats.size < 2) continue; // 비교를 위해 최소 2개 타입 필요

    let bestPerformer = { type: '', winRate: 0, total: 0 };

    for (const [type, stats] of typeStats.entries()) {
      const total = stats.wins + stats.losses;
      if (total < 5) continue; // 타입별 최소 5건의 데이터 필요

      const winRate = stats.wins / total;
      if (winRate > bestPerformer.winRate) {
        bestPerformer = { type, winRate, total };
      }
    }

    if (bestPerformer.type && bestPerformer.winRate >= 0.7) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `'${mode}' 장세에서는 '${bestPerformer.type}' 스나이퍼의 승률이 ${(bestPerformer.winRate * 100).toFixed(0)}%로 가장 높았습니다. 이 장세에서는 해당 타입의 시그널을 우선적으로 고려해야 합니다.`,
        confidence: 0.75,
        sampleCount: bestPerformer.total,
        lastUpdated: now,
        details: {
          param: 'BEST_SNIPER_FOR_MODE',
          mode: mode,
          sniperType: bestPerformer.type,
        },
      });
    }
  }

  return insights;
}

async function saveInsights(insights: LearnedInsight[]): Promise<void> {
  if (insights.length > 0) {
    // 기존 인사이트 삭제 후 새로 삽입
    await getPool().query('DELETE FROM learned_insights WHERE id IS NOT NULL');
    for (const insight of insights) {
      await getPool().query(
        `INSERT INTO learned_insights (category, insight, confidence, sample_count, last_updated, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          insight.category,
          insight.insight,
          insight.confidence,
          insight.sampleCount,
          insight.lastUpdated,
          insight.details ? JSON.stringify(insight.details) : null,
        ],
      );
    }

    const _summary = insights.map((i) => `[${i.category}] ${i.insight}`).join('\n');
    await logSystem('INFO', 'LEARN', `자기학습 완료: ${insights.length}개 인사이트 추출`);

    await sendTelegramMessage(
      `🧠 *자기학습 완료*\n${insights.length}개 패턴 학습\n\n` +
        insights
          .slice(0, 5)
          .map((i) => `• ${i.insight.split('—')[0]}`)
          .join('\n'),
    );

    logger.info(`🧠 자기학습 완료: ${insights.length}개 인사이트`, { component: 'LEARN' });
  }
}

/**
 * Track B Claude에 주입할 학습 인사이트 텍스트
 */
export async function getLearnedInsightsForPrompt(): Promise<string> {
  const { rows: data } = await getPool().query('SELECT * FROM learned_insights ORDER BY confidence DESC LIMIT 8');

  if (!data || data.length === 0) return '';

  const lines = [
    '\n## 과거 매매에서 학습된 인사이트 (자기학습 결과)',
    '아래는 실제 매매 결과를 분석하여 추출한 패턴입니다. 매매 판단 시 참고하세요.',
  ];

  for (const insight of data) {
    lines.push(
      `- [${insight.category}] ${insight.insight} (신뢰도 ${(insight.confidence * 100).toFixed(0)}%, 근거 ${insight.sample_count}건)`,
    );
  }

  return lines.join('\n');
}

export interface LearnedParameters {
  trailingStopMultipliers: Record<string, number>;
}

/**
 * DB에서 학습된 파라미터를 구조화된 형태로 가져옵니다.
 * 백테스팅 및 실거래에서 사용됩니다.
 */
export async function getLearnedParameters(): Promise<LearnedParameters> {
  const params: LearnedParameters = {
    trailingStopMultipliers: {},
  };

  const { rows: data } = await getPool().query(
    'SELECT details FROM learned_insights WHERE category = $1 AND confidence > $2',
    ['TIMING', 0.65],
  );

  if (!data || data.length === 0) return params;

  for (const insight of data) {
    const details = insight.details as any;
    if (details?.param === 'ATR_MULTIPLIER' && details.sniperType && typeof details.value === 'number') {
      params.trailingStopMultipliers[details.sniperType] = details.value;
    }
  }

  return params;
}
