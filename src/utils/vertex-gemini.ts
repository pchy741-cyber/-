/**
 * Gemini 공통 클라이언트
 * 1순위: Vertex AI (Cloud Run 서비스 계정 자동 인증, 할당량 없음)
 * 2순위: Google AI Studio 무료 키 (GEMINI_API_KEY 환경변수)
 */
import { GoogleAuth } from 'google-auth-library';

const PROJECT_ID = 'quantops-trading';
const LOCATION = 'us-central1';
const VERTEX_MODEL = 'gemini-2.0-flash';
const VERTEX_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
const AI_STUDIO_MODEL = 'gemini-2.0-flash';
const AI_STUDIO_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${AI_STUDIO_MODEL}:generateContent`;

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

export async function callVertexGemini(
  systemPrompt: string,
  userMessage: string,
  opts: GeminiCallOptions = {},
): Promise<string> {
  // 1순위: Vertex AI
  try {
    return await callViaVertex(systemPrompt, userMessage, opts);
  } catch (vertexErr) {
    const errStr = String(vertexErr);
    // 할당량/권한 오류 시 AI Studio 무료 키로 fallback
    if (errStr.includes('429') || errStr.includes('quota') || errStr.includes('RESOURCE_EXHAUSTED')) {
      const freeKey = process.env.GEMINI_API_KEY ?? '';
      if (freeKey && freeKey.length > 10 && !freeKey.startsWith('your_')) {
        return await callViaAiStudio(freeKey, systemPrompt, userMessage, opts);
      }
    }
    throw vertexErr;
  }
}

async function callViaVertex(systemPrompt: string, userMessage: string, opts: GeminiCallOptions): Promise<string> {
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token;
  if (!accessToken) throw new Error('Vertex AI 인증 토큰 없음');

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
  };

  const response = await fetch(VERTEX_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Vertex AI ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex AI 응답 텍스트 없음');
  return text;
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
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI Studio 응답 텍스트 없음');
  return text;
}
