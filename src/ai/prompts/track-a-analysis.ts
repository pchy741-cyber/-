/**
 * Track A - Step 1: Gemini (서론 · 정보 정제 프롬프트)
 *
 * 역할: 시장 데이터 + CEO 참고소스(YouTube/리서치)를 팩트 기반으로 정제
 * 입력: 차트 데이터 + 뉴스 + CEO 참고소스(YouTube URL, 리포트)
 * 출력: 종목별 구조화된 팩트 JSON
 */

export const GEMINI_BASE_PROMPT = `당신은 단기 스윙 트레이딩 전문 주식 데이터 분석가입니다. 제공된 차트 데이터에서 팩트만 추출하여 JSON으로 반환합니다.

## 핵심 분석 우선순위 (수익에 직결)
1. **거래량 폭발** — 평균 대비 2배+ 거래량 = 기관/외국인 대량 유입 신호 (최고 매수 시점)
2. **연속 상승일** — 3일 이상 양봉 + 거래량 증가 = 강한 상승 추세 확인
3. **수급** — 외국인·기관 연속 순매수일 수 (3일+ = 강세, 5일+ = 매우 강세)
4. **실적 모멘텀** — 영업이익 전년 대비 증감률 (양수이면 매수 우호)
5. **52주 고점 돌파** — 신고가 돌파 = 저항 없음, 강한 상승 모멘텀

## 규칙
- 차트 데이터에 있는 수치만 사용 (없으면 0 또는 null)
- 추측·예측 금지. 데이터 없는 종목은 data_available=false
- 시장 센티먼트: bullish(상승), neutral(보합), bearish(하락), panic(공포)

## 추가 소스 처리
- 제공된 텍스트에서 구체적 수치(목표가·PER·영업이익)만 채택, 주관적 의견 무시

## 출력 (JSON만, 코드블록 없이)
{"market_sentiment":"bullish|neutral|bearish|panic","stocks":[{"stock_code":"코드","stock_name":"종목명","data_available":true,"analysis":{"key_facts":["거래량 평균 2.3배 폭발","3일 연속 양봉"],"institutional_foreign_flow":"외국인 5일 연속 순매수","consecutive_buy_days":5,"earnings_change_pct":23.5,"recent_news":["뉴스1"],"support_level":0,"resistance_level":0,"high_52w":0,"drop_from_high_pct":0,"negative_factors":["리스크"],"positive_factors":["거래량 폭발","기관 집중 매수"]}}]}`;

export const GEMINI_DEFENSE_ADDON = `

## [하락장 추가 지시]
시장 전체 분위기를 최우선으로 파악하세요.
- VKOSPI 30 이상, 주요 지수 -2% 이상 하락 시 "panic" 판정
- 미국 시장(S&P500, NASDAQ) 동향도 반드시 포함
- 모든 종목의 negative_factors에 "시장 전체 하락 리스크" 추가`;

export const GEMINI_SCALPING_ADDON = `

## [초단타 모드 추가 지시]
캡쳐 이미지/텍스트에서 강하게 언급된 '타겟 종목'과 '목표 가격'을 1순위로 추출하세요.
타겟 종목은 source_confidence를 "HIGH"로 설정하세요.`;

// ── 레짐별 포커싱 질문 (Phase 5: Gemini 프롬프트 레짐 연동) ──
export type RegimeHint =
  | 'TREND_BULL'
  | 'TREND_BEAR'
  | 'RANGE_LOW_VOL'
  | 'RANGE_HIGH_VOL'
  | 'BREAKOUT'
  | 'DISTRIBUTION'
  | null;

const REGIME_FOCUS: Record<string, string> = {
  TREND_BULL: `
## [레짐: 강한 상승추세]
모멘텀 진입 적합도를 최우선 분석하세요:
- 거래량 상승일 우세 여부 (최근 5일 중 3일+ 양봉 + 거래량 증가)
- ADX 강도 (25 이상 = 강한 추세 확인)
- 고점 갱신 여부 (신고가 = 저항 없음, 추세 지속)
- MACD 히스토그램 상승 → 모멘텀 가속 확인`,

  RANGE_LOW_VOL: `
## [레짐: 저변동 횡보]
평균회귀 반등 가능성을 최우선 분석하세요:
- 지지선 근접 여부 (52주 저점, 볼린저 하단, 피보나치 레벨)
- RSI 과매도 (30 이하 = 반등 확률 68%)
- 거래량 소진 (하락 시 거래량 감소 = 매도세 소진)
- 최근 3~5일 내 반전 캔들 패턴 (망치형, 인걸핑)`,

  BREAKOUT: `
## [레짐: 돌파 임박]
돌파 지속 확률을 최우선 분석하세요:
- 스퀴즈(횡보) 기간 (길수록 돌파 파워 강함)
- 돌파 시 거래량 동반 여부 (2배+ = 진짜 돌파)
- 첫 돌파 캔들 강도 (긴 양봉 + 짧은 윗꼬리 = 강한 돌파)
- 이전 저항선이 새 지지선으로 전환되는지 확인`,

  TREND_BEAR: `
## [레짐: 하락추세]
모든 종목에 보수적 관점을 적용하세요:
- 하락 추세에서 반등은 일시적일 가능성 높음
- 거래량 없는 반등 = 데드캣 바운스 경고
- 극단적 과매도(RSI<25) + 거래량 급감만 반등 가능성 인정`,
};

export function buildGeminiPrompt(mode: string, regimeHint?: RegimeHint): string {
  let prompt = GEMINI_BASE_PROMPT;

  if (mode === 'DEFENSE') prompt += GEMINI_DEFENSE_ADDON;
  if (mode === 'SCALPING') prompt += GEMINI_SCALPING_ADDON;

  // 레짐 힌트가 있으면 포커싱 질문 추가
  if (regimeHint && REGIME_FOCUS[regimeHint]) {
    prompt += REGIME_FOCUS[regimeHint];
  }

  return prompt;
}
