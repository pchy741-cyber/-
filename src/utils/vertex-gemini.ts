/**
 * Gemini 공통 클라이언트 — AI Studio 전용 (Vertex AI 폴백 제거로 비용 절감)
 * GEMINI_API_KEY: Google AI Studio 키 (gemini-2.5-flash, 1500 RPD 무료)
 */
import { logger } from './logger.js';

const AI_STUDIO_MODEL = 'gemini-2.5-flash';
const AI_STUDIO_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${AI_STUDIO_MODEL}:generateContent`;

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
  label?: string; // 호출 목적 라벨 (비용 추적용)
}

// ── AI 비용 추적 (인메모리, 24시간 롤링) ──
interface TokenUsageEntry {
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
}

const _usageLog: TokenUsageEntry[] = [];
const _dailyTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, resetAt: 0 };

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
    _dailyTotals.resetAt = todayKstMs;
    _usageLog.length = 0;
  }
}

function trackUsage(label: string, meta: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }) {
  resetDailyIfNeeded();
  const entry: TokenUsageEntry = {
    label,
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
    timestamp: Date.now(),
  };
  _usageLog.push(entry);
  _dailyTotals.inputTokens += entry.inputTokens;
  _dailyTotals.outputTokens += entry.outputTokens;
  _dailyTotals.totalTokens += entry.totalTokens;
  _dailyTotals.calls++;

  // 최근 100건만 보관
  if (_usageLog.length > 100) _usageLog.splice(0, _usageLog.length - 50);

  logger.info(
    `💰 Gemini [${label}] in:${entry.inputTokens} out:${entry.outputTokens} total:${entry.totalTokens} | 오늘누적: ${_dailyTotals.totalTokens}토큰 ${_dailyTotals.calls}회`,
    { component: 'AI_COST' },
  );
}

/** 대시보드용 — 오늘 AI 비용 현황 */
export function getAiCostSummary() {
  resetDailyIfNeeded();
  // Gemini 2.5 Flash 무료 티어: 1500 RPD
  // 유료 시 input $0.15/1M, output $0.60/1M (2.5 Flash)
  const inputCost = (_dailyTotals.inputTokens / 1_000_000) * 0.15;
  const outputCost = (_dailyTotals.outputTokens / 1_000_000) * 0.60;
  return {
    model: AI_STUDIO_MODEL,
    today: {
      calls: _dailyTotals.calls,
      inputTokens: _dailyTotals.inputTokens,
      outputTokens: _dailyTotals.outputTokens,
      totalTokens: _dailyTotals.totalTokens,
      estimatedCostUsd: Math.round((inputCost + outputCost) * 10000) / 10000,
      freeTierRemaining: Math.max(0, 1500 - _dailyTotals.calls),
    },
    recentCalls: _usageLog.slice(-10).map(e => ({
      label: e.label,
      tokens: e.totalTokens,
      time: new Date(e.timestamp).toISOString(),
    })),
  };
}

export async function callVertexGemini(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions = {},
): Promise<string> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY 미설정 — AI Studio 키 필요');
  return await callViaAiStudio(geminiKey, systemPrompt, userMessage, opts);
}

async function callViaAiStudio(apiKey: string, systemPrompt: string, userMessage: string, opts: GeminiCallOptions): Promise<string> {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
  };

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

  // 토큰 사용량 추적
  if (data.usageMetadata) {
    trackUsage(opts.label ?? 'unknown', data.usageMetadata);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI Studio 응답 텍스트 없음');
  return text;
}
