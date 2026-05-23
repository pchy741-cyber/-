import { config } from '../config/index.js';
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

export interface InsightParamChange {
  field: 'mode' | 'stop_loss_pct' | 'take_profit_pct' | 'buy_threshold';
  value: string | number;
  reason: string;
}

export interface LearnedInsight {
  id?: string;
  category: 'WIN_PATTERN' | 'LOSS_PATTERN' | 'TIMING' | 'SIZING';
  insight: string;
  confidence: number; // 0~1
  sampleCount: number; // 근거 매매 건수
  lastUpdated: string;
  details?: Record<string, any>;
  /** 구체적 행동 권장사항 (UI에 표시) */
  recommendation?: string;
  /** 자동 적용 가능한 전략 파라미터 변경 */
  paramChange?: InsightParamChange;
  /** 이미 적용됐는지 (DB에서 로드 시) */
  isApplied?: boolean;
}

interface EnrichedChain {
  chain: any; // Original chain data
  pnlPct: number;
  holdingDays: number;
  entryType: 'SNIPER' | 'TRACK_B' | 'UNKNOWN';
  sniperType: string | null;
  initialConfidence: number | null;
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
     WHERE tc.status = 'CLOSED' AND tc.closed_at >= $1 AND tc.is_paper = $2
     GROUP BY tc.id
     ORDER BY tc.closed_at DESC`,
    [ninetyDaysAgo.toISOString(), config.isPaper],
  );

  if (!chains || chains.length < 3) {
    logger.info('학습 데이터 부족 (최소 3건 필요)', { component: 'LEARN' });
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
    let sniperType: string | null = null;
    let initialConfidence: number | null = null;

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

  // 파킹 체인 별도 분석
  const parkingInsights = await analyzeParkingDecisions();

  // 2. 개별 분석기 실행
  const insights: LearnedInsight[] = [
    ...analyzeAveraging(wins, losses),
    ...analyzeHoldingPeriod(wins, losses),
    ...analyzeModePerformance(enrichedChains),
    ...analyzeStockPerformance(enrichedChains),
    ...analyzeStockWinRateAcceleration(enrichedChains),
    ...analyzeWinRateTrend(chains),
    ...analyzeSniperPerformance(wins, losses),
    ...analyzeConfidenceCorrelation(enrichedChains),
    ...analyzeHoldingPeriodByEntry(wins),
    ...(await analyzeOptimalTrailingStop(enrichedChains)),
    ...analyzeSniperByMarketRegime(enrichedChains),
    ...analyzeLossStreakRisk(enrichedChains),
    ...analyzeProfitRatio(wins, losses),
    ...analyzeQuickProfitTaking(wins),
    ...parkingInsights,
    ...analyzeTimeOfDayPerformance(enrichedChains),
    ...analyzeDayOfWeekPerformance(enrichedChains),
    ...(await analyzeBuyThreshold()),
  ];

  // 3. DB에 인사이트 저장 및 알림
  if (insights.length > 0) {
    await saveInsights(insights);
    // 고신뢰도 인사이트 자동 전략 적용 (confidence >= 0.8, paramChange 있는 것만)
    await autoApplyInsights(insights).catch((e) => logger.warn(`자동 적용 실패: ${e}`, { component: 'LEARN' }));
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

  // 최고 성과 모드 찾기
  let bestMode = '';
  let bestWinRate = 0;
  for (const [mode, stats] of modeResults) {
    const total = stats.wins + stats.losses;
    if (total >= 5) {
      const winRate = stats.wins / total;
      if (winRate > bestWinRate) { bestWinRate = winRate; bestMode = mode; }
    }
  }

  for (const [mode, stats] of modeResults) {
    const total = stats.wins + stats.losses;
    if (total >= 5) {
      const winRate = stats.wins / total;
      const winRatePct = (winRate * 100).toFixed(0);
      const isBest = mode === bestMode;
      const isBad = winRate < 0.4 && total >= 8 && stats.totalPnl < 0;

      const insight: LearnedInsight = {
        category: isBad ? 'LOSS_PATTERN' : 'WIN_PATTERN',
        insight: `${mode} 모드 성과: 승률 ${winRatePct}% (${stats.wins}승 ${stats.losses}패), 총 수익 ${stats.totalPnl.toLocaleString()}원`,
        confidence: total >= 10 ? 0.85 : 0.6,
        sampleCount: total,
        lastUpdated: now,
      };

      // 성과 나쁜 모드 → 다른 모드로 전환 권장
      if (isBad && bestMode && bestMode !== mode) {
        insight.recommendation = `${mode} 모드 승률 ${winRatePct}%로 부진. ${bestMode} 모드(승률 ${(bestWinRate * 100).toFixed(0)}%)로 전환하면 성과 개선 가능.`;
        insight.paramChange = { field: 'mode', value: bestMode, reason: `${mode} 승률 ${winRatePct}% → ${bestMode} 우위` };
      } else if (isBest && winRate >= 0.65) {
        insight.recommendation = `${mode} 모드가 현재 가장 효과적. 계속 유지 권장.`;
      }

      insights.push(insight);
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
        insight: `종목 '${code}'는 승률 ${(winRate * 100).toFixed(0)}% (${total}건) — 이 전략과 잘 맞는 종목. 매수 시그널 시 적극 진입하세요.`,
        confidence: 0.75 + (total >= 5 ? 0.05 : 0),
        sampleCount: total,
        lastUpdated: now,
      });
    } else if (winRate <= 0.33 && total >= 3) {
      insights.push({
        category: 'LOSS_PATTERN',
        insight: `종목 '${code}'는 승률 ${(winRate * 100).toFixed(0)}% (${total}건) — 이 전략과 맞지 않음. 스코어가 높아도 BUY를 HOLD로 전환하거나 수량 절반으로 줄이세요.`,
        confidence: 0.7 + (total >= 5 ? 0.1 : 0),
        sampleCount: total,
        lastUpdated: now,
      });
    }
  }
  return insights;
}

/**
 * 종목별 승률 가속 분석 — 최근 거래가 과거보다 더 잘 맞는 종목 자동 감지
 * 이 종목들은 매수 임계값을 더 낮추고 포지션을 더 크게 잡도록 인사이트 생성
 */
function analyzeStockWinRateAcceleration(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  const stockTrades = new Map<string, { pnlPct: number; date: string }[]>();
  for (const { chain, pnlPct } of enrichedChains) {
    const code = chain.stock_code;
    const list = stockTrades.get(code) ?? [];
    list.push({ pnlPct, date: chain.closed_at ?? chain.opened_at });
    stockTrades.set(code, list);
  }

  const insights: LearnedInsight[] = [];

  for (const [code, trades] of stockTrades) {
    if (trades.length < 4) continue;

    // 날짜순 정렬 (오래된 것 먼저)
    const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
    const half = Math.floor(sorted.length / 2);
    const older = sorted.slice(0, half);
    const newer = sorted.slice(half);

    const olderWinRate = older.filter(t => t.pnlPct > 0).length / older.length;
    const newerWinRate = newer.filter(t => t.pnlPct > 0).length / newer.length;
    const olderAvgPnl = older.reduce((s, t) => s + t.pnlPct, 0) / older.length;
    const newerAvgPnl = newer.reduce((s, t) => s + t.pnlPct, 0) / newer.length;

    // 승률이 25%p 이상 개선되거나 평균 수익이 1%p 이상 개선된 종목
    if (newerWinRate > olderWinRate + 0.25 && newerAvgPnl > 0) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `종목 '${code}' 최근 승률 가속: 이전 ${(olderWinRate * 100).toFixed(0)}% → 최근 ${(newerWinRate * 100).toFixed(0)}% (${trades.length}건). 전략 적합성 향상 중 — 신호 시 우선 진입.`,
        confidence: Math.min(0.90, 0.65 + trades.length * 0.03),
        sampleCount: trades.length,
        lastUpdated: now,
        details: { code, olderWinRate, newerWinRate, olderAvgPnl, newerAvgPnl },
      });
    }

    // 반대: 최근 성과 악화 → 경고
    if (newerWinRate < olderWinRate - 0.30 && newerAvgPnl < 0 && trades.length >= 5) {
      insights.push({
        category: 'LOSS_PATTERN',
        insight: `종목 '${code}' 최근 성과 악화: 이전 승률 ${(olderWinRate * 100).toFixed(0)}% → 최근 ${(newerWinRate * 100).toFixed(0)}% (${trades.length}건). 진입 기준 강화 또는 워치리스트 제거 검토.`,
        confidence: Math.min(0.85, 0.60 + trades.length * 0.03),
        sampleCount: trades.length,
        lastUpdated: now,
        recommendation: `${code} 매수 기준 +10점 상향, 지속 부진 시 워치리스트 제거.`,
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

/**
 * 연속 손실 위험 감지 — 최근 5건 중 3건 이상 손실이면 경고
 */
function analyzeLossStreakRisk(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  if (enrichedChains.length < 5) return [];

  const recent5 = enrichedChains.slice(0, 5);
  const lossCount = recent5.filter((c) => Number(c.chain.realized_pnl) <= 0).length;

  if (lossCount >= 3) {
    return [
      {
        category: 'LOSS_PATTERN',
        insight: `최근 5건 중 ${lossCount}건 손실 — 연속 손실 구간. 현재 시장 환경이 전략과 맞지 않음. 신규 매수를 최소화하고 기존 포지션 리스크 관리를 강화하세요.`,
        confidence: 0.85,
        sampleCount: 5,
        lastUpdated: now,
      },
    ];
  }

  return [];
}

/**
 * 수익/손실 비율 분석 — 평균 수익 vs 평균 손실 비율
 */
function analyzeProfitRatio(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
  if (wins.length < 3 || losses.length < 3) return [];

  const avgWinPct = wins.reduce((s, c) => s + c.pnlPct, 0) / wins.length;
  const avgLossPct = Math.abs(losses.reduce((s, c) => s + c.pnlPct, 0) / losses.length);
  const ratio = avgWinPct / avgLossPct;

  const insights: LearnedInsight[] = [];

  if (ratio < 1.0) {
    // 손절을 더 타이트하게 → 현재 avgLossPct의 70%로 제안
    const suggestedStopLoss = -(Math.abs(avgLossPct) * 0.7).toFixed(1);
    insights.push({
      category: 'LOSS_PATTERN',
      insight: `손익비 ${ratio.toFixed(2)} (평균 수익 +${avgWinPct.toFixed(1)}% vs 평균 손실 -${avgLossPct.toFixed(1)}%). 손절 지연이 손익비를 악화시키고 있음.`,
      recommendation: `손절 기준을 ${suggestedStopLoss}%로 타이트하게 조정하면 손익비 개선 가능. 현재 평균 손실 -${avgLossPct.toFixed(1)}%의 70% 수준.`,
      paramChange: { field: 'stop_loss_pct', value: Number(suggestedStopLoss), reason: `손익비 ${ratio.toFixed(2)} 개선 필요` },
      confidence: 0.8,
      sampleCount: wins.length + losses.length,
      lastUpdated: now,
    });
  } else if (ratio >= 2.0) {
    insights.push({
      category: 'WIN_PATTERN',
      insight: `손익비 ${ratio.toFixed(2)} (평균 수익 +${avgWinPct.toFixed(1)}% vs 평균 손실 -${avgLossPct.toFixed(1)}%) — 수익 구조 우수.`,
      recommendation: `현재 손절/익절 기준이 최적화되어 있음. 변경 불필요.`,
      confidence: 0.8,
      sampleCount: wins.length + losses.length,
      lastUpdated: now,
    });
  }

  return insights;
}

/**
 * 단기 빠른 수익 패턴 분석 — 1~2일 안에 목표가 달성한 종목 패턴
 */
function analyzeQuickProfitTaking(wins: EnrichedChain[]): LearnedInsight[] {
  if (wins.length < 5) return [];

  const quickWins = wins.filter((c) => c.holdingDays <= 2 && c.pnlPct >= 1.5);
  const ratio = quickWins.length / wins.length;

  if (ratio >= 0.4 && quickWins.length >= 3) {
    // 빠른 익절이 전체 수익의 40% 이상
    const stockCodes = [...new Set(quickWins.map((c) => c.chain.stock_code))];
    return [
      {
        category: 'WIN_PATTERN',
        insight: `단기 수익(1~2일, +1.5% 이상) 패턴이 전체 수익 거래의 ${(ratio * 100).toFixed(0)}%를 차지. 단기 모멘텀 시 과도한 홀딩보다 빠른 익절이 효과적. 관련 종목: ${stockCodes.slice(0, 3).join(', ')}`,
        confidence: 0.75,
        sampleCount: quickWins.length,
        lastUpdated: now,
      },
    ];
  }

  return [];
}

async function saveInsights(insights: LearnedInsight[]): Promise<void> {
  if (insights.length > 0) {
    // 자동 생성 인사이트만 삭제 (CEO가 수동 입력한 is_manual=true 인사이트는 보존)
    await getPool().query('DELETE FROM learned_insights WHERE is_manual IS NOT TRUE');
    for (const insight of insights) {
      await getPool().query(
        `INSERT INTO learned_insights (category, insight, confidence, sample_count, last_updated, details, recommendation, param_change)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          insight.category,
          insight.insight,
          insight.confidence,
          insight.sampleCount,
          insight.lastUpdated,
          insight.details ? JSON.stringify(insight.details) : null,
          insight.recommendation ?? null,
          insight.paramChange ? JSON.stringify(insight.paramChange) : null,
        ],
      );
    }

    const _summary = insights.map((i) => `[${i.category}] ${i.insight}`).join('\n');
    await logSystem('INFO', 'LEARN', `자기학습 완료: ${insights.length}개 인사이트 추출`).catch(() => {});

    await sendTelegramMessage(
      `🧠 *자기학습 완료*\n${insights.length}개 패턴 학습\n\n` +
        insights
          .slice(0, 5)
          .map((i) => `• ${i.insight.split('—')[0]}`)
          .join('\n'),
    ).catch((e) => logger.warn(`자기학습 알림 실패: ${e}`, { component: 'LEARN' }));

    logger.info(`🧠 자기학습 완료: ${insights.length}개 인사이트`, { component: 'LEARN' });
  }
}

/**
 * Track B Claude에 주입할 학습 인사이트 텍스트
 * - 실제 매매 데이터 기반 패턴 → AI 판단에 강제 적용
 */
export async function getLearnedInsightsForPrompt(): Promise<string> {
  const { rows: data } = await getPool().query(
    'SELECT * FROM learned_insights ORDER BY confidence DESC, sample_count DESC LIMIT 15',
  );

  if (!data || data.length === 0) return '';

  // 카테고리별로 분류
  const lossPatterns = data.filter((d) => d.category === 'LOSS_PATTERN');
  const winPatterns = data.filter((d) => d.category === 'WIN_PATTERN');
  const timingInsights = data.filter((d) => d.category === 'TIMING');
  const sizingInsights = data.filter((d) => d.category === 'SIZING');

  const lines = [
    '\n## ⚠️ 실거래 학습 인사이트 — 반드시 매매 판단에 반영하세요',
    '아래는 실제 수익/손실 매매 데이터를 분석한 결과입니다. 단순 참고가 아닌 강제 적용 사항입니다.',
  ];

  if (lossPatterns.length > 0) {
    lines.push('\n### 🚫 손실 패턴 — 다음 상황에서는 매수를 AVOID하거나 즉시 SELL하세요:');
    for (const insight of lossPatterns) {
      const confidence = (insight.confidence * 100).toFixed(0);
      const mandatory = insight.confidence >= 0.75 ? '【필수】' : '【권장】';
      lines.push(`  ${mandatory} ${insight.insight} (신뢰도 ${confidence}%, 근거 ${insight.sample_count}건)`);
    }
  }

  if (winPatterns.length > 0) {
    lines.push('\n### ✅ 수익 패턴 — 다음 조건이 충족되면 BUY를 적극 검토하세요:');
    for (const insight of winPatterns) {
      const confidence = (insight.confidence * 100).toFixed(0);
      const mandatory = insight.confidence >= 0.8 ? '【높은 신뢰도 — PRIORITIZE】' : '【참고】';
      lines.push(`  ${mandatory} ${insight.insight} (신뢰도 ${confidence}%, 근거 ${insight.sample_count}건)`);
    }
  }

  if (timingInsights.length > 0) {
    lines.push('\n### ⏱️ 타이밍 인사이트:');
    for (const insight of timingInsights) {
      lines.push(`  - ${insight.insight} (신뢰도 ${(insight.confidence * 100).toFixed(0)}%, 근거 ${insight.sample_count}건)`);
    }
  }

  if (sizingInsights.length > 0) {
    lines.push('\n### 📊 투자 규모 인사이트:');
    for (const insight of sizingInsights) {
      lines.push(`  - ${insight.insight} (신뢰도 ${(insight.confidence * 100).toFixed(0)}%, 근거 ${insight.sample_count}건)`);
    }
  }

  // 종목별 실거래 승률 요약 (고승률 종목 우선 진입 지시)
  const { rows: stockAccRows } = await getPool().query(
    `SELECT stock_code,
            COUNT(*)::int AS total,
            SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::int AS wins,
            ROUND(AVG(realized_pnl_pct)::numeric,2) AS avg_pnl
       FROM score_accuracy
      WHERE recorded_at >= NOW() - INTERVAL '90 days'
        AND is_paper = false
      GROUP BY stock_code
      HAVING COUNT(*) >= 3
      ORDER BY (SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::float / COUNT(*)) DESC
      LIMIT 10`,
  ).catch(() => ({ rows: [] }));

  if (stockAccRows.length > 0) {
    const highWinStocks = stockAccRows.filter((r: any) => (r.wins / r.total) >= 0.65);
    const lowWinStocks  = stockAccRows.filter((r: any) => (r.wins / r.total) <= 0.35);

    if (highWinStocks.length > 0) {
      lines.push('\n### 🏆 실거래 검증 고승률 종목 — 매수 신호 시 즉시 우선 진입 (포지션 30% 이상 확대):');
      for (const r of highWinStocks) {
        const winPct = Math.round((r.wins / r.total) * 100);
        lines.push(`  • ${r.stock_code}: 승률 ${winPct}% (${r.wins}/${r.total}건, 평균수익 ${r.avg_pnl > 0 ? '+' : ''}${r.avg_pnl}%) → 기준점수 15점 낮춰서 진입, 포지션 최대치`);
      }
    }
    if (lowWinStocks.length > 0) {
      lines.push('\n### ⚠️ 저승률 종목 — 매수 신호 와도 기준점수 +15점 이상 요구:');
      for (const r of lowWinStocks) {
        const winPct = Math.round((r.wins / r.total) * 100);
        lines.push(`  • ${r.stock_code}: 승률 ${winPct}% (${r.wins}/${r.total}건) → 매우 높은 확신 없으면 진입 SKIP`);
      }
    }
  }

  lines.push('\n> 위 인사이트는 과거 실거래 결과로 도출된 통계적 패턴입니다. 단순 스코어보다 이 인사이트를 우선 적용하세요.');

  return lines.join('\n');
}

/**
 * 고신뢰도 인사이트를 strategy_config에 자동 반영
 * - confidence >= 0.8 + paramChange 있는 인사이트만 자동 적용
 * - analyzeTradeHistory() 직후 호출
 */
export async function autoApplyInsights(insights: LearnedInsight[]): Promise<void> {
  const toApply = insights.filter((i) => i.confidence >= 0.8 && i.paramChange && !i.isApplied);
  if (toApply.length === 0) return;

  try {
    // 현재 활성 전략 조회
    const { rows } = await getPool().query(`SELECT * FROM strategy_config WHERE is_active = true ORDER BY updated_at DESC LIMIT 1`);
    const current = rows[0];
    if (!current) return;

    // 가장 신뢰도 높은 변경사항 우선 적용 (mode 변경은 최우선)
    const sorted = toApply.sort((a, b) => {
      if (a.paramChange?.field === 'mode') return -1;
      if (b.paramChange?.field === 'mode') return 1;
      return b.confidence - a.confidence;
    });

    const ALLOWED_PARAM_FIELDS = ['stop_loss_pct', 'take_profit_pct', 'buy_threshold', 'mode'] as const;
    const applied: string[] = [];
    for (const insight of sorted.slice(0, 3)) { // 한 번에 최대 3개 적용
      const { field, value } = insight.paramChange!;
      if (!(ALLOWED_PARAM_FIELDS as readonly string[]).includes(field)) {
        logger.warn(`🚫 허용되지 않은 필드 업데이트 차단: ${field}`, { component: 'LEARN' });
        continue;
      }
      const oldVal = current[field];
      if (oldVal === value) continue; // 이미 같은 값이면 스킵

      await getPool().query(`UPDATE strategy_config SET ${field} = $1 WHERE is_active = true`, [value]);
      await getPool().query(`UPDATE learned_insights SET is_applied = true, applied_at = NOW() WHERE id = $1`, [insight.id]);
      applied.push(`${field}: ${oldVal} → ${value}`);
      logger.info(`🤖 인사이트 자동 적용: ${field}=${value} (${insight.insight.slice(0, 40)}...)`, { component: 'LEARN' });
    }

    if (applied.length > 0) {
      await logSystem('INFO', 'LEARN', `인사이트 자동 전략 적용: ${applied.join(', ')}`).catch(() => {});
      await sendTelegramMessage(
        `🤖 *자기학습 자동 전략 적용*\n${applied.map((a) => `• ${a}`).join('\n')}`,
      ).catch(() => {});
    }
  } catch (err) {
    logger.warn(`인사이트 자동 적용 실패: ${err}`, { component: 'LEARN' });
  }
}

/**
 * 특정 인사이트를 수동으로 전략에 적용 (대시보드 버튼)
 */
export async function applyInsightById(insightId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { rows } = await getPool().query(`SELECT * FROM learned_insights WHERE id = $1`, [insightId]);
    const insight = rows[0];
    if (!insight) return { ok: false, message: '인사이트를 찾을 수 없음' };
    if (!insight.param_change) return { ok: false, message: '자동 적용 가능한 파라미터 변경 없음' };
    if (insight.is_applied) return { ok: false, message: '이미 적용됨' };

    const { field, value } = insight.param_change as InsightParamChange;
    const ALLOWED_PARAM_FIELDS = ['stop_loss_pct', 'take_profit_pct', 'buy_threshold', 'mode'];
    if (!ALLOWED_PARAM_FIELDS.includes(field)) return { ok: false, message: `허용되지 않은 필드: ${field}` };

    const { rows: stratRows } = await getPool().query(`SELECT * FROM strategy_config WHERE is_active = true LIMIT 1`);
    const current = stratRows[0];
    if (!current) return { ok: false, message: '활성 전략 없음' };

    await getPool().query(`UPDATE strategy_config SET ${field} = $1 WHERE is_active = true`, [value]);
    await getPool().query(`UPDATE learned_insights SET is_applied = true, applied_at = NOW() WHERE id = $1`, [insightId]);

    const message = `${field}: ${current[field]} → ${value}`;
    await logSystem('INFO', 'LEARN', `인사이트 수동 적용: ${message}`).catch(() => {});
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: `적용 실패: ${err}` };
  }
}

/**
 * 대시보드용 인사이트 목록 (recommendation + paramChange 포함)
 */
export async function getInsightsForDashboard(): Promise<LearnedInsight[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM learned_insights ORDER BY confidence DESC, sample_count DESC LIMIT 20`,
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    insight: r.insight,
    confidence: Number(r.confidence),
    sampleCount: r.sample_count,
    lastUpdated: r.last_updated,
    details: r.details,
    recommendation: r.recommendation,
    paramChange: r.param_change as InsightParamChange | undefined,
    isApplied: r.is_applied,
  }));
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

/**
 * 시간대별 성과 분석 — 어느 시간대에 진입한 매매가 수익이 좋았는지
 */
function analyzeTimeOfDayPerformance(
  enrichedChains: { chain: any; pnlPct: number; holdingDays: number; entryType: string; sniperType: string | null; initialConfidence: number | null }[],
): LearnedInsight[] {
  const insights: LearnedInsight[] = [];
  const now = new Date().toISOString();

  type HourBucket = { wins: number; total: number; pnlSum: number };
  const buckets: Record<number, HourBucket> = {};

  for (const { chain, pnlPct } of enrichedChains) {
    if (!chain.created_at) continue;
    const hour = new Date(chain.created_at).getHours();
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
      lastUpdated: now,
    });
  }

  if (worst.avgPnl < -0.3 && worst.total >= 3) {
    insights.push({
      category: 'TIMING',
      insight: `${worst.hour}시 진입 매매 평균 ${worst.avgPnl.toFixed(1)}% 손실 (${worst.total}건). 이 시간대 신규 진입 주의.`,
      recommendation: `${worst.hour}시 대 진입 시 매수 임계치를 5점 높이거나 진입 보류.`,
      confidence: Math.min(0.85, 0.5 + worst.total * 0.05),
      sampleCount: worst.total,
      lastUpdated: now,
    });
  }

  return insights;
}

/**
 * 요일별 성과 분석 — 월~금 중 어느 요일이 수익이 좋았는지
 */
function analyzeDayOfWeekPerformance(
  enrichedChains: { chain: any; pnlPct: number; holdingDays: number; entryType: string; sniperType: string | null; initialConfidence: number | null }[],
): LearnedInsight[] {
  const insights: LearnedInsight[] = [];
  const now = new Date().toISOString();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  type DayBucket = { wins: number; total: number; pnlSum: number };
  const buckets: Record<number, DayBucket> = {};

  for (const { chain, pnlPct } of enrichedChains) {
    if (!chain.created_at) continue;
    const day = new Date(chain.created_at).getDay();
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
      lastUpdated: now,
    });
  }

  if (worst.avgPnl < -0.2 && days.length > 2) {
    insights.push({
      category: 'TIMING',
      insight: `${dayNames[worst.day]}요일 진입 평균 ${worst.avgPnl.toFixed(1)}% 손실 (${worst.total}건). 해당 요일 신규 진입 시 더 높은 점수 요구.`,
      recommendation: `${dayNames[worst.day]}요일 매수 임계치 +5점 상향 검토.`,
      confidence: Math.min(0.8, 0.45 + worst.total * 0.04),
      sampleCount: worst.total,
      lastUpdated: now,
    });
  }

  return insights;
}

/**
 * 파킹 결정 학습 — 머니마켓 ETF(333940) 파킹 기간 수익률 vs 워치리스트 주식 수익률 비교
 * 파킹이 좋은 결정이었는지(시장 하락 구간) 나쁜 결정이었는지(기회 손실) 패턴 추출
 */
async function analyzeParkingDecisions(): Promise<LearnedInsight[]> {
  const IDLE_PARK_CODE = '333940';
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // 완료된 파킹 체인 조회
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

    // 파킹 수익률 계산
    const parkReturns = parkChains.map((c: any) => {
      const pnlPct = Number(c.total_invested) > 0
        ? (Number(c.realized_pnl) / Number(c.total_invested)) * 100
        : 0;
      const holdDays = (new Date(c.closed_at).getTime() - new Date(c.opened_at).getTime()) / (1000 * 60 * 60 * 24);
      return { pnlPct, holdDays, openedAt: c.opened_at, closedAt: c.closed_at };
    });

    // 파킹 해제 직후 시장이 올랐는지 — 파킹 기간 중 워치리스트 종목 수익률 비교
    const { rows: watchlistRows } = await getPool().query(
      `SELECT DISTINCT stock_code FROM watchlist WHERE is_active = true LIMIT 10`,
    );

    const insights: LearnedInsight[] = [];

    // 파킹 체인 평균 수익률 (MMF ETF 연이율 환산)
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
          lastUpdated: now,
        });
      }

      // 파킹 평균 기간이 3일 초과 — 파킹이 너무 길면 기회 손실 경고
      if (avgHoldDays > 3 && watchlistRows.length > 0) {
        insights.push({
          category: 'TIMING',
          insight: `파킹 평균 보유 기간이 ${avgHoldDays.toFixed(1)}일로 길어지고 있음. 매수 기회 포착이 지연되고 있는지 확인 필요. AI 스코어 임계값을 점검하세요.`,
          recommendation: `buy_threshold를 낮춰 매수 기회를 늘리거나, 기술 폴백 임계값 재검토.`,
          confidence: 0.65,
          sampleCount: parkChains.length,
          lastUpdated: now,
        });
      }
    }

    return insights;
  } catch (err) {
    logger.warn(`파킹 분석 실패: ${err}`, { component: 'LEARN' });
    return [];
  }
}

/**
 * 종목별 실거래 정확도 요약 — Track A 스코어링 프롬프트에 주입
 * score_accuracy 테이블 기반, 최근 90일 / 최소 3건 이상인 종목만
 */
export async function getStockAccuracyContext(stockCodes: string[]): Promise<string> {
  if (stockCodes.length === 0) return '';
  try {
    const { rows } = await getPool().query(
      `SELECT
         stock_code,
         COUNT(*)::int                                      AS total,
         SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::int AS wins,
         ROUND(AVG(realized_pnl_pct)::numeric, 2)          AS avg_pnl_pct,
         ROUND(AVG(CASE WHEN outcome='WIN' THEN realized_pnl_pct END)::numeric, 2) AS avg_win_pct,
         ROUND(AVG(CASE WHEN outcome='LOSS' THEN realized_pnl_pct END)::numeric, 2) AS avg_loss_pct,
         ROUND(AVG(entry_score)::numeric, 0)                AS avg_entry_score
       FROM score_accuracy
      WHERE stock_code = ANY($1)
        AND recorded_at >= NOW() - INTERVAL '90 days'
        AND is_paper = false
      GROUP BY stock_code
      HAVING COUNT(*) >= 3
      ORDER BY stock_code`,
      [stockCodes],
    );

    if (rows.length === 0) return '';

    const lines = ['\n## 📊 종목별 실거래 정확도 (최근 90일)'];
    for (const r of rows) {
      const winRate = Math.round((r.wins / r.total) * 100);
      const bias = winRate >= 60
        ? `✅ 승률 높음 — 신호 강하면 적극 매수`
        : winRate <= 35
          ? `⚠️ 승률 낮음 — 더 높은 스코어(+10) 요구`
          : `→ 보통`;
      lines.push(
        `  ${r.stock_code}: 승률 ${winRate}%(${r.wins}/${r.total}건) | 평균손익 ${r.avg_pnl_pct > 0 ? '+' : ''}${r.avg_pnl_pct}% | 진입스코어평균 ${r.avg_entry_score}점 ${bias}`,
      );
    }
    lines.push('> 위 승률이 낮은 종목은 composite_score를 10점 더 엄격하게 적용하세요.');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * buy_threshold 자동 최적화 — score_accuracy 실거래 데이터로 최적 임계값 계산
 * 임계값 이하 종목 승률 < 38% → 상향 / >= 52% → 하향 제안 → autoApplyInsights가 전략에 반영
 */
async function analyzeBuyThreshold(): Promise<LearnedInsight[]> {
  try {
    const { rows: cfgRows } = await getPool().query(
      `SELECT buy_threshold FROM strategy_config WHERE is_active = true LIMIT 1`,
    );
    const currentThreshold: number = cfgRows[0]?.buy_threshold ?? 58;

    const { rows } = await getPool().query(
      `SELECT entry_score, outcome, realized_pnl_pct
         FROM score_accuracy
        WHERE recorded_at >= NOW() - INTERVAL '90 days'
          AND entry_score IS NOT NULL
          AND is_paper = false
        ORDER BY entry_score`,
    );

    if (rows.length < 15) return [];

    const below = rows.filter((r: any) => Number(r.entry_score) < currentThreshold);
    const above = rows.filter((r: any) => Number(r.entry_score) >= currentThreshold);

    if (below.length < 5 || above.length < 5) return [];

    const belowWinRate = below.filter((r: any) => r.outcome === 'WIN').length / below.length;
    const aboveWinRate = above.filter((r: any) => r.outcome === 'WIN').length / above.length;
    const belowAvgPnl = below.reduce((s: number, r: any) => s + Number(r.realized_pnl_pct), 0) / below.length;

    const totalSamples = rows.length;
    // 샘플 10건 → confidence 0.70 (autoApply 최소치), 20건 → 0.75, 30건+ → 0.80
    const confidence = Math.min(0.85, 0.55 + totalSamples * 0.015);
    const insights: LearnedInsight[] = [];

    // 임계값 이하 승률 낮고 손실 → 상향 권장
    if (belowWinRate < 0.38 && belowAvgPnl < 0 && aboveWinRate > belowWinRate + 0.10) {
      // 3점 단위로 최적 threshold 탐색 (현재+3 ~ +12)
      let bestThreshold = currentThreshold + 5;
      let bestAboveWinRate = 0;
      for (let t = currentThreshold + 3; t <= Math.min(80, currentThreshold + 12); t += 3) {
        const atOrAbove = rows.filter((r: any) => Number(r.entry_score) >= t);
        if (atOrAbove.length < 5) break;
        const wr = atOrAbove.filter((r: any) => r.outcome === 'WIN').length / atOrAbove.length;
        if (wr > bestAboveWinRate) { bestAboveWinRate = wr; bestThreshold = t; }
      }

      insights.push({
        category: 'WIN_PATTERN',
        insight: `매수 임계값 자동최적화: ${currentThreshold}점 미만 실거래 승률 ${(belowWinRate * 100).toFixed(0)}% (${below.length}건, 평균손익 ${belowAvgPnl.toFixed(1)}%). 임계값 ${bestThreshold}점으로 상향하면 진입 품질 개선.`,
        recommendation: `buy_threshold: ${currentThreshold} → ${bestThreshold} (실거래 ${totalSamples}건 분석)`,
        paramChange: { field: 'buy_threshold', value: bestThreshold, reason: `임계값 이하 승률 ${(belowWinRate * 100).toFixed(0)}% 개선 목적` },
        confidence,
        sampleCount: totalSamples,
        lastUpdated: now,
      });
    }

    // 임계값 이하에서도 수익성 있음 → 하향 가능 (더 많은 기회 포착)
    if (belowWinRate >= 0.52 && belowAvgPnl > 0 && currentThreshold > 55 && below.length >= 8) {
      const suggestedThreshold = Math.max(53, currentThreshold - 5);
      insights.push({
        category: 'WIN_PATTERN',
        insight: `매수 임계값 자동최적화: ${currentThreshold}점 미만에서도 승률 ${(belowWinRate * 100).toFixed(0)}% (${below.length}건, 평균손익 ${belowAvgPnl.toFixed(1)}%). 임계값 ${suggestedThreshold}점 하향으로 기회 확대 가능.`,
        recommendation: `buy_threshold: ${currentThreshold} → ${suggestedThreshold}`,
        paramChange: { field: 'buy_threshold', value: suggestedThreshold, reason: `임계값 이하도 수익 확인 → 기회 확대` },
        confidence: confidence * 0.85, // 하향은 더 보수적
        sampleCount: totalSamples,
        lastUpdated: now,
      });
    }

    if (insights.length > 0) {
      logger.info(
        `🎯 buy_threshold 분석: 현재 ${currentThreshold}점 | 이하승률 ${(belowWinRate * 100).toFixed(0)}%(${below.length}건) | 이상승률 ${(aboveWinRate * 100).toFixed(0)}%(${above.length}건) → ${insights.length}건 권장`,
        { component: 'LEARN' },
      );
    }

    return insights;
  } catch (err) {
    logger.warn(`buy_threshold 분석 실패: ${err}`, { component: 'LEARN' });
    return [];
  }
}

/**
 * 점수 티어별 실거래 역산 파라미터 보정 (자기학습 피드백)
 * 최근 120일 score_accuracy 테이블 데이터로 Kelly Criterion 기반 최적 비율 계산
 */
async function calibrateScoreTierParams(): Promise<void> {
  try {
    // 1. score_accuracy에서 entry_score가 있는 레코드 조회 (최근 120일)
    const { rows: accuracyData } = await getPool().query(
      `SELECT entry_score, outcome, realized_pnl_pct
       FROM score_accuracy
       WHERE recorded_at >= NOW() - INTERVAL '120 days'
         AND entry_score IS NOT NULL
         AND is_paper = false
       ORDER BY recorded_at DESC`,
    );

    if (accuracyData.length < 30) {
      logger.info('점수 티어 보정: 데이터 부족 (최소 30건 필요)', { component: 'LEARN' });
      return;
    }

    // 2. 점수를 티어로 분류하고 통계 계산
    const tiers = [
      { min: 60, max: 69 },
      { min: 70, max: 79 },
      { min: 80, max: 89 },
      { min: 90, max: 100 },
    ];

    interface TierStats {
      data: Array<{ outcome: string; realized_pnl_pct: number }>;
      winRate: number;
      avgPnl: number;
      avgWin: number;
      avgLoss: number;
      stdev: number;
    }

    const tierStats: Record<string, TierStats> = {};

    for (const tier of tiers) {
      const tierKey = `${tier.min}-${tier.max}`;
      const tierData = accuracyData.filter(
        (d) => d.entry_score >= tier.min && d.entry_score <= tier.max,
      );

      if (tierData.length < 5) {
        tierStats[tierKey] = { data: [], winRate: 0, avgPnl: 0, avgWin: 0, avgLoss: 0, stdev: 0 };
        continue;
      }

      const wins = tierData.filter((d) => d.outcome === 'WIN');
      const losses = tierData.filter((d) => d.outcome === 'LOSS');

      const winRate = wins.length / tierData.length;
      const avgPnl = tierData.reduce((s, d) => s + d.realized_pnl_pct, 0) / tierData.length;
      const avgWin = wins.length > 0
        ? wins.reduce((s, d) => s + d.realized_pnl_pct, 0) / wins.length
        : 0;
      const avgLoss = losses.length > 0
        ? losses.reduce((s, d) => s + d.realized_pnl_pct, 0) / losses.length
        : 0;

      // 표준편차 계산
      const variance = tierData.reduce((s, d) => s + Math.pow(d.realized_pnl_pct - avgPnl, 2), 0) / tierData.length;
      const stdev = Math.sqrt(variance);

      tierStats[tierKey] = { data: tierData, winRate, avgPnl, avgWin, avgLoss, stdev };
    }

    // 3. Kelly Criterion 기반 최적 비율 계산
    const updates: Array<{ tier_min: number; tier_max: number; alloc_pct: number; win_rate: number; avg_pnl_pct: number; sample_count: number }> = [];

    for (const tier of tiers) {
      const tierKey = `${tier.min}-${tier.max}`;
      const stats = tierStats[tierKey];

      if (stats.data.length < 5) continue;

      const { winRate, avgWin, avgLoss } = stats;

      // Kelly Criterion 공식: kelly = winRate - (1 - winRate) / (avgWin / |avgLoss|)
      let kelly = 0;
      if (avgLoss !== 0) {
        const ratio = avgWin / Math.abs(avgLoss);
        kelly = winRate - (1 - winRate) / ratio;
      }

      // Kelly이 음수면 최소값, Half-Kelly 보수화 (30% 적용), 상한 0.22
      if (kelly < 0) kelly = 0.04;
      else kelly = Math.min(kelly * 0.3, 0.22);

      // 샘플이 10건 미만이면 현재 DB값과 50:50 블렌딩
      let allocPct = kelly;
      if (stats.data.length < 10) {
        const { rows: currentRows } = await getPool().query(
          `SELECT alloc_pct FROM score_tier_params WHERE tier_min = $1 AND tier_max = $2`,
          [tier.min, tier.max],
        ).catch(() => ({ rows: [] }));

        if (currentRows.length > 0) {
          const currentAlloc = Number(currentRows[0].alloc_pct);
          allocPct = (kelly + currentAlloc) / 2;
        }
      }

      updates.push({
        tier_min: tier.min,
        tier_max: tier.max,
        alloc_pct: allocPct,
        win_rate: winRate,
        avg_pnl_pct: stats.avgPnl,
        sample_count: stats.data.length,
      });
    }

    // 4. DB upsert
    for (const update of updates) {
      await getPool().query(
        `INSERT INTO score_tier_params (tier_min, tier_max, alloc_pct, win_rate, avg_pnl_pct, sample_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (tier_min, tier_max)
         DO UPDATE SET alloc_pct=$3, win_rate=$4, avg_pnl_pct=$5, sample_count=$6, updated_at=NOW()`,
        [update.tier_min, update.tier_max, update.alloc_pct, update.win_rate, update.avg_pnl_pct, update.sample_count],
      );
    }

    // 5. 로깅
    const summary = updates.map((u) => `[${u.tier_min}-${u.tier_max}: ${(u.alloc_pct * 100).toFixed(1)}%, 승률 ${(u.win_rate * 100).toFixed(0)}%, n=${u.sample_count}]`).join(' ');
    logger.info(`점수 티어 파라미터 갱신: ${summary}`, { component: 'LEARN' });
    await logSystem('INFO', 'LEARN', `점수 티어 보정: ${summary}`).catch(() => {});
  } catch (err) {
    logger.warn(`점수 티어 보정 실패: ${err}`, { component: 'LEARN' });
  }
}

/**
 * 자기학습 분석 실행 + 인사이트 저장 + auto-apply (매일 18:30 호출)
 */
export async function runDailyLearning(): Promise<void> {
  try {
    const insights = await analyzeTradeHistory();
    if (insights.length === 0) {
      logger.info('자기학습: 분석 결과 없음', { component: 'LEARN' });
      return;
    }
    // DB upsert
    for (const ins of insights) {
      await getPool().query(
        `INSERT INTO learned_insights (category, insight, confidence, sample_count, details, recommendation, param_change, last_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (category, insight)
         DO UPDATE SET confidence=$3, sample_count=$4, details=$5, recommendation=$6, param_change=$7, last_updated=NOW()`,
        [
          ins.category, ins.insight, ins.confidence, ins.sampleCount,
          ins.details ? JSON.stringify(ins.details) : null,
          ins.recommendation ?? null,
          ins.paramChange ? JSON.stringify(ins.paramChange) : null,
        ],
      ).catch(() => {});
    }
    logger.info(`🧠 자기학습 인사이트 ${insights.length}건 저장`, { component: 'LEARN' });
    await autoApplyInsights(insights);
    await calibrateScoreTierParams().catch((e) => logger.warn(`티어 파라미터 보정 실패: ${e}`, { component: 'LEARN' }));
  } catch (err) {
    logger.warn(`자기학습 실패: ${err}`, { component: 'LEARN' });
  }
}
