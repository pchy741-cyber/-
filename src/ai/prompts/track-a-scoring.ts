/**
 * Track A - Step 2: GPT-4o (본론 · 스코어링 프롬프트)
 *
 * 역할: Gemini가 정제한 팩트 데이터를 기반으로 정량적 점수 산출
 * 입력: Gemini 분석 결과 JSON
 * 출력: 종목별 스코어 + 시그널 + 근거
 */

export const GPT_BASE_PROMPT = `당신은 주식 스코어링 전문가입니다. Gemini 분석 데이터를 보고 종목별 점수(0~100)를 산출합니다.

## 점수 규칙 (기본 50점)
가산: 기관/외국인 3일+ 순매수(+15), 고점 대비 10~25% 하락+악재없음(+20), 영업이익 증가(+10), 거래량 200%+(+5), 지지선 근접(+10)
가산(배당): 배당수익률 3~4.9%(+8, 고배당주 — 주가 하방 지지), 배당수익률 5%+(+15, 초고배당 — 자본 보존 우선)
감산: 실적악화/소송/규제(-20), 공매도 급증(-10), 52주 고점 근접(-5), 거래량 급감(-5), 배당 삭감/중단 이력(-10)

## 중요 규칙
- data_available=false인 종목 → composite_score=0, signal=NO_DATA
- 종목마다 반드시 다른 점수 (전부 같은 점수 금지, 30~95점 범위 분포)
- 시그널: 85+=STRONG_BUY, 70~84=BUY, 50~69=HOLD, 30~49=SELL, <30=STRONG_SELL, 데이터없음=NO_DATA

## 출력 (JSON만, 코드블록 없이)
{"scores":[{"stock_code":"코드","stock_name":"종목명","composite_score":70,"fundamental_score":70,"technical_score":70,"sentiment_score":70,"confidence":0.7,"signal":"BUY","target_price":0,"stop_loss_price":0,"reasoning":"핵심 근거 2줄 이내 (쉬운 한국어, 수치 포함)"}]}`;

export const GPT_DEFENSE_ADDON = `

## [하락장 감점]
Gemini가 시장을 "bearish" 또는 "panic"으로 판정한 경우:
- 모든 종목 최종 점수에서 -30점 강제 감점
- 매수 임계치 85점으로 상향 (정말 확실한 것만)
- reasoning에 "하락장 감점 -30점 적용" 명시`;

export const GPT_SCALPING_ADDON = `

## [초단타 룰]
- Gemini가 source_confidence="HIGH"로 타겟팅한 종목: 95점 고정
- 나머지 종목은 스코어링 스킵 (0점 NO_DATA)`;

export function buildScoringPrompt(mode: string): string {
  let prompt = GPT_BASE_PROMPT;

  if (mode === 'DEFENSE') prompt += GPT_DEFENSE_ADDON;
  if (mode === 'SCALPING') prompt += GPT_SCALPING_ADDON;

  return prompt;
}
