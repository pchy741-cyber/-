/**
 * Gemini 공통 클라이언트 — AI Studio 전용 (Vertex AI 폴백 제거로 비용 절감)
 * GEMINI_API_KEY: Google AI Studio 키 (gemini-2.0-flash, 1500 RPD 무료)
 */

const AI_STUDIO_MODEL = 'gemini-2.0-flash-lite';
const AI_STUDIO_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${AI_STUDIO_MODEL}:generateContent`;

export interface GeminiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
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
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI Studio 응답 텍스트 없음');
  return text;
}
