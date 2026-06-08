/**
 * Gemini 공통 클라이언트 — AI Studio 무료 티어 전용 (비용 $0)
 *
 * 2026-06: Vertex AI (유료) → AI Studio (무료) 전환
 *   - Gemini 2.5 Flash 무료: 10 RPM / 250 RPD / 250K TPM
 *   - 일 ~20콜 사용 → 250 RPD의 8% — 여유 충분
 *   - GEMINI_API_KEY (AI Studio 키) 필수, 없으면 즉시 실패 → fallback 동작
 *   - Vertex AI 인증/과금 완전 제거 (GoogleAuth import 없음)
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';

// ── AI Studio 모델 (무료 티어) ──
const FREE_MODEL = 'gemini-2.5-flash';

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
  label?: string;
  grounded?: boolean; // AI Studio 무료에서는 Google Search grounding 미지원 — 무시
}

// ── 레이트 리미터: 무료 티어 한도 준수 ──
const RATE_LIMIT = {
  RPM: 10,        // 분당 10건
  RPD: 250,       // 일 250건
  TPM: 250_000,   // 분당 25만 토큰
} as const;

interface RateState {
  minuteSlots: number[];    // 최근 1분 호출 타임스탬프
  dailyCalls: number;       // 오늘 호출 수
  dailyResetAt: number;     // 일 리셋 시각 (midnight PT)
  minuteTokens: number[];   // 최근 1분 토큰 사용 [{ts, tokens}]
}

const _rate: RateState = {
  minuteSlots: [],
  dailyCalls: 0,
  dailyResetAt: 0,
  minuteTokens: [],
};

function resetDailyIfNeeded(): void {
  const now = Date.now();
  // midnight Pacific Time 기준 리셋 (UTC-7 → +7h offset)
  const todayMidnightPT = new Date().setUTCHours(7, 0, 0, 0);
  if (_rate.dailyResetAt < todayMidnightPT) {
    _rate.dailyCalls = 0;
    _rate.dailyResetAt = todayMidnightPT;
    _dailyTotals.inputTokens = 0;
    _dailyTotals.outputTokens = 0;
    _dailyTotals.totalTokens = 0;
    _dailyTotals.calls = 0;
    _dailyTotals.studioCalls = 0;
    _recentCalls.length = 0;
  }
}

function checkRateLimit(): { ok: boolean; waitMs: number; reason: string } {
  resetDailyIfNeeded();
  const now = Date.now();

  // RPD 체크
  if (_rate.dailyCalls >= RATE_LIMIT.RPD) {
    return { ok: false, waitMs: 0, reason: `일 한도 초과 (${_rate.dailyCalls}/${RATE_LIMIT.RPD} RPD)` };
  }

  // RPM 체크
  _rate.minuteSlots = _rate.minuteSlots.filter(t => now - t < 60_000);
  if (_rate.minuteSlots.length >= RATE_LIMIT.RPM) {
    const waitMs = 60_000 - (now - _rate.minuteSlots[0]) + 100;
    return { ok: false, waitMs, reason: `분당 한도 (${_rate.minuteSlots.length}/${RATE_LIMIT.RPM} RPM)` };
  }

  return { ok: true, waitMs: 0, reason: '' };
}

function recordCall(tokens: number): void {
  const now = Date.now();
  _rate.minuteSlots.push(now);
  _rate.dailyCalls++;
  _rate.minuteTokens.push(now);
}

// ── AI 비용 추적 (대시보드용) ──
const _dailyTotals = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  calls: 0, vertexCalls: 0, studioCalls: 0,
};

interface CallRecord {
  label: string;
  inputTokens: number;
  outputTokens: number;
  at: string;
  durationMs: number;
}
const _recentCalls: CallRecord[] = [];

/** 대시보드용 — 오늘 AI 사용 현황 (비용 $0) */
export function getAiCostSummary() {
  resetDailyIfNeeded();
  return {
    model: `AI Studio FREE (${FREE_MODEL})`,
    today: {
      calls: _dailyTotals.calls,
      vertexCalls: 0,
      studioCalls: _dailyTotals.studioCalls,
      inputTokens: _dailyTotals.inputTokens,
      outputTokens: _dailyTotals.outputTokens,
      totalTokens: _dailyTotals.totalTokens,
      estimatedCostUsd: 0,  // 무료 티어 → 항상 $0
      vertexDailyBudgetUsd: 0,
      vertexDailySpentUsd: 0,
      vertexAvailable: false,
      studioCallsUsed: _rate.dailyCalls,
      studioCallsMax: RATE_LIMIT.RPD,
    },
    recentCalls: _recentCalls.slice(-10),
    disabledReason: null,
  };
}

// ── 싱글톤 클라이언트 (lazy init) ──
let _genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (_genAI) return _genAI;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 미설정 — AI Studio 무료 키 필요 (https://aistudio.google.com/apikey)');
  _genAI = new GoogleGenerativeAI(key);
  return _genAI;
}

/**
 * Gemini AI Studio 호출 (무료 티어, 비용 $0)
 * - 레이트 리미터: 10 RPM / 250 RPD 자동 관리
 * - RPM 초과 시 자동 대기 (최대 60초)
 * - RPD 초과 시 즉시 에러 → fallback 동작
 */
export async function callVertexGemini(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions = {},
): Promise<string> {
  const label = opts.label ?? 'unknown';
  const startMs = Date.now();

  // 레이트 리미트 체크
  let rateCheck = checkRateLimit();
  if (!rateCheck.ok && rateCheck.waitMs > 0) {
    logger.info(`⏳ AI Studio RPM 대기 ${Math.ceil(rateCheck.waitMs / 1000)}초 [${label}]`, { component: 'AI_COST' });
    await new Promise(r => setTimeout(r, rateCheck.waitMs));
    rateCheck = checkRateLimit();
  }
  if (!rateCheck.ok) {
    logger.warn(`🚫 AI Studio 한도 초과 [${label}]: ${rateCheck.reason}`, { component: 'AI_COST' });
    throw new Error(`AI Studio 한도 초과 — ${rateCheck.reason}`);
  }

  try {
    const client = getClient();
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

    // 토큰 사용량 기록
    const usage = response.usageMetadata;
    const inTok = usage?.promptTokenCount ?? 0;
    const outTok = usage?.candidatesTokenCount ?? 0;
    recordCall(inTok + outTok);

    _dailyTotals.inputTokens += inTok;
    _dailyTotals.outputTokens += outTok;
    _dailyTotals.totalTokens += inTok + outTok;
    _dailyTotals.calls++;
    _dailyTotals.studioCalls++;

    const durationMs = Date.now() - startMs;
    _recentCalls.push({ label, inputTokens: inTok, outputTokens: outTok, at: new Date().toISOString(), durationMs });
    if (_recentCalls.length > 20) _recentCalls.shift();

    logger.info(
      `🤖 AI Studio [${label}]: ${inTok}+${outTok}tok ${durationMs}ms (${_rate.dailyCalls}/${RATE_LIMIT.RPD} RPD) — $0`,
      { component: 'AI_COST' },
    );

    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 429 = rate limit exceeded → 호출 측 fallback
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      logger.warn(`⚠️ AI Studio 429 [${label}] — 무료 티어 한도 도달`, { component: 'AI_COST' });
      throw new Error(`AI Studio 429 — ${label} (무료 한도)`);
    }
    logger.warn(`⚠️ AI Studio 오류 [${label}]: ${msg}`, { component: 'AI_COST' });
    throw err;
  }
}
