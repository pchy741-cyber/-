import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

function getAnthropic(): Anthropic | null {
  const key = config.ai.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('your_')) return null;
  return new Anthropic({ apiKey: key });
}

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

const SYSTEM_PROMPT = `당신은 미국 대형주 단기 트레이딩 전문가입니다. 수익 창출이 목표이므로 적극적으로 기회를 찾아야 합니다.

규칙:
- 분석 대상: NASDAQ/NYSE 빅테크 (AAPL, NVDA, META, MSFT, GOOGL, AMZN, TSLA)
- 포지션: 최대 5종목 동시 보유 (슬롯 여유 있고 조건 되면 매수 적극 권장)
- 익절: +5% / 손절: -3% (단기 스윙)
- RSI 35 이하 = 과매도 → 반등 매수 기회로 적극 고려
- RSI 65 이상 + score < 0 = 과매수 주의
- ADX 15+ = 추세 있음 → BUY 조건 충족 시 적극 진입
- 기술적 score -30 이하이면 매도 우선
- 하락장/변동성 구간에서도 개별 종목 기술적 반등은 유효함. 시장 전체 비관론으로 전 종목 HOLD하지 말 것.
- 🚀모멘텀(당일강세) 표시 종목: 이미 강하게 상승 중 → 추세 추종 매수 적극 고려 (RSI 72 미만이면 과매수 아님)
- 일중 위치가 높다(70%+)는 것은 당일 강세 지속 신호일 수 있음 (고점 돌파 모멘텀)
- 5종목 미만 보유이고 조건 충족 종목이 있으면 최소 1개는 BUY 권장

반드시 JSON 배열로만 응답하세요:
[{"code":"AAPL","action":"BUY","confidence":0.75,"reasoning":"RSI 32 과매도 반등, ADX 22 상승 추세"},...]

action은 BUY/SELL/HOLD 중 하나. confidence는 0.0~1.0.
보유 중 종목에 SELL이면 즉시 청산 의미.
이미 보유 중인 종목은 BUY 금지.`;

/**
 * Claude에게 미국주식 매매 판단을 요청
 * Track B 방식과 동일하게 structured JSON 반환
 */
export async function analyzeOverseasWithAI(
  stocks: OverseasStockInput[],
  availableCash: number,
  holdingCount: number,
): Promise<OverseasAIDecision[]> {
  const anthropic = getAnthropic();
  if (!anthropic) {
    logger.warn('Anthropic 키 없음 — AI 분석 스킵, 기술적 지표만 사용', { component: 'OVERSEAS_AI' });
    return [];
  }

  const context = buildContext(stocks, availableCash, holdingCount);

  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        temperature: 0.1,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: context }],
      });

      const text = response.content.find(b => b.type === 'text')?.text ?? '';
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

function buildContext(stocks: OverseasStockInput[], cash: number, holdingCount: number): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timeStr = `${kst.getUTCHours()}:${String(kst.getUTCMinutes()).padStart(2, '0')} KST`;

  const lines = stocks.map(s => {
    const holding = s.isHolding ? ` [보유중 PnL=${s.holdingPnlPct?.toFixed(1)}%]` : '';
    const momentum = s.isMomentum ? ' 🚀모멘텀(당일강세)' : '';
    const range = s.dayRangePct != null ? ` 일중${s.dayRangePct.toFixed(0)}%` : '';
    return `${s.code}(${s.name}): $${s.currentPrice} ${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%${range} | RSI=${s.rsi.toFixed(0)} ADX=${s.adx.toFixed(0)} score=${s.score} signal=${s.signal}${momentum}${holding}`;
  });

  return [
    `시각: ${timeStr} | 가용현금: $${cash.toFixed(0)} | 현재보유: ${holdingCount}종목 (최대 5종목)`,
    '',
    '=== 종목 현황 ===',
    ...lines,
    '',
    '위 종목들에 대해 JSON 배열로 BUY/SELL/HOLD 판단을 내려주세요.',
    '가용현금이 $200 미만이면 BUY 금지. 이미 5종목 보유 시 BUY 금지.',
  ].join('\n');
}
