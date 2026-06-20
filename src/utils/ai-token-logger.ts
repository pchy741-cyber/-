/**
 * AI 토큰 사용량 중앙 로거
 * - fire-and-forget DB insert (매매 로직 영향 없음)
 * - 배치 버퍼: 최대 10건 모아서 한번에 INSERT
 * - 에러 시 로그만 찍고 무시
 */
import { safeQuery } from '../db/pool.js';
import { logger } from './logger.js';

const COMP = 'AI_TOKEN';

export interface TokenUsageEntry {
  provider: 'gemini' | 'gpt' | 'claude-api' | 'claude-cli' | 'groq';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  label?: string;
  isPaper?: boolean;
}

// ── 비용 계산 헬퍼 ──

/** Gemini Vertex AI: $0.10/1M input + $0.40/1M output */
export function calcGeminiVertexCost(inputTokens: number, outputTokens: number, grounded = false): number {
  const base = (inputTokens / 1_000_000) * 0.10 + (outputTokens / 1_000_000) * 0.40;
  return grounded ? base + 0.035 : base;
}

/** Gemini AI Studio: 무료 티어 → $0 */
export function calcGeminiStudioCost(): number {
  return 0;
}

/** GPT-4o-mini: $0.15/1M input + $0.60/1M output */
export function calcGptCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.60;
}

/** Claude Haiku 4.5 API: $0.80/1M input + $4.00/1M output */
export function calcClaudeApiCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 0.80 + (outputTokens / 1_000_000) * 4.00;
}

/** Claude CLI (Sonnet) 월정액: 일할 $100/30 ≈ $3.33/day — 호출수 비례 배분 */
const CLAUDE_CLI_DAILY_COST = 100 / 30;
let _cliCallsToday = 0;
let _cliDayKey = '';

export function calcClaudeCliCost(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (_cliDayKey !== today) {
    _cliCallsToday = 0;
    _cliDayKey = today;
  }
  _cliCallsToday++;
  return CLAUDE_CLI_DAILY_COST / _cliCallsToday; // 호출 추가 시 이전 호출 비용도 재분배됨 — 일별 총합은 항상 $3.33
}

/** Groq (llama-3.3-70b): $0.59/1M input + $0.79/1M output */
export function calcGroqCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 0.59 + (outputTokens / 1_000_000) * 0.79;
}

// ── 배치 버퍼 ──

const BATCH_MAX = 10;
const FLUSH_INTERVAL_MS = 30_000; // 30초마다 강제 flush

let _buffer: TokenUsageEntry[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function startFlushTimer(): void {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

async function flushBuffer(): Promise<void> {
  if (_buffer.length === 0) return;
  const batch = _buffer.splice(0);

  try {
    // 다중 INSERT
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const e of batch) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      values.push(e.provider, e.model, e.inputTokens, e.outputTokens, e.costUsd, 1, e.label ?? null, e.isPaper ?? false);
    }

    await safeQuery(
      `INSERT INTO ai_token_usage (provider, model, input_tokens, output_tokens, cost_usd, call_count, label, is_paper)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  } catch (err) {
    logger.warn(`AI 토큰 로깅 실패 (${batch.length}건 손실): ${err}`, { component: COMP });
  }
}

/**
 * 토큰 사용량 기록 (fire-and-forget)
 * 매매 로직에 절대 영향 없음 — 에러 시 무시
 */
export function logTokenUsage(entry: TokenUsageEntry): void {
  _buffer.push(entry);
  startFlushTimer();
  if (_buffer.length >= BATCH_MAX) {
    flushBuffer();
  }
}

/** 프로세스 종료 전 남은 버퍼 flush */
export async function flushTokenBuffer(): Promise<void> {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await flushBuffer();
}
