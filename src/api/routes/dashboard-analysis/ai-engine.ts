import { Hono } from 'hono';
import { getAiStatus } from '../../../cache/ai-status.js';
import { logger } from '../../../utils/logger.js';

export const aiEngineRoutes = new Hono();

// ── AI 엔진 상태 ──
aiEngineRoutes.get('/ai-status', (c) => {
  return c.json(getAiStatus());
});

// ── Vertex AI 직접 연결 테스트 ──
aiEngineRoutes.get('/ai/gemini-test', async (c) => {
  const start = Date.now();
  const TEST_MODEL = 'gemini-2.0-flash-lite (AI Studio)';
  try {
    const { callVertexGemini: callTest } = await import('../../../utils/vertex-gemini.js');
    const text = await Promise.race([
      callTest('You are a test assistant.', 'Reply with exactly one word: OK'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout_10s')), 10000)),
    ]);
    const latencyMs = Date.now() - start;
    return c.json({
      ok: !!text,
      latencyMs,
      model: TEST_MODEL,
      error: null,
      errorDetail: null,
      rawError: '',
      response: text?.slice(0, 50),
    });
  } catch (err) {
    const errStr = String(err);
    const latencyMs = Date.now() - start;
    let error = 'unknown';
    let errorDetail = '원인 불명 — 로그를 확인하세요';
    const rawError = errStr.slice(0, 300);

    if (errStr.includes('timeout')) {
      error = 'timeout';
      errorDetail = '10초 내 응답 없음 — Cloud Run 네트워크 또는 Gemini 서버 과부하';
    } else if (
      errStr.includes('429') ||
      errStr.includes('quota') ||
      errStr.includes('RESOURCE_EXHAUSTED') ||
      errStr.includes('Resource has been exhausted')
    ) {
      error = 'quota';
      errorDetail = '무료 할당량 초과 (429) — Google AI Studio에서 사용량 확인 후 내일 재시도';
    } else if (
      (errStr.includes('400') && (errStr.includes('API key') || errStr.includes('API_KEY'))) ||
      errStr.includes('INVALID_ARGUMENT')
    ) {
      error = 'invalid_key';
      errorDetail = 'API 키가 유효하지 않습니다 — 설정에서 키를 재발급하세요';
    } else if (errStr.includes('404') || errStr.includes('NOT_FOUND')) {
      error = 'model_not_found';
      errorDetail = `모델 없음 (404) — ${TEST_MODEL} 접근 불가`;
    } else if (errStr.includes('403') || errStr.includes('PERMISSION_DENIED')) {
      error = 'permission';
      errorDetail = '접근 권한 없음 (403) — API 키 허용 범위 확인 필요';
    } else if (errStr.includes('503') || errStr.includes('UNAVAILABLE')) {
      error = 'unavailable';
      errorDetail = 'Gemini 서비스 일시 불가 (503) — 잠시 후 재시도';
    }

    logger.warn('Gemini 연결 테스트 실패', { error, rawError, component: 'GEMINI_TEST' });
    return c.json({ ok: false, latencyMs, model: TEST_MODEL, error, errorDetail });
  }
});
