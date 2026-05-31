/**
 * 🧠 자기학습 모듈 (Self-Learning / Reinforcement)
 *
 * 모듈이 self-learning/ 디렉토리로 분리됨.
 * 기존 import 호환을 위한 re-export 파일.
 */
export {
  analyzeTradeHistory,
  getLearnedInsightsForPrompt,
  autoApplyInsights,
  applyInsightById,
  getInsightsForDashboard,
  getLearnedParameters,
  getStockAccuracyContext,
  runDailyLearning,
  validatePromotedInsights,
} from './self-learning/index.js';

export type {
  InsightParamChange,
  LearnedInsight,
  EnrichedChain,
  LearnedParameters,
} from './self-learning/index.js';
