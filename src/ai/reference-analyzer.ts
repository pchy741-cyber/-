/**
 * Trading Reference Analyzer
 *
 * 사용자가 등록한 레퍼런스(커뮤니티 캡쳐, 인플루언서 글, 뉴스)를
 * AI로 분석 → 종목별 scoreAdj / forceHold / blacklist 액션 추출.
 *
 * 등록 시 1회만 호출 → 루프마다 재분석 X → 비용 $0/loop.
 */

import { logger } from '../utils/logger.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';

const AI_STUDIO_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

export interface RefAction {
  code: string;
  action: 'scoreAdj' | 'forceHold' | 'blacklist';
  value: number | boolean;
  reason: string;
}

export interface ReferenceAnalysis {
  stockCodes: string[];
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  actions: RefAction[];
  summary: string;
}

const SYSTEM_PROMPT = `당신은 주식 트레이딩 레퍼런스 분석 전문가입니다.
사용자가 신뢰하는 인플루언서/커뮤니티/뉴스에서 가져온 트레이딩 인사이트를 분석합니다.

분석 규칙:
1. 텍스트/이미지에서 언급된 종목을 추출 (국내: 6자리 코드 or 종목명→코드, 해외: 티커)
2. 전체 sentiment: BULLISH(매수 추천) / BEARISH(매도 추천) / NEUTRAL(불분명)
3. confidence: 0-100 (명확한 종목+근거=높게, 모호하면 낮게. 60 미만이면 NEUTRAL 강제)
4. 종목별 action 제안:
   - scoreAdj: AI 점수 보정 (-8 ~ +8 범위 엄수! 황금비율=보조적 영향만)
   - forceHold: 실적발표/이벤트 대기 시 매도 보류 (true)
   - blacklist: 위험 경고 시 매수 차단 (true)
5. 과도한 확신 금지. 인플루언서 추천이라도 scoreAdj는 최대 ±8.

국내 주요 종목 코드 참고:
삼성전자=005930, SK하이닉스=000660, LG에너지솔루션=373220, 삼성바이오로직스=207940,
현대차=005380, 기아=000270, 셀트리온=068270, KB금융=105560, 신한지주=055550,
NAVER=035420, 카카오=035720, 삼성SDI=006400, POSCO홀딩스=005490, LG화학=051910,
한화에어로스페이스=012450, HD현대중공업=329180, 두산에너빌리티=034020, HLB=028300

반드시 JSON만 반환 (설명 없이):
{"stockCodes":["005930","NVDA"],"sentiment":"BULLISH","confidence":75,"actions":[{"code":"005930","action":"scoreAdj","value":5,"reason":"인플루언서 강매수 의견, 실적 서프라이즈 예상"},{"code":"NVDA","action":"scoreAdj","value":6,"reason":"AI 수요 급증 전망"}],"summary":"삼성전자/NVDA 강세 전망. 실적+AI 수요 근거 충분."}

종목이 없거나 불분명하면:
{"stockCodes":[],"sentiment":"NEUTRAL","confidence":0,"actions":[],"summary":"명확한 종목 신호를 찾을 수 없습니다."}`;

function parseAnalysis(text: string): ReferenceAnalysis {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON 파싱 실패');
  const parsed = JSON.parse(jsonMatch[0]);

  // 안전 검증
  const sentiment = ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(parsed.sentiment) ? parsed.sentiment : 'NEUTRAL';
  const confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
  const actions: RefAction[] = (parsed.actions ?? [])
    .map((a: any) => ({
      code: String(a.code ?? ''),
      action: ['scoreAdj', 'forceHold', 'blacklist'].includes(a.action) ? a.action : 'scoreAdj',
      value: a.action === 'scoreAdj' ? Math.max(-8, Math.min(8, Number(a.value) || 0)) : !!a.value,
      reason: String(a.reason ?? '').slice(0, 200),
    }))
    .filter((a: RefAction) => a.code);

  return {
    stockCodes: (parsed.stockCodes ?? []).map(String).filter(Boolean),
    sentiment: confidence < 60 ? 'NEUTRAL' : sentiment,
    confidence,
    actions,
    summary: String(parsed.summary ?? '').slice(0, 300),
  };
}

/** 텍스트 레퍼런스 분석 */
export async function analyzeTextReference(content: string): Promise<ReferenceAnalysis> {
  const { config } = await import('../config/index.js');
  if (!config.geminiEnabled) throw new Error('Gemini OFF — 레퍼런스 분석 불가');
  logger.info(`[Reference] 텍스트 분석 시작 (${content.length}자)`, { component: 'REFERENCE' });
  const response = await callVertexGemini(SYSTEM_PROMPT, content, { maxOutputTokens: 1024, label: 'reference-text' });
  return parseAnalysis(response);
}

/** 이미지 레퍼런스 분석 (텍스트 + 이미지) */
export async function analyzeImageReference(
  content: string,
  imageBase64: string,
  mimeType: string,
): Promise<ReferenceAnalysis> {
  const { config } = await import('../config/index.js');
  if (!config.geminiEnabled) throw new Error('Gemini OFF — 이미지 분석 불가');
  logger.info(`[Reference] 이미지 분석 시작`, { component: 'REFERENCE' });

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY 미설정');

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${SYSTEM_PROMPT}\n\n사용자 메모: ${content || '(없음)'}` },
          { inlineData: { mimeType, data: imageBase64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0.05, maxOutputTokens: 1024 },
  };

  const res = await fetch(`${AI_STUDIO_ENDPOINT}?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI Studio ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('AI 응답 없음');

  return parseAnalysis(text);
}
