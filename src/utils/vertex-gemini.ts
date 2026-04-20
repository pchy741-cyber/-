/**
 * Vertex AI Gemini 공통 클라이언트
 * Cloud Run 서비스 계정으로 자동 인증 → AI Studio API 키/spending cap 불필요
 */
import { GoogleAuth } from 'google-auth-library';

const PROJECT_ID = 'quantops-trading';
const LOCATION = 'us-central1';
const MODEL = 'gemini-2.0-flash';
const ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

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

  const response = await fetch(ENDPOINT, {
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
