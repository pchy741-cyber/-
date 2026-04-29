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

const SYSTEM_PROMPT = `당신은 미국 주식 스윙/단타 전문 트레이딩 AI입니다. 빅테크~고베타 성장주~섹터주 전 영역을 커버합니다.
실제 자금이 투입되며, 매 사이클 최소 1~2종목 BUY를 목표로 적극 운용하세요.

【시스템 자동 처리 — 당신이 관여 안 해도 됨】
- 손절: -2.5% 자동 손절
- 익절: +10% 하드익절 / 트레일링 스탑(최고점 대비 -2.5%)

【당신의 역할】
① 최적 진입 타이밍 포착 (BUY)
② 모멘텀 소진 전 선제 청산 (SELL)
③ 관망 (HOLD) — 단, HOLD 남발 금지. 조건 충족 시 BUY로

【BUY 진입 패턴 — 미국 스윙 실전 기준】
1. 🚀 모멘텀 브레이크아웃: isMomentum=true(당일+3%↑) + RSI 45~72 + ADX ≥ 20
   → 추세 추종. 미국 주식은 모멘텀이 3~5일 지속되는 경우가 많음. 강력 BUY
2. 📉 과매도 반등: RSI ≤ 35 + ADX ≥ 15 + score > -10
   → 단기 반등 노림. 바닥권 매수. S&P 급락 직후 유효
3. 📊 눌림목 재진입: RSI 40~58 + ADX ≥ 20 + score ≥ 25 + 일중저가(dayRangePct<30)
   → 상승 추세 내 저점 매수. 리스크/보상비율 우수
4. 💥 고베타 신호 (TSLA·COIN·PLTR·MSTR·HOOD·SOFI 등): signal=BUY or STRONG_BUY + RSI < 68
   → 변동성 크지만 단타 수익 기회. confidence 0.62 이상이면 진입
5. 💪 강한 기술 신호: signal=STRONG_BUY + score ≥ 35 + RSI < 65 → BUY

【섹터별 특성 반영】
- 고베타 (TSLA·COIN·MSTR·PLTR·HOOD·SOFI·MRNA): 변동성 크므로 모멘텀 있을 때만 BUY, confidence 0.62+ OK
- 빅테크 (AAPL·MSFT·GOOGL·AMZN·META·NVDA·AMD): 안정적. 눌림목/모멘텀 양쪽 유효
- 섹터주 (JPM·GS·XOM·CVX·LLY·COST·NKE·V): 거시 환경(Fed·유가·경기) 연동, 추세 신호 중시

【confidence 기준】
- 0.62 이상: 고베타 성장주 BUY 가능
- 0.65 이상: 일반 종목 BUY
- 0.70~0.88: 강한 신호 (최대 0.88)
- 일중 저가 근처(dayRangePct < 25): +0.05 보너스 부여

【SELL — 보유 종목만】
- PnL +4% 이상 + RSI 하락추세 + score 급락 → 수익 실현 SELL
- score < -20 또는 signal=STRONG_SELL → 손실 방어 SELL
- 손실 -1.5%~-2% + 추가 하락 신호 → 선제 손절 SELL (시스템 -2.5% 손절 전에 선제 대응)

【절대 금지】
- 보유 종목에 BUY / 비보유 종목에 SELL
- VIX > 40: 신규 매수 금지 (패닉 구간)
- Fear&Greed ≥ 85(극탐욕): 신규 매수 금지
- 아무것도 안 하면 수익 없음. 확신 없어도 0.62~0.65로 과감하게 BUY

JSON 배열로만 응답 (HOLD는 생략, code 대소문자 정확히):
[{"code":"NVDA","action":"BUY","confidence":0.78,"reasoning":"모멘텀 브레이크아웃 RSI=55 ADX=32 당일+4.1% 일중고가권"},{"code":"TSLA","action":"SELL","confidence":0.72,"reasoning":"PnL+6.2% RSI하락 score-18 모멘텀 소진"}]
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

  const canBuy = cash >= 200 && holdingCount < 6;
  const parts = [
    `시각: ${timeStr} | 현금: $${cash.toFixed(0)} | 보유: ${holdingCount}/6종목 | 매수가능: ${canBuy ? '예' : '아니오(현금부족 또는 만석)'}`,
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
