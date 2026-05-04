import { analyzeTechnicals } from '../analysis/indicators.js';
import type { DailyCandle } from '../kis/market.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';
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

    const context = [
      `종목: ${stockCode} | 현재가: ${currentPrice.toLocaleString()}원 | 주문: ${Math.round(orderAmountKrw / 10000)}만원`,
      tech
        ? `RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)} score=${tech.score} trend=${tech.trendStrength}`
        : 'indicators: N/A',
      `일중위치: ${dayRangePct.toFixed(0)}% | 당일등락: ${todayChangePct >= 0 ? '+' : ''}${todayChangePct.toFixed(2)}%`,
      `기존판단: ${existingReasoning.slice(0, 150)}`,
      '',
      '진입 타이밍 승인/거부를 JSON으로 응답하세요.',
    ].join('\n');

    const text = await callVertexGemini(ENTRY_PROMPT, context, { temperature: 0.1, maxOutputTokens: 120 });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 없음');

    const parsed = JSON.parse(jsonMatch[0]) as { approved?: boolean; confidence?: number; reason?: string };
    const approved = Boolean(parsed.approved ?? true);
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.6)));
    const reason = String(parsed.reason ?? '');

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
