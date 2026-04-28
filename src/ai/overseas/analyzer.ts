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

const SYSTEM_PROMPT = `당신은 미국 빅테크 단기 스윙 트레이딩 AI입니다. 실제 자금이 투입되며 수익이 목표입니다.

【역할 분담】
- 손절(-3%), 하드익절(+10%), 트레일링 스탑은 시스템이 자동 처리합니다.
- 당신의 역할: ① 최적 진입 타이밍(BUY) ② 모멘텀 약화 시 선제 청산(SELL) ③ 관망(HOLD)

【BUY 최우선 조건 — 이 신호들은 실증적으로 높은 수익률 확인됨】
1. 🚀 모멘텀 폭발: isMomentum=true(당일+3%+) + RSI < 70 → 추세 추종 적극 BUY (모멘텀 지속 확률 65%)
2. 📉 과매도 반등: RSI ≤ 38 + ADX 15+ + S&P 하락장 아님 → 반등 BUY (3일 내 반등 확률 68%)
3. 📊 눌림목 진입: RSI 38~55 + ADX 22+ + score ≥ 30 + 상승추세 → 추세 내 매수 최적
4. 💪 강한 신호: signal=STRONG_BUY + score ≥ 40 + RSI < 65 → BUY

【포지션 진입 기준】
- confidence 0.65 이상 → BUY 실행 (미만이면 스킵)
- 확신 있으면 0.70~0.85 부여, 최강 신호는 0.85까지 가능
- 일중 저가(dayRangePct < 20): 당일 바닥 근처 = 유리한 진입 → 보너스

【SELL 조건 — 보유 종목만】
- PnL +5% 이상 + RSI 하락 + score 급락 → 수익 실현 SELL
- score < -20 또는 signal=STRONG_SELL → 손실 방어 SELL
- 손실(-1.5%~-2%) + 기술 신호 악화 → 선제 손절

【절대 금지】
- 보유 종목 BUY / 비보유 종목 SELL
- VIX > 35 + 탐욕지수 > 25: 신규 매수 금지 (시장 공황)
- 아무것도 안 하면 수익 없음 — 조건 충족 시 과감하게 BUY

JSON 배열로만 응답 (HOLD는 생략):
[{"code":"AAPL","action":"BUY","confidence":0.75,"reasoning":"모멘텀 폭발 RSI=52, score=42, ADX=28 상승추세, 일중저가 근처"}]
confidence: 0.0~1.0`;

/**
 * Gemini 2.0 Flash로 미국주식 매매 판단 (Claude Sonnet 대체 — 무료 티어)
 */
export async function analyzeOverseasWithAI(
  stocks: OverseasStockInput[],
  availableCash: number,
  holdingCount: number,
  perfSummary?: string,
  userInsights?: string,
  marketContext?: { fearGreed?: number; fearGreedLabel?: string; vix?: number; earningsRisk?: string[] },
): Promise<OverseasAIDecision[]> {
  const context = buildContext(stocks, availableCash, holdingCount, perfSummary, userInsights, marketContext);

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

function buildContext(stocks: OverseasStockInput[], cash: number, holdingCount: number, perfSummary?: string, userInsights?: string, marketContext?: { fearGreed?: number; fearGreedLabel?: string; vix?: number; earningsRisk?: string[] }): string {
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
  if (marketContext) {
    const fg = marketContext.fearGreed;
    const vix = marketContext.vix;
    const er = marketContext.earningsRisk;
    const fgStr = fg != null ? `Fear&Greed=${fg}(${marketContext.fearGreedLabel ?? ''})` : '';
    const vixStr = vix != null ? ` VIX=${vix.toFixed(1)}` : '';
    const erStr = er && er.length > 0 ? ` | ⚠️어닝리스크: ${er.join(',')}` : '';
    parts.push(`🌍 시장 환경: ${fgStr}${vixStr}${erStr}`);
  }
  if (userInsights) parts.push(`\n💡 운영자 인사이트: ${userInsights}`);
  parts.push('', ...lines, '', 'BUY/SELL/HOLD 판단을 JSON 배열로 출력하세요.');
  return parts.join('\n');
}
