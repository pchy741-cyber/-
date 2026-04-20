import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';

export interface OverseasStockInput {
  code: string;
  name: string;
  exchange: string;
  currentPrice: number;
  changePct: number;     // 당일 등락률
  rsi: number;
  adx: number;
  score: number;         // analyzeTechnicals score (-100~100)
  signal: string;        // STRONG_BUY / BUY / HOLD / SELL / STRONG_SELL
  trendStrength: string;
  isHolding: boolean;
  holdingPnlPct?: number;
  dayRangePct?: number;  // 0=저가, 100=고가 위치 (일중 어디에 있는지)
  isMomentum?: boolean;  // 당일 +3% 이상 + 일중 상위 → 강한 상승 모멘텀
}

export interface OverseasAIDecision {
  code: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0~1
  reasoning: string;
}

const SYSTEM_PROMPT = `당신은 미국·아시아 대형주 단기 스윙 트레이딩 AI입니다. 실제 자금이 투입되므로 근거 있는 판단만 하세요.

【역할 분담】
- 손절(-3%), 하드익절(+10%), 트레일링 스탑은 시스템이 자동 처리합니다.
- 당신의 역할: ① 진입 타이밍(BUY) ② 모멘텀 약화 시 선제 청산(SELL) ③ 관망(HOLD)

【BUY 조건 — 미보유 종목만】
- RSI 38 이하 과매도 구간에서 기술 반등 신호(ADX 15+)
- 🚀모멘텀 종목: 당일 강하게 상승 중 + ADX 강세 → 추세 추종 진입 (RSI 73 미만이면 과매수 아님)
- 슬롯·현금 여유 있고 위 조건 충족 시 적극 BUY 권장

【SELL 조건 — 보유 종목만】
- PnL +5% 이상 표시 종목: 모멘텀이 꺾였으면(RSI 하락, ADX 약화, score 급락) SELL
- 전체 시장 하락 국면에서 손실 중인 보유종목 선제 정리 가능
- score -25 이하로 급락 시 SELL

【주의】
- 시장 전체 분위기로 전 종목 HOLD 금지 — 개별 종목 기준으로 판단
- 보유 종목에 BUY 금지 / 비보유 종목에 SELL 금지

반드시 JSON 배열로만 응답:
[{"code":"AAPL","action":"BUY","confidence":0.75,"reasoning":"RSI 33 과매도, ADX 21 상승추세 확인"}]
confidence: 0.0~1.0 (확신 낮으면 낮게)`;

/**
 * Gemini 2.0 Flash로 미국주식 매매 판단 (Claude Sonnet 대체 — 무료 티어)
 */
export async function analyzeOverseasWithAI(
  stocks: OverseasStockInput[],
  availableCash: number,
  holdingCount: number,
  perfSummary?: string,
  userInsights?: string,
): Promise<OverseasAIDecision[]> {
  const context = buildContext(stocks, availableCash, holdingCount, perfSummary, userInsights);

  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await callVertexGemini(SYSTEM_PROMPT, context, { temperature: 0.1 });

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('JSON 배열 없음');

      const raw = JSON.parse(jsonMatch[0]) as unknown[];
      const decisions: OverseasAIDecision[] = raw
        .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
        .map(d => ({
          code: String(d.code ?? ''),
          action: (['BUY', 'SELL', 'HOLD'].includes(String(d.action)) ? String(d.action) : 'HOLD') as 'BUY' | 'SELL' | 'HOLD',
          confidence: Math.min(1, Math.max(0, Number(d.confidence ?? 0.5))),
          reasoning: String(d.reasoning ?? ''),
        }))
        .filter(d => d.code);

      logger.info(`🤖 AI 미국주식 판단: ${decisions.map(d => `${d.code}=${d.action}(${(d.confidence * 100).toFixed(0)}%)`).join(', ')}`, { component: 'OVERSEAS_AI' });
      return decisions;
    } catch (e) {
      logger.warn(`AI 분석 실패 (${attempt}/${MAX_RETRIES}): ${(e as Error).message}`, { component: 'OVERSEAS_AI' });
    }
  }

  return [];
}

function buildContext(stocks: OverseasStockInput[], cash: number, holdingCount: number, perfSummary?: string, userInsights?: string): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timeStr = `${kst.getUTCHours()}:${String(kst.getUTCMinutes()).padStart(2, '0')} KST`;

  const lines = stocks.map(s => {
    const pnl = s.isHolding ? s.holdingPnlPct?.toFixed(1) : null;
    const softZone = s.isHolding && (s.holdingPnlPct ?? 0) >= 5 ? ' ⚠️소프트익절구간' : '';
    const holding = s.isHolding ? ` [보유 PnL=${pnl}%${softZone}]` : '';
    const momentum = s.isMomentum ? ' 🚀모멘텀' : '';
    const range = s.dayRangePct != null ? ` 일중${s.dayRangePct.toFixed(0)}%` : '';
    return `${s.code}: $${s.currentPrice} ${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%${range} | RSI=${s.rsi.toFixed(0)} ADX=${s.adx.toFixed(0)} score=${s.score} signal=${s.signal}${momentum}${holding}`;
  });

  const canBuy = cash >= 200 && holdingCount < 7;
  const parts = [
    `시각: ${timeStr} | 현금: $${cash.toFixed(0)} | 보유: ${holdingCount}/7종목 | 매수가능: ${canBuy ? '예' : '아니오(현금부족 또는 만석)'}`,
  ];
  if (perfSummary) parts.push(`📊 ${perfSummary} — 이 실적을 바탕으로 더 정확한 판단을 내려주세요.`);
  if (userInsights) parts.push(`\n💡 운영자 인사이트: ${userInsights}`);
  parts.push('', ...lines, '', 'BUY/SELL/HOLD 판단을 JSON 배열로 출력하세요.');
  return parts.join('\n');
}
