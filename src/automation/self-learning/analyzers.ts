import type { EnrichedChain, LearnedInsight } from './index.js';

const now = new Date().toISOString();

export function analyzeAveraging(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
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

export function analyzeHoldingPeriod(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
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
  if (avgLossHold > avgWinHold * 1.5 && avgLossHold > 3) {
    const avgLossPct = Math.abs(losses.reduce((s, c) => s + c.pnlPct, 0) / losses.length);
    const suggestedSl = -(avgLossPct * 0.7);
    insights.push({
      category: 'LOSS_PATTERN',
      insight: `손실 매매는 평균 ${avgLossHold.toFixed(1)}일로 수익(${avgWinHold.toFixed(1)}일) 대비 오래 보유. 손절을 더 빨리 할 것.`,
      recommendation: `손절 기준을 ${suggestedSl.toFixed(1)}%로 타이트하게 조정 (평균 손실 -${avgLossPct.toFixed(1)}%의 70% 수준).`,
      paramChange: {
        field: 'stop_loss_pct',
        value: Math.round(suggestedSl * 10) / 10,
        reason: `손실 보유기간 ${avgLossHold.toFixed(1)}일 > 수익 ${avgWinHold.toFixed(1)}일×1.5 — SL 타이트닝`,
      },
      confidence: 0.8,
      sampleCount: losses.length,
      lastUpdated: now,
    });
  } else if (avgLossHold > avgWinHold * 1.5 && avgLossHold > 0) {
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

export function analyzeModePerformance(enrichedChains: EnrichedChain[]): LearnedInsight[] {
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

  let bestMode = '';
  let bestWinRate = 0;
  for (const [mode, stats] of modeResults) {
    const total = stats.wins + stats.losses;
    if (total >= 5) {
      const winRate = stats.wins / total;
      if (winRate > bestWinRate) {
        bestWinRate = winRate;
        bestMode = mode;
      }
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

      if (isBad && bestMode && bestMode !== mode) {
        insight.recommendation = `${mode} 모드 승률 ${winRatePct}%로 부진. ${bestMode} 모드(승률 ${(bestWinRate * 100).toFixed(0)}%)로 전환하면 성과 개선 가능.`;
        insight.paramChange = {
          field: 'mode',
          value: bestMode,
          reason: `${mode} 승률 ${winRatePct}% → ${bestMode} 우위`,
        };
      } else if (isBest && winRate >= 0.65) {
        insight.recommendation = `${mode} 모드가 현재 가장 효과적. 계속 유지 권장.`;
      }

      insights.push(insight);
    }
  }
  return insights;
}

export function analyzeStockPerformance(enrichedChains: EnrichedChain[]): LearnedInsight[] {
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

export function analyzeStockWinRateAcceleration(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  const stockTrades = new Map<string, { pnlPct: number; date: string }[]>();
  for (const { chain, pnlPct } of enrichedChains) {
    const code = chain.stock_code;
    const list = stockTrades.get(code) ?? [];
    const rawDate = chain.closed_at ?? chain.opened_at;
    list.push({ pnlPct, date: rawDate instanceof Date ? rawDate.toISOString() : String(rawDate ?? '') });
    stockTrades.set(code, list);
  }

  const insights: LearnedInsight[] = [];

  for (const [code, trades] of stockTrades) {
    if (trades.length < 4) continue;

    const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
    const half = Math.floor(sorted.length / 2);
    const older = sorted.slice(0, half);
    const newer = sorted.slice(half);

    const olderWinRate = older.filter((t) => t.pnlPct > 0).length / older.length;
    const newerWinRate = newer.filter((t) => t.pnlPct > 0).length / newer.length;
    const olderAvgPnl = older.reduce((s, t) => s + t.pnlPct, 0) / older.length;
    const newerAvgPnl = newer.reduce((s, t) => s + t.pnlPct, 0) / newer.length;

    if (newerWinRate > olderWinRate + 0.25 && newerAvgPnl > 0) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `종목 '${code}' 최근 승률 가속: 이전 ${(olderWinRate * 100).toFixed(0)}% → 최근 ${(newerWinRate * 100).toFixed(0)}% (${trades.length}건). 전략 적합성 향상 중 — 신호 시 우선 진입.`,
        confidence: Math.min(0.9, 0.65 + trades.length * 0.03),
        sampleCount: trades.length,
        lastUpdated: now,
        details: { code, olderWinRate, newerWinRate, olderAvgPnl, newerAvgPnl },
      });
    }

    if (newerWinRate < olderWinRate - 0.3 && newerAvgPnl < 0 && trades.length >= 5) {
      insights.push({
        category: 'LOSS_PATTERN',
        insight: `종목 '${code}' 최근 성과 악화: 이전 승률 ${(olderWinRate * 100).toFixed(0)}% → 최근 ${(newerWinRate * 100).toFixed(0)}% (${trades.length}건). 진입 기준 강화 또는 워치리스트 제거 검토.`,
        confidence: Math.min(0.85, 0.6 + trades.length * 0.03),
        sampleCount: trades.length,
        lastUpdated: now,
        recommendation: `${code} 매수 기준 +10점 상향, 지속 부진 시 워치리스트 제거.`,
      });
    }
  }

  return insights;
}

export function analyzeWinRateTrend(chains: any[]): LearnedInsight[] {
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
      // 승률 하락 시 buy_threshold 상향하여 진입 품질 개선
      const currentThreshold = typeof (chains[0] as any)?.buy_threshold === 'number'
        ? (chains[0] as any).buy_threshold
        : 60;
      return [
        {
          category: 'LOSS_PATTERN',
          insight: `최근 승률이 하락 중 (${(recentWinRate * 100).toFixed(0)}% vs 이전 ${(olderWinRate * 100).toFixed(0)}%). 포지션 축소 또는 전략 조정 필요.`,
          recommendation: `buy_threshold를 ${currentThreshold + 5}점으로 상향하여 진입 기준 강화.`,
          paramChange: {
            field: 'buy_threshold',
            value: currentThreshold + 5,
            reason: `승률 하락 ${(olderWinRate * 100).toFixed(0)}%→${(recentWinRate * 100).toFixed(0)}% — 진입 기준 강화`,
          },
          confidence: 0.8,
          sampleCount: 20,
          lastUpdated: now,
        },
      ];
    }
  }
  return [];
}

export function analyzeSniperPerformance(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
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

export function analyzeConfidenceCorrelation(enrichedChains: EnrichedChain[]): LearnedInsight[] {
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

export function analyzeHoldingPeriodByEntry(wins: EnrichedChain[]): LearnedInsight[] {
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

export function analyzeSniperByMarketRegime(enrichedChains: EnrichedChain[]): LearnedInsight[] {
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
    if (typeStats.size < 2) continue;

    let bestPerformer = { type: '', winRate: 0, total: 0 };

    for (const [type, stats] of typeStats.entries()) {
      const total = stats.wins + stats.losses;
      if (total < 5) continue;

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

export function analyzeLossStreakRisk(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  if (enrichedChains.length < 5) return [];

  const recent5 = enrichedChains.slice(0, 5);
  const lossCount = recent5.filter((c) => Number(c.chain.realized_pnl) <= 0).length;

  if (lossCount >= 3) {
    return [
      {
        category: 'LOSS_PATTERN',
        insight: `최근 5건 중 ${lossCount}건 손실 — 연속 손실 구간. 현재 시장 환경이 전략과 맞지 않음. 신규 매수를 최소화하고 기존 포지션 리스크 관리를 강화하세요.`,
        recommendation: `buy_threshold를 +5점 상향하여 연속 손실 구간 방어.`,
        paramChange: {
          field: 'buy_threshold',
          value: 70, // 연속 손실 시 보수적 기본값
          reason: `최근 5건 중 ${lossCount}건 손실 — 진입 기준 강화`,
        },
        confidence: 0.85,
        sampleCount: 5,
        lastUpdated: now,
      },
    ];
  }

  return [];
}

export function analyzeProfitRatio(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
  if (wins.length < 3 || losses.length < 3) return [];

  const avgWinPct = wins.reduce((s, c) => s + c.pnlPct, 0) / wins.length;
  const avgLossPct = Math.abs(losses.reduce((s, c) => s + c.pnlPct, 0) / losses.length);
  const ratio = avgWinPct / avgLossPct;

  const insights: LearnedInsight[] = [];

  if (ratio < 1.0) {
    const suggestedStopLoss = -(Math.abs(avgLossPct) * 0.7).toFixed(1);
    insights.push({
      category: 'LOSS_PATTERN',
      insight: `손익비 ${ratio.toFixed(2)} (평균 수익 +${avgWinPct.toFixed(1)}% vs 평균 손실 -${avgLossPct.toFixed(1)}%). 손절 지연이 손익비를 악화시키고 있음.`,
      recommendation: `손절 기준을 ${suggestedStopLoss}%로 타이트하게 조정하면 손익비 개선 가능. 현재 평균 손실 -${avgLossPct.toFixed(1)}%의 70% 수준.`,
      paramChange: {
        field: 'stop_loss_pct',
        value: Number(suggestedStopLoss),
        reason: `손익비 ${ratio.toFixed(2)} 개선 필요`,
      },
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

  // ── 세이버메트릭스: R배수 + Profit Factor + 손익분기 승률 분석 ──
  insights.push(...analyzeSabermetrics(wins, losses, avgWinPct, avgLossPct, ratio));

  return insights;
}

/**
 * 세이버메트릭스(Sabermetrics) 기반 거래 품질 분석
 *
 * 야구의 세이버메트릭스를 매매에 적용:
 *   R배수(R-Multiple) = 실현손익 / 초기리스크 (타율이 아닌 장타율)
 *   Profit Factor = 총수익 / 총손실 (팀 득점/실점)
 *   손익분기 승률 = 1 / (1 + R:R) (최소 필요 승률)
 *   기대값(EV) = 승률×평균수익 - 패률×평균손실 (WAR)
 *   켈리 최적 비중 = (bp - q) / b (최적 배팅 비율)
 */
function analyzeSabermetrics(
  wins: EnrichedChain[],
  losses: EnrichedChain[],
  avgWinPct: number,
  avgLossPct: number,
  profitRatio: number,
): LearnedInsight[] {
  const insights: LearnedInsight[] = [];
  const total = wins.length + losses.length;
  if (total < 8) return insights;

  const winRate = wins.length / total;
  const lossRate = 1 - winRate;

  // ── 1. R배수(R-Multiple) 분포 분석 ──
  // R = 실현PnL / 초기리스크(SL%). SL을 모르면 평균손실을 R=1로 치환
  const riskUnit = avgLossPct > 0 ? avgLossPct : 3.0; // 1R = 평균 손실폭
  const winRMultiples = wins.map((c) => c.pnlPct / riskUnit);
  const lossRMultiples = losses.map((c) => c.pnlPct / riskUnit); // 음수
  const avgWinR = winRMultiples.reduce((s, r) => s + r, 0) / winRMultiples.length;
  const avgLossR = Math.abs(lossRMultiples.reduce((s, r) => s + r, 0) / lossRMultiples.length);
  const bigWins = winRMultiples.filter((r) => r >= 2.0); // 2R+ 대형 수익
  const bigWinPct = bigWins.length / total;

  // ── 2. Profit Factor = 총수익 / 총손실 ──
  const grossProfit = wins.reduce((s, c) => s + c.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, c) => s + c.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  // ── 3. 손익분기 승률 (Breakeven Win Rate) ──
  const breakevenWinRate = avgLossPct > 0 ? 1 / (1 + profitRatio) : 0.5;
  const winRateMargin = winRate - breakevenWinRate; // 양수=안전, 음수=위험

  // ── 4. 기대값(Expected Value) per trade ──
  const evPerTrade = winRate * avgWinPct - lossRate * avgLossPct;

  // ── 5. 켈리 최적 비중 ──
  const b = avgLossPct > 0 ? avgWinPct / avgLossPct : 1;
  const kellyFull = b > 0 ? (b * winRate - lossRate) / b : 0;
  const kellyHalf = Math.max(0, kellyFull * 0.5); // Half Kelly (안전)

  // ── 인사이트 생성 ──

  // [A] 종합 세이버메트릭스 리포트
  insights.push({
    category: 'SIZING',
    insight: `⚾ 세이버메트릭스 — 승률 ${(winRate * 100).toFixed(0)}% | R배수 ${avgWinR.toFixed(1)}R | PF ${profitFactor.toFixed(2)} | EV ${evPerTrade >= 0 ? '+' : ''}${evPerTrade.toFixed(2)}%/건 | 손익분기 ${(breakevenWinRate * 100).toFixed(0)}% | Kelly ${(kellyHalf * 100).toFixed(1)}%`,
    recommendation:
      evPerTrade > 0
        ? `양의 기대값 +${evPerTrade.toFixed(2)}% — 현재 전략 유지. 승률 마진 +${(winRateMargin * 100).toFixed(1)}%p 안전`
        : `음의 기대값 ${evPerTrade.toFixed(2)}% — SL 타이트닝 또는 TP 확대로 R배수 개선 필요`,
    confidence: Math.min(0.9, 0.6 + total * 0.01),
    sampleCount: total,
    lastUpdated: now,
    details: {
      winRate,
      avgWinPct,
      avgLossPct,
      profitRatio,
      avgWinR,
      avgLossR,
      profitFactor,
      breakevenWinRate,
      winRateMargin,
      evPerTrade,
      kellyFull,
      kellyHalf,
      bigWinPct,
      bigWinCount: bigWins.length,
      totalTrades: total,
    },
  });

  // [B] 승률 마진 경고/안전 판단
  if (winRateMargin < 0) {
    // 승률이 손익분기 이하 → 위험!
    const neededWinRate = breakevenWinRate + 0.05;
    const neededTP = avgLossPct * (neededWinRate / (1 - neededWinRate));
    insights.push({
      category: 'LOSS_PATTERN',
      insight: `⚠️ 승률(${(winRate * 100).toFixed(0)}%) < 손익분기(${(breakevenWinRate * 100).toFixed(0)}%) — R배수 ${profitRatio.toFixed(2)}에서 최소 ${(breakevenWinRate * 100).toFixed(0)}% 승률 필요.`,
      recommendation: `방법1: TP를 +${neededTP.toFixed(1)}%로 올려 R배수 개선. 방법2: 진입 기준 상향(스코어 +10)으로 승률 높이기.`,
      paramChange:
        evPerTrade < -0.5
          ? { field: 'buy_threshold', value: 85, reason: `EV ${evPerTrade.toFixed(2)}% 음수 — 엄격 필터링` }
          : undefined,
      confidence: 0.82,
      sampleCount: total,
      lastUpdated: now,
    });
  } else if (winRateMargin >= 0.15) {
    // 승률 마진 15%p 이상 → 여유 있음, 포지션 확대 가능
    insights.push({
      category: 'WIN_PATTERN',
      insight: `✅ 승률 마진 +${(winRateMargin * 100).toFixed(1)}%p 안전 (승률 ${(winRate * 100).toFixed(0)}% vs 분기 ${(breakevenWinRate * 100).toFixed(0)}%). Kelly ${(kellyHalf * 100).toFixed(1)}% 사이징 권장.`,
      recommendation: `포지션 비중을 현재 대비 ${kellyHalf > 0.15 ? '확대' : '유지'}. Half Kelly ${(kellyHalf * 100).toFixed(1)}% 기준.`,
      confidence: 0.78,
      sampleCount: total,
      lastUpdated: now,
    });
  }

  // [C] R배수 기반 TP/SL 최적화 제안
  if (avgWinR < 1.5 && profitFactor < 1.5) {
    // 평균 수익이 1.5R 미만 → TP가 너무 낮거나 조기 익절
    const targetTP = riskUnit * 2.0; // 목표 2R
    insights.push({
      category: 'SIZING',
      insight: `R배수 ${avgWinR.toFixed(1)}R 낮음 — 평균 수익이 리스크의 ${avgWinR.toFixed(1)}배. 목표 2.0R 이상 필요.`,
      recommendation: `TP를 +${targetTP.toFixed(1)}%로 상향. "승률 40%에도 수익" 구조로 전환.`,
      paramChange: {
        field: 'take_profit_pct',
        value: Math.round(targetTP * 10) / 10,
        reason: `R배수 ${avgWinR.toFixed(1)}→2.0R 목표`,
      },
      confidence: 0.75,
      sampleCount: total,
      lastUpdated: now,
    });
  }

  // [D] 대형 수익(2R+) 빈도 분석 — "장타율"
  if (bigWins.length >= 2) {
    const bigWinAvgR = bigWins.reduce((s, r) => s + r, 0) / bigWins.length;
    insights.push({
      category: 'WIN_PATTERN',
      insight: `⚾ 장타율: 2R+ 대형수익 ${bigWins.length}건(${(bigWinPct * 100).toFixed(0)}%). 평균 ${bigWinAvgR.toFixed(1)}R. 이들이 전체 수익의 핵심 — 대형 수익 시 홀딩 지속.`,
      recommendation: `2R+ 도달 시 부분익절만 하고 나머지는 ATR 트레일링으로 극대화. 조기 전량 매도 자제.`,
      confidence: 0.72,
      sampleCount: bigWins.length,
      lastUpdated: now,
    });
  }

  return insights;
}

export function analyzeQuickProfitTaking(wins: EnrichedChain[]): LearnedInsight[] {
  if (wins.length < 5) return [];

  const quickWins = wins.filter((c) => c.holdingDays <= 2 && c.pnlPct >= 1.5);
  const ratio = quickWins.length / wins.length;

  if (ratio >= 0.4 && quickWins.length >= 3) {
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

// ── 🔥 기회 발견 분석기: 긍정적 인사이트 + 자동 전략 확대 ──

/**
 * 최적 진입점 학습: 수익 매매의 진입 시점(시간대+요일) 패턴
 * → 해당 시간에 더 적극적으로 진입하라는 긍정적 지침
 */
export function analyzeOptimalEntryWindows(wins: EnrichedChain[]): LearnedInsight[] {
  if (wins.length < 5) return [];
  const insights: LearnedInsight[] = [];

  // 시간대별 승률 분석 (진입 시각 기준)
  const hourBuckets = new Map<string, { wins: number; total: number; totalPnl: number }>();
  for (const w of wins) {
    const openedAt = new Date(w.chain.opened_at);
    const hour = openedAt.getHours();
    let bucket: string;
    if (hour < 10) bucket = '09:00-10:00';
    else if (hour < 11) bucket = '10:00-11:00';
    else if (hour < 13) bucket = '11:00-13:00';
    else if (hour < 15) bucket = '13:00-15:00';
    else bucket = '15:00+';

    const stats = hourBuckets.get(bucket) ?? { wins: 0, total: 0, totalPnl: 0 };
    stats.wins++;
    stats.total++;
    stats.totalPnl += w.pnlPct;
    hourBuckets.set(bucket, stats);
  }

  // 평균 수익률이 가장 높은 시간대 찾기
  let bestBucket = '';
  let bestAvgPnl = 0;
  for (const [bucket, stats] of hourBuckets) {
    if (stats.total >= 3) {
      const avgPnl = stats.totalPnl / stats.total;
      if (avgPnl > bestAvgPnl) {
        bestAvgPnl = avgPnl;
        bestBucket = bucket;
      }
    }
  }

  if (bestBucket && bestAvgPnl > 1.0) {
    const stats = hourBuckets.get(bestBucket)!;
    insights.push({
      category: 'WIN_PATTERN',
      insight: `🕐 골든 진입 타임: ${bestBucket} 시간대 진입 시 평균 수익률 +${bestAvgPnl.toFixed(1)}% (${stats.total}건). 이 시간에 매수 신호가 오면 적극 진입!`,
      recommendation: `${bestBucket} 시간대 진입 시 포지션 사이즈 20% 확대 권장. 매수 임계점 -5점 완화.`,
      confidence: Math.min(0.85, 0.6 + stats.total * 0.03),
      sampleCount: stats.total,
      lastUpdated: now,
    });
  }

  return insights;
}

/**
 * 수익 가속 종목 발견: 최근 3건 연속 수익인 종목 → "지금 잘 맞는 종목" 강조
 */
export function analyzeHotStocks(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  const stockTrades = new Map<string, EnrichedChain[]>();
  for (const ec of enrichedChains) {
    const code = ec.chain.stock_code;
    const list = stockTrades.get(code) ?? [];
    list.push(ec);
    stockTrades.set(code, list);
  }

  const insights: LearnedInsight[] = [];

  for (const [code, trades] of stockTrades) {
    if (trades.length < 3) continue;

    // 최근 3건 확인
    const sorted = [...trades].sort((a, b) =>
      (b.chain.closed_at ?? b.chain.opened_at).localeCompare(a.chain.closed_at ?? a.chain.opened_at),
    );
    const recent3 = sorted.slice(0, 3);
    const allWins = recent3.every((t) => Number(t.chain.realized_pnl) > 0);

    if (allWins) {
      const avgPnl = recent3.reduce((s, t) => s + t.pnlPct, 0) / 3;
      const totalWinRate = trades.filter((t) => Number(t.chain.realized_pnl) > 0).length / trades.length;

      insights.push({
        category: 'WIN_PATTERN',
        insight: `🔥 핫 종목 '${code}': 최근 3건 연속 수익 (평균 +${avgPnl.toFixed(1)}%), 전체 승률 ${(totalWinRate * 100).toFixed(0)}%. 매수 신호 시 최우선 진입 + 포지션 확대!`,
        recommendation: `${code} 매수 임계점 -10점 낮춰서 적극 진입. 포지션 사이즈 1.3배 확대.`,
        confidence: Math.min(0.9, 0.7 + trades.length * 0.02),
        sampleCount: trades.length,
        lastUpdated: now,
      });
    }
  }

  return insights;
}

/**
 * 전략 강점 발견: 특정 전략이 최근 10건에서 승률 70%+ → 전략 확대 권장
 */
export function analyzeStrategyStrengths(enrichedChains: EnrichedChain[]): LearnedInsight[] {
  if (enrichedChains.length < 10) return [];
  const insights: LearnedInsight[] = [];

  const modeRecent = new Map<string, { wins: number; total: number; avgPnl: number }>();
  const recent20 = enrichedChains.slice(0, 20);

  for (const ec of recent20) {
    const mode = ec.chain.strategy_mode ?? 'SWING';
    const stats = modeRecent.get(mode) ?? { wins: 0, total: 0, avgPnl: 0 };
    stats.total++;
    if (Number(ec.chain.realized_pnl) > 0) stats.wins++;
    stats.avgPnl += ec.pnlPct;
    modeRecent.set(mode, stats);
  }

  for (const [mode, stats] of modeRecent) {
    if (stats.total < 3) continue;
    stats.avgPnl /= stats.total;
    const winRate = stats.wins / stats.total;

    if (winRate >= 0.7 && stats.avgPnl > 0) {
      insights.push({
        category: 'WIN_PATTERN',
        insight: `💪 ${mode} 전략 최근 호조: 승률 ${(winRate * 100).toFixed(0)}% (${stats.wins}/${stats.total}건), 평균 +${stats.avgPnl.toFixed(1)}%. 이 전략의 비중을 확대하세요!`,
        recommendation: `${mode} 전략 황금비율 가중치 +10% 확대 권장. 현재 시장에 잘 맞는 전략.`,
        confidence: Math.min(0.85, 0.65 + stats.total * 0.02),
        sampleCount: stats.total,
        lastUpdated: now,
      });
    }
  }

  return insights;
}

/**
 * 수익 극대화 지침: TP에 도달하기 전에 매도한 케이스 분석
 * → "너무 일찍 팔지 마라" 지침 생성
 */
export function analyzeEarlyExitMissedProfit(wins: EnrichedChain[], losses: EnrichedChain[]): LearnedInsight[] {
  // 수익 매매 중 +1% 미만에서 매도한 비율
  const smallWins = wins.filter((c) => c.pnlPct > 0 && c.pnlPct < 1.0);
  const bigWins = wins.filter((c) => c.pnlPct >= 3.0);

  if (wins.length < 5) return [];

  const insights: LearnedInsight[] = [];

  if (smallWins.length >= 3 && smallWins.length / wins.length >= 0.3) {
    const avgSmallPnl = smallWins.reduce((s, c) => s + c.pnlPct, 0) / smallWins.length;
    const avgBigPnl = bigWins.length > 0 ? bigWins.reduce((s, c) => s + c.pnlPct, 0) / bigWins.length : 0;

    insights.push({
      category: 'SIZING',
      insight: `💡 조기 익절 경향: 수익 매매의 ${((smallWins.length / wins.length) * 100).toFixed(0)}%가 +1% 미만에서 매도 (평균 +${avgSmallPnl.toFixed(1)}%). 큰 수익(${bigWins.length}건) 평균 +${avgBigPnl.toFixed(1)}%. 수익 시 더 홀딩하면 수익률 향상 가능.`,
      recommendation: `TP 하한을 +2.0% 이상으로 설정. 수익 진입 후 최소 1일은 홀딩 유지.`,
      paramChange: avgSmallPnl < 0.8 ? { field: 'take_profit_pct', value: 4.0, reason: '조기 익절 방지 — TP 상향' } : undefined,
      confidence: 0.75,
      sampleCount: smallWins.length,
      lastUpdated: now,
    });
  }

  return insights;
}
