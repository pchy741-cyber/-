/**
 * Gemini 공통 클라이언트 — 하이브리드 모드
 *
 * grounded: false (기본) → AI Studio 무료 티어 (비용 $0)
 *   - Gemini 2.5 Flash: 10 RPM / 250 RPD / 250K TPM
 *   - GEMINI_API_KEY 필수
 *
 * grounded: true → Vertex AI + Google Search Grounding (GCP 크레딧 소모)
 *   - Gemini 2.5 Flash with real-time web search
 *   - GOOGLE_CLOUD_PROJECT 필수, Cloud Run ADC 자동 인증
 *   - 비용: ~$0.035/query (GenAI App Builder Trial credit 적용)
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { VertexAI } from '@google-cloud/vertexai';
import { logger } from './logger.js';
import { logTokenUsage, calcGeminiVertexCost, calcGeminiStudioCost } from './ai-token-logger.js';

// ── 모델 설정 ──
const FREE_MODEL = 'gemini-2.5-flash';
const GROUNDED_MODEL = 'gemini-2.5-flash'; // Vertex AI grounding 지원 모델 (2.0-flash-001은 2026-06-01 서비스 종료)
const VERTEX_LOCATION = 'us-central1';

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
  label?: string;
  grounded?: boolean;   // true → Vertex AI + Google Search Grounding (GCP 크레딧)
  useVertex?: boolean;  // true → Vertex AI 직접 사용 (GCP 크레딧, grounding 없음) — DART 분석 등 장문 처리용
  paid?: boolean;       // true → AI Studio 유료 경로 (레이트리미터 우회, GEMINI_API_KEY 결제 적용)
}

// ── 레이트 리미터: AI Studio 무료 티어 한도 ──
const RATE_LIMIT = {
  RPM: 10,
  RPD: 250,
  TPM: 250_000,
} as const;

interface RateState {
  minuteSlots: number[];
  dailyCalls: number;
  dailyResetAt: number;
  minuteTokens: number[];
}

const _rate: RateState = {
  minuteSlots: [],
  dailyCalls: 0,
  dailyResetAt: 0,
  minuteTokens: [],
};

function resetDailyIfNeeded(): void {
  const todayMidnightPT = new Date().setUTCHours(7, 0, 0, 0);
  if (_rate.dailyResetAt < todayMidnightPT) {
    _rate.dailyCalls = 0;
    _rate.dailyResetAt = todayMidnightPT;
    _dailyTotals.inputTokens = 0;
    _dailyTotals.outputTokens = 0;
    _dailyTotals.totalTokens = 0;
    _dailyTotals.calls = 0;
    _dailyTotals.studioCalls = 0;
    _dailyTotals.vertexCalls = 0;
    _dailyTotals.vertexCostUsd = 0;
    _recentCalls.length = 0;
  }
}

function checkRateLimit(): { ok: boolean; waitMs: number; reason: string } {
  resetDailyIfNeeded();
  const now = Date.now();
  if (_rate.dailyCalls >= RATE_LIMIT.RPD) {
    return { ok: false, waitMs: 0, reason: `일 한도 초과 (${_rate.dailyCalls}/${RATE_LIMIT.RPD} RPD)` };
  }
  _rate.minuteSlots = _rate.minuteSlots.filter((t) => now - t < 60_000);
  if (_rate.minuteSlots.length >= RATE_LIMIT.RPM) {
    const waitMs = 60_000 - (now - _rate.minuteSlots[0]) + 100;
    return { ok: false, waitMs, reason: `분당 한도 (${_rate.minuteSlots.length}/${RATE_LIMIT.RPM} RPM)` };
  }
  return { ok: true, waitMs: 0, reason: '' };
}

function recordStudioCall(_tokens: number): void {
  const now = Date.now();
  _rate.minuteSlots.push(now);
  _rate.dailyCalls++;
  _rate.minuteTokens.push(now);
}

// ── 비용 추적 ──
const _dailyTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  calls: 0,
  vertexCalls: 0,
  studioCalls: 0,
  vertexCostUsd: 0,
};

interface CallRecord {
  label: string;
  inputTokens: number;
  outputTokens: number;
  at: string;
  durationMs: number;
  isGrounded?: boolean;
  costUsd?: number;
}
const _recentCalls: CallRecord[] = [];

/** 대시보드용 — 오늘 AI 사용 현황 */
export function getAiCostSummary() {
  resetDailyIfNeeded();
  return {
    model: `AI Studio FREE (${FREE_MODEL}) + Vertex Grounded (${GROUNDED_MODEL})`,
    today: {
      calls: _dailyTotals.calls,
      vertexCalls: _dailyTotals.vertexCalls,
      studioCalls: _dailyTotals.studioCalls,
      inputTokens: _dailyTotals.inputTokens,
      outputTokens: _dailyTotals.outputTokens,
      totalTokens: _dailyTotals.totalTokens,
      estimatedCostUsd: _dailyTotals.vertexCostUsd,
      vertexDailyBudgetUsd: 5.0, // 일 $5 상한 (GCP 크레딧)
      vertexDailySpentUsd: _dailyTotals.vertexCostUsd,
      vertexAvailable: true,
      studioCallsUsed: _rate.dailyCalls,
      studioCallsMax: RATE_LIMIT.RPD,
    },
    recentCalls: _recentCalls.slice(-10),
    disabledReason: null,
  };
}

// ── AI Studio 싱글톤 클라이언트 ──
let _genAI: GoogleGenerativeAI | null = null;

function getStudioClient(): GoogleGenerativeAI {
  if (_genAI) return _genAI;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 미설정 — AI Studio 무료 키 필요 (https://aistudio.google.com/apikey)');
  _genAI = new GoogleGenerativeAI(key);
  return _genAI;
}

// ── Vertex AI SDK 싱글톤 ──
let _vertexAI: VertexAI | null = null;

function getVertexAI(): VertexAI {
  if (_vertexAI) return _vertexAI;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'quantops-trading';
  _vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
  return _vertexAI;
}

/**
 * Vertex AI SDK — 비용 절약형 (Google Search Grounding 없음)
 * AI Studio 일 250콜 한도 소진 시 자동 폴백으로 사용
 */
async function callVertexUngrounded(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const vertexAI = getVertexAI();
  const model = vertexAI.getGenerativeModel({
    model: GROUNDED_MODEL,
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
    systemInstruction: systemPrompt,
  });

  const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: userMessage }] }] });
  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return { text, inputTokens, outputTokens };
}

/**
 * Vertex AI SDK + Google Search Grounding 호출
 * Cloud Run: ADC(서비스 계정) 자동 인증
 */
async function callVertexGrounded(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const vertexAI = getVertexAI();
  const model = vertexAI.preview.getGenerativeModel({
    model: GROUNDED_MODEL,
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
    systemInstruction: systemPrompt,
    tools: [{ googleSearch: {} } as any], // Vertex AI SDK 타입 미지원 — google_search_retrieval → googleSearch 마이그레이션
  });

  const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: userMessage }] }] });
  const response = result.response;
  const finishReason = response.candidates?.[0]?.finishReason;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    throw new Error(`Vertex Grounded: 빈 응답 (finishReason=${finishReason ?? 'unknown'}) — AI Studio fallback`);
  }
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return { text, inputTokens, outputTokens };
}

/**
 * Gemini 호출 — 하이브리드 라우팅
 * grounded: false → AI Studio 무료 ($0)
 * grounded: true  → Vertex AI + Google Search Grounding (GCP 크레딧)
 */
export async function callVertexGemini(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions = {},
): Promise<string> {
  const label = opts.label ?? 'unknown';
  const startMs = Date.now();

  // ── paid: true → AI Studio 유료 경로 (레이트리미터 우회, 결제 적용) ──
  if (opts.paid) {
    try {
      const client = getStudioClient();
      const model = client.getGenerativeModel({
        model: FREE_MODEL,
        generationConfig: {
          temperature: opts.temperature ?? 0.2,
          maxOutputTokens: opts.maxOutputTokens ?? 8192,
        },
        systemInstruction: systemPrompt,
      });
      const result = await model.generateContent(userMessage);
      const response = result.response;
      const text = response.text();
      const usage = response.usageMetadata;
      const inTok = usage?.promptTokenCount ?? 0;
      const outTok = usage?.candidatesTokenCount ?? 0;
      _dailyTotals.inputTokens += inTok;
      _dailyTotals.outputTokens += outTok;
      _dailyTotals.totalTokens += inTok + outTok;
      _dailyTotals.calls++;
      _dailyTotals.studioCalls++;
      const durationMs = Date.now() - startMs;
      _recentCalls.push({ label, inputTokens: inTok, outputTokens: outTok, at: new Date().toISOString(), durationMs, isGrounded: false, costUsd: 0 });
      if (_recentCalls.length > 20) _recentCalls.shift();
      logTokenUsage({ provider: 'gemini', model: FREE_MODEL, inputTokens: inTok, outputTokens: outTok, costUsd: calcGeminiStudioCost(), label });
      logger.info(`💳 AI Studio Paid [${label}]: ${inTok}+${outTok}tok ${durationMs}ms`, { component: 'AI_COST' });
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️ AI Studio Paid 실패 [${label}]: ${msg}`, { component: 'AI_COST' });
      throw err;
    }
  }

  // ── useVertex: true → Vertex AI 직접 경로 (GCP 크레딧, grounding 없음) ──
  if (opts.useVertex && !opts.grounded) {
    try {
      const { text, inputTokens, outputTokens } = await callVertexUngrounded(systemPrompt, userMessage, opts);
      const costUsd = calcGeminiVertexCost(inputTokens, outputTokens, false);
      _dailyTotals.vertexCalls++;
      _dailyTotals.calls++;
      _dailyTotals.inputTokens += inputTokens;
      _dailyTotals.outputTokens += outputTokens;
      _dailyTotals.totalTokens += inputTokens + outputTokens;
      _dailyTotals.vertexCostUsd += costUsd;
      const durationMs = Date.now() - startMs;
      _recentCalls.push({ label, inputTokens, outputTokens, at: new Date().toISOString(), durationMs, isGrounded: false, costUsd });
      if (_recentCalls.length > 20) _recentCalls.shift();
      logTokenUsage({ provider: 'gemini', model: GROUNDED_MODEL, inputTokens, outputTokens, costUsd, label });
      logger.info(`⚡ Vertex Direct [${label}]: ${inputTokens}+${outputTokens}tok $${costUsd.toFixed(5)}`, { component: 'AI_COST' });
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️ Vertex Direct 실패 [${label}], AI Studio fallback: ${msg}`, { component: 'AI_COST' });
    }
  }

  // ── grounded: true → Vertex AI 경로 ──
  if (opts.grounded) {
    try {
      const { text, inputTokens, outputTokens } = await callVertexGrounded(systemPrompt, userMessage, opts);
      const durationMs = Date.now() - startMs;

      // 비용 추정: Gemini 2.5 Flash $0.1/1M input + $0.4/1M output + Search grounding $0.035/query
      const costUsd = calcGeminiVertexCost(inputTokens, outputTokens, true);

      _dailyTotals.vertexCalls++;
      _dailyTotals.calls++;
      _dailyTotals.inputTokens += inputTokens;
      _dailyTotals.outputTokens += outputTokens;
      _dailyTotals.totalTokens += inputTokens + outputTokens;
      _dailyTotals.vertexCostUsd += costUsd;

      _recentCalls.push({ label, inputTokens, outputTokens, at: new Date().toISOString(), durationMs, isGrounded: true, costUsd });
      if (_recentCalls.length > 20) _recentCalls.shift();
      logTokenUsage({ provider: 'gemini', model: GROUNDED_MODEL, inputTokens, outputTokens, costUsd, label });

      logger.info(
        `🔍 Vertex Grounded [${label}]: ${inputTokens}+${outputTokens}tok ${durationMs}ms $${costUsd.toFixed(4)} (누적 $${_dailyTotals.vertexCostUsd.toFixed(3)})`,
        { component: 'AI_COST' },
      );
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️ Vertex Grounding 실패 [${label}], AI Studio fallback: ${msg}`, { component: 'AI_COST' });
      // Vertex 실패 시 AI Studio fallback (grounded 없이)
    }
  }

  // ── AI Studio 무료 경로 ──
  let rateCheck = checkRateLimit();
  if (!rateCheck.ok && rateCheck.waitMs > 0) {
    logger.info(`⏳ AI Studio RPM 대기 ${Math.ceil(rateCheck.waitMs / 1000)}초 [${label}]`, { component: 'AI_COST' });
    await new Promise((r) => setTimeout(r, rateCheck.waitMs));
    rateCheck = checkRateLimit();
  }

  // AI Studio 일 한도 초과 → Vertex AI (GCP 크레딧) 자동 폴백
  if (!rateCheck.ok && rateCheck.reason.includes('일 한도')) {
    logger.info(`⚡ AI Studio RPD 소진 [${label}] → Vertex AI 폴백 (GCP 크레딧)`, { component: 'AI_COST' });
    try {
      const { text, inputTokens, outputTokens } = await callVertexUngrounded(systemPrompt, userMessage, opts);
      const costUsd = calcGeminiVertexCost(inputTokens, outputTokens, false);
      _dailyTotals.vertexCalls++;
      _dailyTotals.calls++;
      _dailyTotals.inputTokens += inputTokens;
      _dailyTotals.outputTokens += outputTokens;
      _dailyTotals.totalTokens += inputTokens + outputTokens;
      _dailyTotals.vertexCostUsd += costUsd;
      const durationMs = Date.now() - startMs;
      _recentCalls.push({ label, inputTokens, outputTokens, at: new Date().toISOString(), durationMs, isGrounded: false, costUsd });
      if (_recentCalls.length > 20) _recentCalls.shift();
      logTokenUsage({ provider: 'gemini', model: GROUNDED_MODEL, inputTokens, outputTokens, costUsd, label });
      logger.info(`⚡ Vertex Fallback [${label}]: ${inputTokens}+${outputTokens}tok $${costUsd.toFixed(5)}`, { component: 'AI_COST' });
      return text;
    } catch (vErr) {
      const vMsg = vErr instanceof Error ? vErr.message : String(vErr);
      logger.warn(`⚠️ Vertex 폴백도 실패 [${label}]: ${vMsg}`, { component: 'AI_COST' });
      throw new Error(`AI Studio 일 한도 초과 + Vertex 폴백 실패 — ${rateCheck.reason}`);
    }
  }

  if (!rateCheck.ok) {
    logger.warn(`🚫 AI Studio 한도 초과 [${label}]: ${rateCheck.reason}`, { component: 'AI_COST' });
    throw new Error(`AI Studio 한도 초과 — ${rateCheck.reason}`);
  }

  try {
    const client = getStudioClient();
    const model = client.getGenerativeModel({
      model: FREE_MODEL,
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
      },
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(userMessage);
    const response = result.response;
    const text = response.text();

    const usage = response.usageMetadata;
    const inTok = usage?.promptTokenCount ?? 0;
    const outTok = usage?.candidatesTokenCount ?? 0;
    recordStudioCall(inTok + outTok);

    _dailyTotals.inputTokens += inTok;
    _dailyTotals.outputTokens += outTok;
    _dailyTotals.totalTokens += inTok + outTok;
    _dailyTotals.calls++;
    _dailyTotals.studioCalls++;

    const durationMs = Date.now() - startMs;
    _recentCalls.push({ label, inputTokens: inTok, outputTokens: outTok, at: new Date().toISOString(), durationMs, isGrounded: false, costUsd: 0 });
    if (_recentCalls.length > 20) _recentCalls.shift();
    logTokenUsage({ provider: 'gemini', model: FREE_MODEL, inputTokens: inTok, outputTokens: outTok, costUsd: calcGeminiStudioCost(), label });

    logger.info(
      `🤖 AI Studio [${label}]: ${inTok}+${outTok}tok ${durationMs}ms (${_rate.dailyCalls}/${RATE_LIMIT.RPD} RPD) $0`,
      { component: 'AI_COST' },
    );
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      // 컨테이너 재시작 후 인메모리 카운터가 0으로 리셋되어 사전 차단 못 한 경우 →
      // 실제 429 수신 시 카운터를 한도로 강제 설정 후 Vertex 폴백
      _rate.dailyCalls = RATE_LIMIT.RPD;
      logger.warn(`⚠️ AI Studio 429 [${label}] — Vertex AI 폴백 진행`, { component: 'AI_COST' });
      try {
        const { text, inputTokens, outputTokens } = await callVertexUngrounded(systemPrompt, userMessage, opts);
        const costUsd = calcGeminiVertexCost(inputTokens, outputTokens, false);
        _dailyTotals.vertexCalls++;
        _dailyTotals.calls++;
        _dailyTotals.inputTokens += inputTokens;
        _dailyTotals.outputTokens += outputTokens;
        _dailyTotals.totalTokens += inputTokens + outputTokens;
        _dailyTotals.vertexCostUsd += costUsd;
        const durationMs = Date.now() - startMs;
        _recentCalls.push({ label, inputTokens, outputTokens, at: new Date().toISOString(), durationMs, isGrounded: false, costUsd });
        if (_recentCalls.length > 20) _recentCalls.shift();
        logTokenUsage({ provider: 'gemini', model: GROUNDED_MODEL, inputTokens, outputTokens, costUsd, label });
        logger.info(`⚡ Vertex 429-Fallback [${label}]: ${inputTokens}+${outputTokens}tok $${costUsd.toFixed(5)}`, { component: 'AI_COST' });
        return text;
      } catch (vErr) {
        const vMsg = vErr instanceof Error ? vErr.message : String(vErr);
        logger.warn(`⚠️ Vertex 429-폴백도 실패 [${label}]: ${vMsg}`, { component: 'AI_COST' });
        throw new Error(`AI Studio 429 + Vertex 폴백 실패 — ${label}`);
      }
    }
    logger.warn(`⚠️ AI Studio 오류 [${label}]: ${msg}`, { component: 'AI_COST' });
    throw err;
  }
}
