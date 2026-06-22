/**
 * 해외주식 AI 분석 (Claude/Gemini + 규칙기반 폴백)
 * (overseas-job.ts에서 추출)
 */
import { analyzeOverseasWithAI, type OverseasStockInput } from '../../ai/overseas/analyzer.js';
import { getAIGeneratedInsights } from '../../ai/overseas/insights-generator.js';
import { getFearGreedIndex, getUpcomingEarnings } from '../../market/external-signals.js';
import { logger } from '../../utils/logger.js';
import { getUserInsights } from './order-sync.js';
import { getRecentPerfSummary } from './analytics.js';
import type { TechResult } from './sell-logic.js';
import { getSessionCache, overseasState } from './session.js';
import { getActiveSessionBrief } from './session-strategy.js';
import type { getHoldings } from './state.js';
type OverseasHolding = Awaited<ReturnType<typeof getHoldings>> extends Map<string, infer V> ? V : never;

import type { CrossMarketSignal } from './cross-market.js';
import type { EarningsDriftSignal } from './earnings-drift.js';
import type { SqueezeSignal } from './squeeze-detector.js';

export interface AIAnalysisParams {
  techResults: TechResult[];
  holdings: Map<string, OverseasHolding>;
  cash: number;
  region: 'US' | 'ASIA';
  isUSSession: boolean;
  isPaper: boolean;
  usCodes: string[];
  crossSignals: CrossMarketSignal[];
  earningsDrift: EarningsDriftSignal[];
  squeezeSignals: SqueezeSignal[];
  tradeReviewCtx: string;
  fgShared: Awaited<ReturnType<typeof getFearGreedIndex>> | null;
  earningsShared: Awaited<ReturnType<typeof getUpcomingEarnings>>;
}

export interface AIAnalysisResult {
  aiDecisions: Awaited<ReturnType<typeof analyzeOverseasWithAI>>;
}

export async function runAIAnalysis(params: AIAnalysisParams): Promise<AIAnalysisResult> {
  const {
    techResults, holdings, cash, region, isUSSession, isPaper: isPaperMode,
    usCodes, crossSignals, earningsDrift, squeezeSignals, tradeReviewCtx,
    fgShared, earningsShared,
  } = params;
  const s = overseasState;

  const heldSet = new Set(holdings.keys());
  const allAiInputs: OverseasStockInput[] = techResults.map((t) => {
    const holding = holdings.get(t.code);
    const pnlPct =
      holding && holding.avgPrice > 0
        ? ((t.price.currentPrice - holding.avgPrice) / holding.avgPrice) * 100
        : undefined;
    return {
      code: t.code,
      name: t.name,
      exchange: t.exchange,
      currentPrice: t.price.currentPrice,
      changePct: t.price.changePct,
      rsi: t.rsi,
      adx: t.adx,
      score: t.score,
      signal: t.signal,
      trendStrength: t.trendStrength,
      isHolding: !!holding,
      holdingPnlPct: pnlPct,
      dayRangePct: t.dayRangePct,
      isMomentum: t.isMomentum,
      isBigMover: t.isBigMover,
      aboveMA20: t.aboveMA20,
      bollingerSqueeze: t.bollingerSqueeze,
      bollingerBreakout: t.bollingerBreakout,
    };
  });

  const latestSessionCache = getSessionCache(region);
  let aiInputs = allAiInputs;
  if (latestSessionCache) {
    const topSet = new Set(latestSessionCache.topCodes);
    aiInputs = allAiInputs.filter(
      (si) => heldSet.has(si.code) || topSet.has(si.code) || si.isMomentum || si.isBigMover,
    );
    if (aiInputs.length < allAiInputs.length) {
      logger.info(
        `🤖 AI 입력 최적화: ${allAiInputs.length} → ${aiInputs.length}종목 (세션 후보 + 모멘텀/빅무버 포함)`,
        { component: 'OVERSEAS' },
      );
    }
  }

  const hasBuyCandidates = aiInputs.some((si) => !si.isHolding);
  const hasSellCandidates = aiInputs.some((si) => si.isHolding);
  const now_ms = Date.now();
  const intervalMs = (await import('../../config/constants.js')).OVERSEAS.AI_INTERVAL_MS;
  const lastAiCall = isPaperMode ? s.lastPaperAiCallAt : s.lastUSAiCallAt;
  const aiCooldownOk = isUSSession ? now_ms - lastAiCall >= intervalMs : true;
  const hasUrgentSell = aiInputs.some((si) => si.isHolding && (si.score <= -15 || si.rsi > 72));
  const shouldCallAI = (hasBuyCandidates || hasSellCandidates) && (aiCooldownOk || hasUrgentSell);
  if ((hasBuyCandidates || hasSellCandidates) && !aiCooldownOk && !hasUrgentSell) {
    logger.info(
      `🤖 AI 대기 중 — 다음 호출까지 ${Math.ceil((intervalMs - (now_ms - lastAiCall)) / 60000)}분 (무료 한도 절약)`,
      { component: 'OVERSEAS' },
    );
  }
  if (hasUrgentSell && !aiCooldownOk) {
    logger.info(`🚨 보유종목 악화 감지 → AI 쿨다운 바이패스 (매도 판단 우선)`, { component: 'OVERSEAS' });
  }

  let aiDecisions: Awaited<ReturnType<typeof analyzeOverseasWithAI>> = [];
  if (shouldCallAI) {
    const fgEarly = fgShared;
    const earningsEarly = earningsShared;
    const earningsRiskCodes = earningsEarly.filter((e) => e.daysUntil >= 0 && e.daysUntil <= 5).map((e) => e.code);
    const positiveCount = techResults.filter((t) => t.price.changePct > 0).length;
    const breadthPct = techResults.length > 0 ? positiveCount / techResults.length : 0.5;

    const sectorChangeMap = new Map<string, number[]>();
    for (const t of techResults) {
      const arr = sectorChangeMap.get(t.sector) ?? [];
      arr.push(t.price.changePct);
      sectorChangeMap.set(t.sector, arr);
    }
    const sectorRanking = [...sectorChangeMap.entries()]
      .map(([sc, cs]) => ({ sector: sc, avg: cs.reduce((a, b) => a + b, 0) / cs.length }))
      .sort((a, b) => b.avg - a.avg);
    const sectorMomentumStr = sectorRanking
      .map((sc) => `${sc.sector}${sc.avg >= 0 ? '+' : ''}${sc.avg.toFixed(1)}%`)
      .join(' ');

    const mktCtx = fgEarly
      ? {
          fearGreed: fgEarly.fearGreedScore,
          fearGreedLabel: fgEarly.fearGreedLabel,
          vix: fgEarly.vix,
          earningsRisk: earningsRiskCodes,
          breadthPct,
          sectorMomentum: sectorMomentumStr,
        }
      : { breadthPct, sectorMomentum: sectorMomentumStr };

    const { config: appConfig } = await import('../../config/index.js');
    if (appConfig.geminiEnabled) {
      const [perfSummary, userInsights, aiInsights] = await Promise.all([
        getRecentPerfSummary(),
        getUserInsights(),
        getAIGeneratedInsights(),
      ]);
      const brief = getActiveSessionBrief();
      const sessionCtx = brief
        ? `[세션전략] ${brief.marketRegime}/${brief.riskLevel} | 집중:${brief.focusSectors.join(',')} | ${brief.narrative}`
        : '';
      const crossCtx =
        crossSignals.length > 0
          ? `[크로스마켓] ${crossSignals.map((s2) => `${s2.usCode} ${s2.signalType}(아시아 ${s2.asiaCode} ${s2.asiaChangePct >= 0 ? '+' : ''}${s2.asiaChangePct.toFixed(1)}%)`).join(', ')}`
          : '';
      const driftCtx =
        earningsDrift.length > 0
          ? `[어닝드리프트] ${earningsDrift.map((s2) => `${s2.code} ${s2.direction} gap${s2.gapPct >= 0 ? '+' : ''}${s2.gapPct.toFixed(1)}% vol${s2.volumeRatio.toFixed(1)}x`).join(', ')}`
          : '';
      const squeezeCtx =
        squeezeSignals.length > 0
          ? `[스퀴즈돌파] ${squeezeSignals.map((s2) => `${s2.code} str${s2.strength.toFixed(2)}`).join(', ')}`
          : '';
      const { getOverseasInsightsForPrompt } = await import('../../automation/self-learning/overseas-analyzers.js');
      const overseasLearnedInsights = await getOverseasInsightsForPrompt().catch(() => '');
      const combinedInsights =
        [
          userInsights,
          aiInsights ? `[AI자기학습]\n${aiInsights}` : '',
          overseasLearnedInsights,
          sessionCtx,
          crossCtx,
          driftCtx,
          squeezeCtx,
          tradeReviewCtx ? `[매매복기]\n${tradeReviewCtx}` : '',
        ]
          .filter(Boolean)
          .join('\n\n') || undefined;
      aiDecisions = await analyzeOverseasWithAI(aiInputs, cash, holdings.size, perfSummary, combinedInsights, mktCtx);
    } else {
      const { analyzeOverseasRuleBased } = await import('../../ai/overseas/rule-based-analyzer.js');
      aiDecisions = analyzeOverseasRuleBased(aiInputs, cash, holdings.size, mktCtx, crossSignals);
    }

    if (isUSSession) {
      if (isPaperMode) s.lastPaperAiCallAt = Date.now();
      else s.lastUSAiCallAt = Date.now();
    }
  } else {
    logger.info('🤖 분석 생략 — 후보 없음 또는 쿨다운 중', { component: 'OVERSEAS' });
  }

  return { aiDecisions };
}
