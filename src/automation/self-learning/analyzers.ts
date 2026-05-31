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
    list.push({ pnlPct, date: chain.closed_at ?? chain.opened_at });
    stockTrades.set(code, list);
  }

  const insights: LearnedInsight[] = [];

  for (const [code, trades] of stockTrades) {
    if (trades.length < 4) continue;

    const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
    const half = Math.floor(sorted.length / 2);
    const older = sorted.slice(0, half);
    const newer = sorted.slice(half);

    const olderWinRate = older.filter(t => t.pnlPct > 0).length / older.length;
    const newerWinRate = newer.filter(t => t.pnlPct > 0).length / newer.length;
    const olderAvgPnl = older.reduce((s, t) => s + t.pnlPct, 0) / older.length;
    const newerAvgPnl = newer.reduce((s, t) => s + t.pnlPct, 0) / newer.length;

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
