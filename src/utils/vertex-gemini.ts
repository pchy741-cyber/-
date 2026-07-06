/**
 * Gemini 공통 클라이언트 — v26 비용 최적화
 *
 * 기본 경로: AI Studio 유료 (gemini-2.5-flash-lite)
 *   - $0.10/1M input + $0.40/1M output (Gemini 최저가)
 *   - thinking 토큰 없음 → 비용 예측 가능
 *   - 유료 한도: 2000 RPM / 1500 RPD
 *   - GEMINI_API_KEY 필수 (결제 활성화된 키)
 *
 * grounded: true → Vertex AI + Google Search Grounding (GCP 크레딧)
 *   - 보유종목 뉴스 / 매크로 이벤트 / SEC 리서치 전용
 *   - 비용: ~$0.035/query + 토큰
 *
 * v26 변경:
 *   - AI Studio 무료 → 유료 flash-lite 전환 (무료 한도 250RPD 초과→Vertex 폴백 제거)
 *   - Track A grounded OFF (RSS로 대체)
 *   - grounded-intel 쿨다운 1h→3h, 매크로 6h→8h
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { VertexAI } from '@google-cloud/vertexai';
import { logger } from './logger.js';
import { logTokenUsage, calcGeminiVertexCost, calcGeminiStudioCost, calcGroqCost } from './ai-token-logger.js';

// ── 모델 설정 ──
const STUDIO_MODEL = 'gemini-2.5-flash-lite';    // AI Studio 유료 — Gemini 최저가 ($0.10/$0.40 per 1M)
const VERTEX_MODEL = 'gemini-2.0-flash';          // Vertex 비그라운딩 폴백 — thinking 없음
const GROUNDED_MODEL = 'gemini-2.5-flash';        // Vertex 그라운딩 전용 — 검색 해석 품질 필요
const VERTEX_LOCATION = 'us-central1';

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
  label?: string;
  grounded?: boolean;   // true → Vertex AI + Google Search Grounding (GCP 크레딧)
  useVertex?: boolean;  // true → Vertex AI 직접 사용 (GCP 크레딧, grounding 없음)
  paid?: boolean;       // (deprecated) 항상 유료 — 호환성 유지용
}

// ── 레이트 리미터: AI Studio 유료 한도 (안전가드) ──
const RATE_LIMIT = {
  RPM: 2000,
  RPD: 1500,
} as const;

interface RateState {
  minuteSlots: number[];
  dailyCalls: number;
  dailyResetAt: number;
}

const _rate: RateState = {
  minuteSlots: [],
  dailyCalls: 0,
  dailyResetAt: 0,
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
    _dailyTotals.studioCostUsd = 0;
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

function recordCall(): void {
  _rate.minuteSlots.push(Date.now());
  _rate.dailyCalls++;
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
  studioCostUsd: 0,
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
  const totalCostUsd = _dailyTotals.studioCostUsd + _dailyTotals.vertexCostUsd;
  return {
    model: `AI Studio Paid (${STUDIO_MODEL}) + Vertex Grounded (${GROUNDED_MODEL})`,
    today: {
      calls: _dailyTotals.calls,
      vertexCalls: _dailyTotals.vertexCalls,
      studioCalls: _dailyTotals.studioCalls,
      inputTokens: _dailyTotals.inputTokens,
      outputTokens: _dailyTotals.outputTokens,
      totalTokens: _dailyTotals.totalTokens,
      estimatedCostUsd: totalCostUsd,
      vertexDailyBudgetUsd: 5.0,
      vertexDailySpentUsd: _dailyTotals.vertexCostUsd,
      studioCostUsd: _dailyTotals.studioCostUsd,
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
  if (!key) throw new Error('GEMINI_API_KEY 미설정 — 결제 활성화된 AI Studio 키 필요 (https://aistudio.google.com/apikey)');
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
 * AI Studio 429 시 비상 폴백용
 */
async function callVertexUngrounded(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const vertexAI = getVertexAI();
  const model = vertexAI.getGenerativeModel({
    model: VERTEX_MODEL,
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
 * 보유종목뉴스 / 매크로이벤트 / SEC리서치 전용
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
    tools: [{ googleSearch: {} } as any],
  });

  const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: userMessage }] }] });
  const response = result.response;
  const finishReason = response.candidates?.[0]?.finishReason;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    throw new Error(`Vertex Grounded: 빈 응답 (finishReason=${finishReason ?? 'unknown'}) — Studio fallback`);
  }
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return { text, inputTokens, outputTokens };
}

/**
 * Gemini 호출 — v26 비용 최적화 라우팅
 *
 * 1. grounded: true  → Vertex AI + Google Search (GCP 크레딧)
 * 2. useVertex: true  → Vertex AI 직접 (GCP 크레딧)
 * 3. 기본             → AI Studio 유료 flash-lite ($0.10/$0.40)
 * 4. Studio 429       → Vertex 비상 폴백
 */
export async function callVertexGemini(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions = {},
): Promise<string> {
  const label = opts.label ?? 'unknown';
  const startMs = Date.now();

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
      logTokenUsage({ provider: 'gemini', model: VERTEX_MODEL, inputTokens, outputTokens, costUsd, label });
      logger.info(`⚡ Vertex Direct [${label}]: ${inputTokens}+${outputTokens}tok $${costUsd.toFixed(5)} (${VERTEX_MODEL})`, { component: 'AI_COST' });
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️ Vertex Direct 실패 [${label}], Studio fallback: ${msg}`, { component: 'AI_COST' });
      // fall through to Studio
    }
  }

  // ── grounded: true → Vertex AI + Google Search ──
  if (opts.grounded) {
    try {
      const { text, inputTokens, outputTokens } = await callVertexGrounded(systemPrompt, userMessage, opts);
      const durationMs = Date.now() - startMs;
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
      logger.warn(`⚠️ Vertex Grounding 실패 [${label}], Studio fallback: ${msg}`, { component: 'AI_COST' });
      // fall through to Studio (grounded 없이)
    }
  }

  // ── AI Studio 유료 경로 (gemini-2.5-flash-lite) ──
  const rateCheck = checkRateLimit();
  if (!rateCheck.ok && rateCheck.waitMs > 0) {
    logger.info(`⏳ Studio RPM 대기 ${Math.ceil(rateCheck.waitMs / 1000)}초 [${label}]`, { component: 'AI_COST' });
    await new Promise((r) => setTimeout(r, rateCheck.waitMs));
  }

  if (!rateCheck.ok && rateCheck.waitMs === 0) {
    // RPD 소진 (1500콜 초과 — 거의 불가) → Vertex 비상 폴백
    logger.warn(`⚡ Studio RPD 소진 [${label}] → Vertex 비상 폴백`, { component: 'AI_COST' });
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
      logTokenUsage({ provider: 'gemini', model: VERTEX_MODEL, inputTokens, outputTokens, costUsd, label });
      return text;
    } catch (vErr) {
      // v27: Gemini 전면 장애 → Groq/NVIDIA 3차 폴백
      logger.warn(`⚠️ Studio RPD 초과 + Vertex 실패 [${label}] → Groq/NVIDIA 3차 폴백`, { component: 'AI_COST' });
      return callLlmEmergencyFallback(systemPrompt, userMessage, opts, label, startMs);
    }
  }

  try {
    const client = getStudioClient();
    const model = client.getGenerativeModel({
      model: STUDIO_MODEL,
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
    recordCall();

    const costUsd = calcGeminiStudioCost(inTok, outTok);
    _dailyTotals.inputTokens += inTok;
    _dailyTotals.outputTokens += outTok;
    _dailyTotals.totalTokens += inTok + outTok;
    _dailyTotals.calls++;
    _dailyTotals.studioCalls++;
    _dailyTotals.studioCostUsd += costUsd;

    const durationMs = Date.now() - startMs;
    _recentCalls.push({ label, inputTokens: inTok, outputTokens: outTok, at: new Date().toISOString(), durationMs, isGrounded: false, costUsd });
    if (_recentCalls.length > 20) _recentCalls.shift();
    logTokenUsage({ provider: 'gemini', model: STUDIO_MODEL, inputTokens: inTok, outputTokens: outTok, costUsd, label });

    logger.info(
      `🤖 Studio [${label}]: ${inTok}+${outTok}tok ${durationMs}ms $${costUsd.toFixed(5)} (${_rate.dailyCalls}/${RATE_LIMIT.RPD} RPD)`,
      { component: 'AI_COST' },
    );
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      logger.warn(`⚠️ Studio 429 [${label}] — Vertex 비상 폴백`, { component: 'AI_COST' });
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
        logTokenUsage({ provider: 'gemini', model: VERTEX_MODEL, inputTokens, outputTokens, costUsd, label });
        return text;
      } catch (vErr) {
        // v27: Gemini 전면 장애 → Groq/NVIDIA 3차 폴백 (무료 쿼터 소진 시 거래 중단 방지)
        logger.warn(`⚠️ Studio 429 + Vertex 실패 [${label}] → Groq/NVIDIA 3차 폴백`, { component: 'AI_COST' });
        return callLlmEmergencyFallback(systemPrompt, userMessage, opts, label, startMs);
      }
    }
    logger.warn(`⚠️ Studio 오류 [${label}]: ${msg}`, { component: 'AI_COST' });
    throw err;
  }
}

/**
 * v27: Gemini 전면 장애 비상 폴백 — Groq → NVIDIA NIM
 * Studio 429 + Vertex 실패 시 최후 수단 (거래 중단 방지)
 * 토큰 최적화: systemPrompt 2000자 + userMessage 4000자 제한
 */
async function callLlmEmergencyFallback(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions,
  label: string,
  startMs: number,
): Promise<string> {
  // 토큰 최적화 — 프롬프트 압축 (비상 폴백은 입력 최소화)
  const sysCompact = systemPrompt.length > 2000 ? systemPrompt.slice(0, 2000) + '\n…(truncated)' : systemPrompt;
  const userCompact = userMessage.length > 4000 ? userMessage.slice(0, 4000) + '\n…(truncated)' : userMessage;
  const maxTokens = Math.min(opts.maxOutputTokens ?? 4096, 4096);

  // 1차: Groq (llama-3.3-70b)
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const groq = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' });
      const resp = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: sysCompact },
          { role: 'user', content: userCompact },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: maxTokens,
      });
      const text = resp.choices[0]?.message?.content ?? '';
      const inTok = resp.usage?.prompt_tokens ?? 0;
      const outTok = resp.usage?.completion_tokens ?? 0;
      const costUsd = calcGroqCost(inTok, outTok);
      const durationMs = Date.now() - startMs;
      logTokenUsage({ provider: 'groq', model: 'llama-3.3-70b', inputTokens: inTok, outputTokens: outTok, costUsd, label: `${label}(비상폴백)` });
      logger.info(`🆘 Groq 비상폴백 [${label}]: ${inTok}+${outTok}tok ${durationMs}ms $${costUsd.toFixed(5)}`, { component: 'AI_COST' });
      return text;
    } catch (groqErr) {
      logger.warn(`⚠️ Groq 비상폴백 실패 [${label}]: ${groqErr instanceof Error ? groqErr.message : groqErr}`, { component: 'AI_COST' });
    }
  }

  // 2차: NVIDIA NIM (무료)
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (nvidiaKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const nvidia = new OpenAI({ apiKey: nvidiaKey, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const resp = await nvidia.chat.completions.create({
        model: 'meta/llama-3.3-70b-instruct',
        messages: [
          { role: 'system', content: sysCompact },
          { role: 'user', content: userCompact },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: maxTokens,
      });
      const text = resp.choices[0]?.message?.content ?? '';
      const inTok = resp.usage?.prompt_tokens ?? 0;
      const outTok = resp.usage?.completion_tokens ?? 0;
      const durationMs = Date.now() - startMs;
      logTokenUsage({ provider: 'nvidia', model: 'llama-3.3-70b', inputTokens: inTok, outputTokens: outTok, costUsd: 0, label: `${label}(비상폴백)` });
      logger.info(`🆘 NVIDIA 비상폴백 [${label}]: ${inTok}+${outTok}tok ${durationMs}ms (무료)`, { component: 'AI_COST' });
      return text;
    } catch (nvErr) {
      logger.warn(`⚠️ NVIDIA 비상폴백 실패 [${label}]: ${nvErr instanceof Error ? nvErr.message : nvErr}`, { component: 'AI_COST' });
    }
  }

  throw new Error(`Gemini + Groq + NVIDIA 전체 장애 — ${label}`);
}
