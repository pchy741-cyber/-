/**
 * Gemini 공통 클라이언트 — 완전 비활성화 (v4: 비용 차단)
 *
 * 2026-06: Gemini/Vertex AI 전면 중단
 *   - 5월~6월 ₩52K+ 비용 발생 + 수익 기여 없음 (연패)
 *   - RSS 뉴스 감성분석 + 규칙기반 엔진이 대체
 *   - 모든 callVertexGemini() 호출 즉시 실패 → 호출 측 fallback 동작
 *
 * GenAI App Builder 크레딧(₩143만)은 Vertex AI Search 전용 — Gemini API에 미적용
 */
import { logger } from './logger.js';

// ── GoogleAuth 제거 — 모듈 로드 시 인증 시도 자체를 차단 ──
// 기존: const auth = new GoogleAuth(...) → 임포트만으로 GCP 인증 발생 → 비용
// 변경: 완전 제거

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
  label?: string;
  grounded?: boolean;
}

// ── AI 비용 추적 (호환성 유지) ──
const _dailyTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, vertexCalls: 0, studioCalls: 0, resetAt: 0 };

/** 대시보드용 — 오늘 AI 비용 현황 (항상 0) */
export function getAiCostSummary() {
  return {
    model: 'DISABLED (Gemini/Vertex 비활성화)',
    today: {
      calls: 0, vertexCalls: 0, studioCalls: 0,
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: 0,
      vertexDailyBudgetUsd: 0,
      vertexDailySpentUsd: 0,
      vertexAvailable: false,
      studioCallsUsed: 0,
      studioCallsMax: 0,
    },
    recentCalls: [],
    disabledReason: 'Gemini/Vertex AI 완전 비활성화 (비용 차단). RSS 뉴스 감성분석 + 규칙기반 엔진으로 대체.',
  };
}

/**
 * 모든 Gemini 호출 차단 — 즉시 에러 반환
 * 호출 측에서 geminiEnabled 체크를 빠뜨려도 여기서 100% 차단
 */
export async function callVertexGemini(
  _systemPrompt: string,
  _userMessage: string,
  opts: GeminiCallOptions = {},
): Promise<string> {
  const label = opts.label ?? 'unknown';
  logger.warn(`🚫 Gemini 호출 차단됨 [${label}] — AI 비용 $0 정책 적용 중`, { component: 'AI_COST' });
  throw new Error(`Gemini 비활성화 — ${label} 호출 차단 (비용 절감 정책)`);
}
