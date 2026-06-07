import { analyzeTechnicals } from '../analysis/indicators.js';
import type { DailyCandle } from '../kis/market.js';
import { logger } from '../utils/logger.js';

export interface EntryTimingResult {
  approved: boolean;
  confidence: number;
  reason: string;
}

const ENTRY_PROMPT = `당신은 주식 진입 타이밍 검토 AI입니다.
매수 주문 실행 직전 최종 타이밍을 검토합니다.

✅ 승인 조건:
- RSI 40~70 (추세 진행 중, 과매수 아님)
- ADX ≥ 18 (추세 유효)
- score ≥ 0 (기술 지표 중립 이상)
- 일중 위치 < 75% (당일 최고가 근처 아님)

❌ 거부 조건 (하나라도 해당 시 거부):
- RSI > 73 (단기 과매수 — 고점 매수 위험)
- 일중 위치 ≥ 80% (모멘텀 없이 당일 고점 매수)
- score < -20 (기술 지표 약세)
- 당일 -2% 이상 하락 중 + trend=WEAK (약세 장세)

물타기(averaging down) 추가 기준:
- 이미 손실 중인데 추가 매수 → 반등 신호(RSI 바닥→상승, 거래량 급증) 없으면 거부

JSON만 응답:
{"approved":true,"confidence":0.75,"reason":"한줄설명"}`;

export async function checkLargeOrderEntryTiming(
  stockCode: string,
  currentPrice: number,
  orderAmountKrw: number,
  candles: DailyCandle[],
  existingReasoning: string,
): Promise<EntryTimingResult> {
  try {
    const tech = candles.length >= 20 ? analyzeTechnicals(candles) : null;

    const last = candles[candles.length - 1];
    const dayHigh = last ? Number(last.high) : currentPrice;
    const dayLow = last ? Number(last.low) : currentPrice;
    const dayRangePct = dayHigh > dayLow ? ((currentPrice - dayLow) / (dayHigh - dayLow)) * 100 : 50;

    const prevClose = candles.length >= 2 ? Number(candles[candles.length - 2].close) : currentPrice;
    const todayChangePct = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

    // 규칙기반 진입 타이밍 검증 (Gemini 대체 — $0)
    let approved = true;
    let confidence = 0.65;
    let reason = '';

    // 다일 고점 추격 감지: 5일 최고가 대비 현재가 위치
    const recentHighs = candles.slice(-6, -1); // 최근 5일 (오늘 제외)
    const high5d = recentHighs.length > 0 ? Math.max(...recentHighs.map(c => Number(c.high))) : 0;
    const atMultiDayHigh = high5d > 0 && currentPrice >= high5d * 0.995; // 5일 고점 0.5% 이내

    if (tech) {
      // 거부 조건 (Gemini 프롬프트와 동일 + 고점추격 방어)
      if (tech.rsi14 > 73) {
        approved = false; confidence = 0.80; reason = `RSI=${tech.rsi14.toFixed(0)} 과매수`;
      } else if (dayRangePct >= 75 && atMultiDayHigh) {
        // 돌파매매 방어: 오늘 고점 + 5일 고점 동시 → 저항선 돌파 실패 위험
        approved = false; confidence = 0.85; reason = `일중${dayRangePct.toFixed(0)}%+5일고점 돌파실패위험`;
      } else if (dayRangePct >= 80) {
        approved = false; confidence = 0.75; reason = `일중${dayRangePct.toFixed(0)}% 고점매수위험`;
      } else if (todayChangePct >= 3 && tech.rsi14 > 65 && tech.volumeRatio < 1.5) {
        // +3% 급등 + RSI 65+ + 거래량 부족 = 무성량 급등 (돌파 확인 안 됨)
        approved = false; confidence = 0.75; reason = `급등${todayChangePct.toFixed(1)}%+RSI${tech.rsi14.toFixed(0)} 무성량`;
      } else if (tech.score < -20) {
        approved = false; confidence = 0.70; reason = `score=${tech.score} 약세`;
      } else if (todayChangePct <= -2 && tech.trendStrength === 'WEAK') {
        approved = false; confidence = 0.75; reason = `하락${todayChangePct.toFixed(1)}% weak추세`;
      } else {
        // 승인 — confidence 조건부 (고점 근처면 감점)
        const baseConf = (tech.rsi14 >= 40 && tech.rsi14 <= 70 && tech.adx14 >= 18 && tech.score >= 0) ? 0.75 : 0.60;
        confidence = atMultiDayHigh ? Math.min(baseConf, 0.55) : baseConf;
        reason = `RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)} score=${tech.score}${atMultiDayHigh ? ' 5일고점근처' : ''}`;
      }
    } else {
      reason = 'indicators N/A — 허용';
    }

    logger.info(
      `🎯 진입타이밍 [${stockCode}] ${approved ? '✅승인' : '❌거부'} (${(confidence * 100).toFixed(0)}%): ${reason}`,
      { component: 'ENTRY_TIMING' },
    );
    return { approved, confidence, reason };
  } catch (e) {
    // fail-open: AI 실패 시 허용 (기존 trade gate들이 이미 통과시킨 주문)
    logger.warn(`진입타이밍 AI 실패 → 허용: ${stockCode} — ${(e as Error).message}`, { component: 'ENTRY_TIMING' });
    return { approved: true, confidence: 0.5, reason: 'AI 조회 실패 — 기존 게이트 허용' };
  }
}
