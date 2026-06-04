/**
 * Gemini 공통 클라이언트 — AI Studio 우선 (무료) + Vertex AI 폴백
 * 1순위: AI Studio (무료 1500 RPD, 그라운딩 포함, GEMINI_API_KEY)
 * 2순위: Vertex AI (폴백, ADC 인증, 일일 $1.5 제한)
 * 3순위: 호출자의 AI-free 폴백 (Momentum Cascade 등)
 *
 * GenAI App Builder 크레딧(₩143만)은 Vertex AI Search 전용 — Gemini API에 미적용
 */
import { GoogleAuth } from 'google-auth-library';
import { logger } from './logger.js';

const MODEL = 'gemini-2.5-flash';
const AI_STUDIO_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Vertex AI 설정 — Cloud Run ADC 자동 인증
const VERTEX_PROJECT = process.env.GCP_PROJECT || 'quantops-trading';
const VERTEX_REGION = process.env.GCP_REGION || 'asia-northeast3';
const VERTEX_ENDPOINT = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${MODEL}:generateContent`;

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
let _vertexAvailable = true; // Vertex AI 인증 실패 시 세션 내 비활성화

// ── 일일 예산 ──
const VERTEX_DAILY_BUDGET_USD = 3.0;  // Vertex AI — 배치분석+그라운딩 (₩4,000/일)
const STUDIO_DAILY_MAX_CALLS = 200;   // AI Studio — 일반 분석 주력 (무료 1500 RPD)
const _vertexDailyCost = { usd: 0, resetAt: 0 };
const _studioDailyCalls = { count: 0, resetAt: 0 };

function isVertexBudgetAvailable(): boolean {
  const now = Date.now();
  const kst = new Date(now + 9 * 3600_000);
  const todayKstMs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000;
  if (_vertexDailyCost.resetAt < todayKstMs) {
    _vertexDailyCost.usd = 0;
    _vertexDailyCost.resetAt = todayKstMs;
  }
  return _vertexDailyCost.usd < VERTEX_DAILY_BUDGET_USD;
}

function addVertexCost(meta: { promptTokenCount?: number; candidatesTokenCount?: number }) {
  const inputCost = ((meta.promptTokenCount ?? 0) / 1_000_000) * 0.15;
  const outputCost = ((meta.candidatesTokenCount ?? 0) / 1_000_000) * 0.60;
  _vertexDailyCost.usd += inputCost + outputCost;
}

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
  label?: string; // 호출 목적 라벨 (비용 추적용)
  grounded?: boolean; // Google Search 그라운딩 (실시간 뉴스·시장 정보)
}

// ── AI 비용 추적 (인메모리, 24시간 롤링) ──
interface TokenUsageEntry {
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
  via: 'vertex' | 'ai-studio';
}

const _usageLog: TokenUsageEntry[] = [];
const _dailyTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, vertexCalls: 0, studioCalls: 0, resetAt: 0 };

function resetDailyIfNeeded() {
  const now = Date.now();
  // KST 자정 기준 리셋
  const kst = new Date(now + 9 * 3600_000);
  const todayKstMs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000;
  if (_dailyTotals.resetAt < todayKstMs) {
    _dailyTotals.inputTokens = 0;
    _dailyTotals.outputTokens = 0;
    _dailyTotals.totalTokens = 0;
    _dailyTotals.calls = 0;
    _dailyTotals.vertexCalls = 0;
    _dailyTotals.studioCalls = 0;
    _dailyTotals.resetAt = todayKstMs;
    _usageLog.length = 0;
  }
}

function trackUsage(label: string, via: 'vertex' | 'ai-studio', meta: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }) {
  resetDailyIfNeeded();
  const entry: TokenUsageEntry = {
    label,
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
    timestamp: Date.now(),
    via,
  };
  _usageLog.push(entry);
  _dailyTotals.inputTokens += entry.inputTokens;
  _dailyTotals.outputTokens += entry.outputTokens;
  _dailyTotals.totalTokens += entry.totalTokens;
  _dailyTotals.calls++;
  if (via === 'vertex') _dailyTotals.vertexCalls++;
  else _dailyTotals.studioCalls++;

  // 최근 100건만 보관
  if (_usageLog.length > 100) _usageLog.splice(0, _usageLog.length - 50);

  logger.info(
    `💰 Gemini [${label}] via ${via} | in:${entry.inputTokens} out:${entry.outputTokens} | 오늘: ${_dailyTotals.calls}회 (V:${_dailyTotals.vertexCalls} S:${_dailyTotals.studioCalls}) | Vertex예산: $${_vertexDailyCost.usd.toFixed(3)}/$${VERTEX_DAILY_BUDGET_USD}`,
    { component: 'AI_COST' },
  );
}

/** 대시보드용 — 오늘 AI 비용 현황 */
export function getAiCostSummary() {
  resetDailyIfNeeded();
  const inputCost = (_dailyTotals.inputTokens / 1_000_000) * 0.15;
  const outputCost = (_dailyTotals.outputTokens / 1_000_000) * 0.60;
  return {
    model: MODEL,
    today: {
      calls: _dailyTotals.calls,
      vertexCalls: _dailyTotals.vertexCalls,
      studioCalls: _dailyTotals.studioCalls,
      inputTokens: _dailyTotals.inputTokens,
      outputTokens: _dailyTotals.outputTokens,
      totalTokens: _dailyTotals.totalTokens,
      estimatedCostUsd: Math.round((inputCost + outputCost) * 10000) / 10000,
      vertexDailyBudgetUsd: VERTEX_DAILY_BUDGET_USD,
      vertexDailySpentUsd: Math.round(_vertexDailyCost.usd * 10000) / 10000,
      vertexAvailable: _vertexAvailable && isVertexBudgetAvailable(),
      studioCallsUsed: _studioDailyCalls.count,
      studioCallsMax: STUDIO_DAILY_MAX_CALLS,
    },
    recentCalls: _usageLog.slice(-10).map(e => ({
      label: e.label,
      tokens: e.totalTokens,
      via: e.via,
      time: new Date(e.timestamp).toISOString(),
    })),
  };
}

export async function callVertexGemini(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
  };
  // Google Search 그라운딩 — 실시간 뉴스·시장 정보 결합 (GenAI App Builder 크레딧 소진)
  if (opts.grounded) {
    body.tools = [{ google_search: {} }];
  }

  // ── 라우팅 전략 ──
  // 대량 분석(TrackA 등): Vertex 우선 (AI Studio RPM 제한 회피)
  // 소량 호출: AI Studio 우선 (무료) → Vertex 폴백

  const geminiKey = process.env.GEMINI_API_KEY;
  const isBatchLabel = opts.label?.startsWith('TrackA') || opts.label?.startsWith('TrackB');

  // 대량 분석은 Vertex 우선 (AI Studio 10 RPM 제한 회피)
  if (isBatchLabel && _vertexAvailable && isVertexBudgetAvailable()) {
    try {
      return await callViaVertex(body, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️ Vertex 배치 실패 → AI Studio 폴백: ${msg.slice(0, 100)}`, { component: 'AI_COST' });
      if (msg.includes('403') || msg.includes('401') || msg.includes('PERMISSION_DENIED')) {
        _vertexAvailable = false;
      }
      // AI Studio로 폴백 (아래로 계속)
    }
  }

  // AI Studio (무료)
  if (geminiKey) {
    const now = Date.now();
    const kstNow = new Date(now + 9 * 3600_000);
    const todayMs = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - 9 * 3600_000;
    if (_studioDailyCalls.resetAt < todayMs) {
      _studioDailyCalls.count = 0;
      _studioDailyCalls.resetAt = todayMs;
    }
    if (_studioDailyCalls.count < STUDIO_DAILY_MAX_CALLS) {
      _studioDailyCalls.count++;
      try {
        return await callViaAiStudio(geminiKey, body, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 429 = rate limit → 10초 대기 후 1회 재시도
        if (msg.includes('429')) {
          logger.info('⏳ AI Studio 429 → 10초 대기 후 재시도', { component: 'AI_COST' });
          await new Promise(r => setTimeout(r, 10_000));
          try {
            return await callViaAiStudio(geminiKey, body, opts);
          } catch {
            logger.warn('⚠️ AI Studio 재시도 실패 → Vertex 폴백', { component: 'AI_COST' });
          }
        } else {
          logger.warn(`⚠️ AI Studio 실패 → Vertex 폴백: ${msg.slice(0, 100)}`, { component: 'AI_COST' });
        }
      }
    }
  }

  // 최종 폴백: Vertex AI
  if (_vertexAvailable && isVertexBudgetAvailable()) {
    try {
      return await callViaVertex(body, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('401') || msg.includes('PERMISSION_DENIED')) {
        _vertexAvailable = false;
      }
      throw err;
    }
  }

  throw new Error('AI 호출 불가 — AI Studio 한도 + Vertex 예산 모두 소진');
}

// ── Vertex AI 호출 (ADC 인증) ──
async function callViaVertex(
  body: Record<string, unknown>,
  opts: GeminiCallOptions,
): Promise<string> {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error('Vertex AI ADC 토큰 획득 실패');

  const response = await fetch(VERTEX_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Vertex AI ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates: Array<{
      content: { parts: Array<{ text: string }> };
      groundingMetadata?: { searchEntryPoint?: { renderedContent?: string }; groundingChunks?: Array<{ web?: { uri: string; title: string } }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };

  if (data.usageMetadata) {
    addVertexCost(data.usageMetadata);
    trackUsage(opts.label ?? 'unknown', 'vertex', data.usageMetadata);
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex AI 응답 텍스트 없음');

  // 그라운딩 출처 로그 (디버그용)
  const gm = candidate?.groundingMetadata;
  if (gm?.groundingChunks?.length) {
    logger.debug(`🔍 그라운딩 출처 ${gm.groundingChunks.length}건: ${gm.groundingChunks.slice(0, 3).map(c => c.web?.title).join(', ')}`, { component: 'AI_GROUNDING' });
  }

  return text;
}

// ── AI Studio 호출 (API Key) ──
async function callViaAiStudio(
  apiKey: string,
  body: Record<string, unknown>,
  opts: GeminiCallOptions,
): Promise<string> {
  const response = await fetch(`${AI_STUDIO_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI Studio ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };

  if (data.usageMetadata) {
    trackUsage(opts.label ?? 'unknown', 'ai-studio', data.usageMetadata);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI Studio 응답 텍스트 없음');
  return text;
}
