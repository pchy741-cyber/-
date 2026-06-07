/**
 * 앙상블 AI 스코어링 오케스트레이터
 *
 * 여러 AI 모델을 병렬 실행하고 점수를 합산하여 단일 모델보다 높은 승률 달성.
 * - 각 모델은 완전 독립: API 키 없으면 자동 스킵
 * - 최소 minModels 개 이상 응답해야 유효 (기본 2)
 * - 모델간 점수 편차가 작을수록 confidence 상승
 */
import type { DailyCandle } from '../../kis/market.js';
import type { ScoringResult } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import type { RegimeHint } from '../prompts/track-a-scoring.js';
import type { GeminiAnalysis } from './gemini.js';

const COMP = 'ENSEMBLE';

export interface EnsembleWeights {
  gemini: number;
  gpt: number;
  claude: number;
  rss: number;
}

export interface EnsembleConfig {
  weights: EnsembleWeights;
  strategy: 'weighted_avg' | 'majority_vote' | 'conservative';
  minModels: number;
}

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  weights: { gemini: 0.30, gpt: 0.35, claude: 0.20, rss: 0.15 },
  strategy: 'weighted_avg',
  minModels: 2,
};

interface WatchlistItem { stock_code: string; stock_name: string; }

interface EnsembleParams {
  mode: string;
  watchlist: WatchlistItem[];
  chartData: Map<string, DailyCandle[]>;
  geminiAnalysis: GeminiAnalysis | null;
  strategy: any;
  regimeHint: RegimeHint;
  ensembleConfig?: EnsembleConfig;
  // RSS 전용
  topGainerCodes?: Set<string>;
  topVolumeCodes?: Set<string>;
  flowAdjMap?: Map<string, number>;
}

interface ModelResult {
  model: keyof EnsembleWeights;
  scores: ScoringResult[];
  elapsed: number;
}

/** 개별 모델 실행 (실패 시 빈 배열) */
async function runModel(
  model: keyof EnsembleWeights,
  params: EnsembleParams,
): Promise<ModelResult> {
  const start = Date.now();
  let scores: ScoringResult[] = [];

  try {
    switch (model) {
      case 'gemini': {
        if (!params.geminiAnalysis) break;
        const { runGeminiScoring } = await import('./gemini-scorer.js');
        scores = await runGeminiScoring({
          mode: params.mode,
          geminiAnalysis: params.geminiAnalysis,
          customPrompt: params.strategy?.gpt_prompt ?? undefined,
          regimeHint: params.regimeHint,
        });
        break;
      }
      case 'gpt': {
        if (!process.env.OPENAI_API_KEY) break;
        const { runGPTScoring } = await import('./gpt-scorer.js');
        scores = await runGPTScoring(
          params.mode, params.watchlist, params.chartData, params.regimeHint,
        );
        break;
      }
      case 'claude': {
        if (!process.env.ANTHROPIC_API_KEY) break;
        const { runClaudeScoring } = await import('./claude-scorer.js');
        scores = await runClaudeScoring(
          params.mode, params.watchlist, params.chartData,
        );
        break;
      }
      case 'rss': {
        const { runRSSScoring } = await import('./rss-scorer.js');
        scores = await runRSSScoring(
          params.mode,
          params.watchlist,
          params.chartData,
          params.topGainerCodes ?? new Set(),
          params.topVolumeCodes ?? new Set(),
          params.flowAdjMap ?? new Map(),
        );
        break;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`앙상블 ${model} 실패: ${msg.slice(0, 150)}`, { component: COMP });
  }

  return { model, scores, elapsed: Date.now() - start };
}

/** 신호 결정 (기존 룰과 동일) */
function resolveSignal(score: number): ScoringResult['signal'] {
  if (score >= 82) return 'STRONG_BUY';
  if (score >= 68) return 'BUY';
  if (score >= 50) return 'HOLD';
  if (score >= 30) return 'SELL';
  return 'STRONG_SELL';
}

/** 앙상블 점수 합산 */
function mergeScores(
  modelResults: ModelResult[],
  config: EnsembleConfig,
): ScoringResult[] {
  // 종목별로 각 모델의 점수를 수집
  const byStock = new Map<string, Array<{ model: keyof EnsembleWeights; score: ScoringResult }>>();

  for (const mr of modelResults) {
    for (const s of mr.scores) {
      const list = byStock.get(s.stock_code) ?? [];
      list.push({ model: mr.model, score: s });
      byStock.set(s.stock_code, list);
    }
  }

  const merged: ScoringResult[] = [];
  const activeModels = modelResults.filter(r => r.scores.length > 0).map(r => r.model);

  // 활성 모델의 가중치만 추출하고 합이 1이 되도록 정규화
  let totalWeight = 0;
  const normalizedWeights = new Map<keyof EnsembleWeights, number>();
  for (const m of activeModels) {
    const w = config.weights[m] ?? 0;
    totalWeight += w;
    normalizedWeights.set(m, w);
  }
  if (totalWeight > 0) {
    for (const [m, w] of normalizedWeights) {
      normalizedWeights.set(m, w / totalWeight);
    }
  }

  for (const [stockCode, entries] of byStock) {
    if (entries.length < config.minModels) continue; // 최소 모델 수 미달 → 스킵

    let composite: number;
    let fundamentalScore = 0;
    let technicalScore = 0;
    let sentimentScore = 0;

    if (config.strategy === 'conservative') {
      // 최저 점수 채택 (가장 보수적)
      composite = Math.min(...entries.map(e => e.score.composite_score));
      const lowest = entries.reduce((a, b) =>
        a.score.composite_score <= b.score.composite_score ? a : b);
      fundamentalScore = lowest.score.fundamental_score;
      technicalScore = lowest.score.technical_score;
      sentimentScore = lowest.score.sentiment_score;
    } else if (config.strategy === 'majority_vote') {
      // 다수결: 각 모델의 신호 투표
      const votes = { BUY: 0, SELL: 0, HOLD: 0 };
      let weightedSum = 0;
      let wSum = 0;
      for (const e of entries) {
        const w = normalizedWeights.get(e.model) ?? 0;
        weightedSum += e.score.composite_score * w;
        wSum += w;
        const sig = e.score.signal;
        if (sig === 'STRONG_BUY' || sig === 'BUY') votes.BUY += 1;
        else if (sig === 'STRONG_SELL' || sig === 'SELL') votes.SELL += 1;
        else votes.HOLD += 1;
      }
      // 다수결 신호와 가중평균 점수 조합
      composite = wSum > 0 ? Math.round(weightedSum / wSum) : 50;
      // 다수결로 BUY인데 점수가 낮으면 점수 보정
      if (votes.BUY > votes.SELL && votes.BUY > votes.HOLD && composite < 68) {
        composite = 68; // BUY 문턱
      }
      if (votes.SELL > votes.BUY && composite > 49) {
        composite = 49; // SELL 문턱
      }
      fundamentalScore = Math.round(entries.reduce((a, e) => a + e.score.fundamental_score, 0) / entries.length);
      technicalScore = Math.round(entries.reduce((a, e) => a + e.score.technical_score, 0) / entries.length);
      sentimentScore = Math.round(entries.reduce((a, e) => a + e.score.sentiment_score, 0) / entries.length);
    } else {
      // weighted_avg (기본): 가중 평균
      let weightedSum = 0;
      let wSum = 0;
      let fSum = 0, tSum = 0, sSum = 0;
      for (const e of entries) {
        const w = normalizedWeights.get(e.model) ?? 0;
        weightedSum += e.score.composite_score * w;
        fSum += e.score.fundamental_score * w;
        tSum += e.score.technical_score * w;
        sSum += e.score.sentiment_score * w;
        wSum += w;
      }
      composite = wSum > 0 ? Math.round(weightedSum / wSum) : 50;
      fundamentalScore = wSum > 0 ? Math.round(fSum / wSum) : 50;
      technicalScore = wSum > 0 ? Math.round(tSum / wSum) : 50;
      sentimentScore = wSum > 0 ? Math.round(sSum / wSum) : 50;
    }

    composite = Math.max(0, Math.min(100, composite));

    // confidence: 모델간 편차 반영 (편차 작을수록 높음)
    const scores = entries.map(e => e.score.composite_score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    // stdDev 0 → confidence 0.9, stdDev 20+ → confidence 0.5
    const agreementBonus = Math.max(0, 0.4 * (1 - Math.min(1, stdDev / 20)));
    const baseConfidence = 0.5;
    const confidence = Math.min(0.95, baseConfidence + agreementBonus);

    // reasoning: 각 모델 점수 투명 표시
    const parts = entries.map(e => {
      const label = e.model === 'gemini' ? 'G' : e.model === 'gpt' ? 'GPT' : e.model === 'claude' ? 'C' : 'RSS';
      return `${label}:${e.score.composite_score}`;
    });
    const reasoning = `[앙상블:${config.strategy}] ${parts.join(' ')} → ${composite} (σ=${stdDev.toFixed(1)}, ${entries.length}모델)`;

    merged.push({
      stock_code: stockCode,
      composite_score: composite,
      fundamental_score: fundamentalScore,
      technical_score: technicalScore,
      sentiment_score: sentimentScore,
      signal: resolveSignal(composite),
      confidence,
      reasoning,
    });
  }

  return merged;
}

/**
 * 앙상블 스코어링 실행
 * - 활성 모델을 병렬 실행 (Promise.allSettled — 하나 실패해도 나머지 유효)
 * - 최소 minModels 개 응답 필요
 * - 실패 시 빈 배열 반환 (호출자가 폴백 체인 계속)
 */
export async function runEnsembleScoring(params: EnsembleParams): Promise<ScoringResult[]> {
  const config = params.ensembleConfig ?? DEFAULT_ENSEMBLE_CONFIG;
  const models: Array<keyof EnsembleWeights> = ['gemini', 'gpt', 'claude', 'rss'];

  // 활성 가능한 모델 확인
  const available: Array<keyof EnsembleWeights> = [];
  for (const m of models) {
    switch (m) {
      case 'gemini':
        if (params.geminiAnalysis) available.push(m);
        else logger.info('앙상블: Gemini 분석 없음 → 스킵', { component: COMP });
        break;
      case 'gpt':
        if (process.env.OPENAI_API_KEY) available.push(m);
        else logger.info('앙상블: OPENAI_API_KEY 미설정 → GPT 스킵', { component: COMP });
        break;
      case 'claude':
        if (process.env.ANTHROPIC_API_KEY) available.push(m);
        else logger.info('앙상블: ANTHROPIC_API_KEY 미설정 → Claude 스킵', { component: COMP });
        break;
      case 'rss':
        available.push(m); // 항상 가능 (무료)
        break;
    }
  }

  if (available.length < config.minModels) {
    logger.warn(
      `앙상블 최소 모델 수 미달: ${available.length}/${config.minModels} (${available.join(',')}) → 폴백 체인으로 전환`,
      { component: COMP },
    );
    return []; // 빈 배열 → pipeline.ts의 기존 폴백 체인 실행
  }

  logger.info(
    `🎼 앙상블 스코어링 시작: ${available.join('+')} (전략: ${config.strategy}, 최소 ${config.minModels}모델)`,
    { component: COMP },
  );

  // 병렬 실행
  const results = await Promise.allSettled(
    available.map(m => runModel(m, params)),
  );

  const modelResults: ModelResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.scores.length > 0) {
      modelResults.push(r.value);
      logger.info(
        `  ✅ ${r.value.model}: ${r.value.scores.length}개 (${(r.value.elapsed / 1000).toFixed(1)}초)`,
        { component: COMP },
      );
    } else if (r.status === 'fulfilled') {
      logger.info(`  ⬚ ${r.value.model}: 0개 (스킵됨, ${(r.value.elapsed / 1000).toFixed(1)}초)`, { component: COMP });
    } else {
      logger.warn(`  ❌ 모델 실행 거부: ${r.reason}`, { component: COMP });
    }
  }

  // 응답 모델 수 확인
  if (modelResults.length < config.minModels) {
    logger.warn(
      `앙상블 응답 모델 부족: ${modelResults.length}/${config.minModels} → 폴백 체인으로 전환`,
      { component: COMP },
    );
    return [];
  }

  // 점수 합산
  const merged = mergeScores(modelResults, config);
  const buyCount = merged.filter(s => s.composite_score >= 68).length;

  logger.info(
    `🎼 앙상블 완료: ${modelResults.length}모델 → ${merged.length}개 스코어, 매수후보 ${buyCount}개`,
    { component: COMP },
  );

  return merged;
}
