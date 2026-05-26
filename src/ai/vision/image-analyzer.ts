import { logger } from '../../utils/logger.js';

const AI_STUDIO_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;

export interface VisionScalpSignal {
  ticker: string;
  exchange: 'NASDAQ' | 'NYSE' | 'AMEX';
  direction: 'BUY' | 'HOLD';
  confidence: number;
  reasoning: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

const SYSTEM_PROMPT = `당신은 미국 주식 단타 트레이딩 전문가입니다.
이 이미지는 신뢰할 수 있는 투자 전문가 또는 커뮤니티 멤버가 공유한 미국 주식 추천 포스트/메시지/차트입니다.

다음을 분석하세요:
1. 어떤 미국 주식 티커(ticker symbol)를 추천하는가? (예: TSLA, NVDA, AAPL, PLTR, SOFI 등)
2. 방향: BUY(매수 추천) 또는 HOLD(신호 불명확)
3. 신뢰도: 0-100점 (명확한 티커+근거 있으면 높게, 모호하면 낮게)
4. 이유: 한국어 2-3문장으로 간단히
5. 리스크 레벨: LOW(안정) / MEDIUM(보통) / HIGH(위험)

반드시 JSON만 반환하세요 (설명 없이):
{"ticker":"TSLA","exchange":"NASDAQ","direction":"BUY","confidence":82,"reasoning":"전문가가 TSLA 기술적 돌파 신호 언급. 거래량 급증과 함께 저항선 돌파 예상. 단기 2-3% 수익 목표.","riskLevel":"MEDIUM"}

주의:
- 미국 주식이 아니거나 티커가 불분명하면: {"ticker":"","exchange":"NASDAQ","direction":"HOLD","confidence":0,"reasoning":"명확한 미국 주식 신호를 찾을 수 없습니다.","riskLevel":"HIGH"}
- exchange는 NASDAQ/NYSE/AMEX 중 하나 (불확실하면 NASDAQ)
- 소형주/저유동성 종목이면 riskLevel=HIGH 설정`;

function parseVisionResponse(text: string): VisionScalpSignal {
  logger.info(`[VisionScalp] 응답: ${text.slice(0, 300)}`, { component: 'VISION' });
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error('JSON 파싱 실패');
  const parsed = JSON.parse(jsonMatch[0]) as VisionScalpSignal;
  parsed.exchange = (['NASDAQ', 'NYSE', 'AMEX'].includes(parsed.exchange) ? parsed.exchange : 'NASDAQ') as VisionScalpSignal['exchange'];
  parsed.direction = parsed.direction === 'BUY' ? 'BUY' : 'HOLD';
  parsed.confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
  return parsed;
}

async function callAiStudioVision(apiKey: string, imageBase64: string, mimeType: string): Promise<VisionScalpSignal> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: SYSTEM_PROMPT }, { inlineData: { mimeType, data: imageBase64 } }] }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 512 },
  };
  const res = await fetch(`${AI_STUDIO_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI Studio ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('AI Studio 응답 없음');
  return parseVisionResponse(text);
}

export async function analyzeImageForScalp(imageBase64: string, mimeType: string): Promise<VisionScalpSignal> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY 미설정 — AI Studio 키 필요');
  return await callAiStudioVision(geminiKey, imageBase64, mimeType);
}
