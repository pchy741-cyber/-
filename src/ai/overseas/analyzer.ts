import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';

export interface OverseasStockInput {
  code: string;
  name: string;
  exchange: string;
  currentPrice: number;
  changePct: number; // 당일 등락률
  rsi: number;
  adx: number;
  score: number; // analyzeTechnicals score (-100~100)
  signal: string; // STRONG_BUY / BUY / HOLD / SELL / STRONG_SELL
  trendStrength: string;
  isHolding: boolean;
  holdingPnlPct?: number;
  dayRangePct?: number; // 0=저가, 100=고가 위치 (일중 어디에 있는지)
  isMomentum?: boolean; // 당일 +3% 이상 + 일중 상위 → 강한 상승 모멘텀
  isBigMover?: boolean; // 당일 +5% 이상 → 뉴스/촉매 기반 강한 상승 (우선 진입 대상)
  aboveMA20?: boolean; // 현재가 > 21일 이평선 여부 (캔들 안착 확인)
  bollingerSqueeze?: boolean; // BB 밴드 수축 중 (에너지 응축, 돌파 방향 미확정)
  bollingerBreakout?: 'UP' | 'DOWN' | 'NONE'; // 스퀴즈 후 돌파 방향
}

export interface OverseasAIDecision {
  code: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0~1
  reasoning: string;
}

const SYSTEM_PROMPT = `당신은 글로벌 주식(미국 주력 + 일본·대만 ADR 서브) 스윙/단타 전문 트레이딩 AI입니다.
실제 자금이 투입되며, 매 사이클 최소 1~2종목 BUY를 목표로 적극 운용하세요.

【시스템 자동 처리 — 당신이 관여 안 해도 됨】
- 손절: 고베타(NVDA·AMD·PLTR) -8% / 중베타(META·MSFT 등) -5% / 방산 -4% 자동 손절
- 익절: 고베타 +20% / 중베타·방산 +15% 하드익절 / 트레일링 스탑(+8~10% 수익 달성 후 고점 대비 -7~10% 이탈 시)
- 스윙 목표: +15~20%. 당신은 이 목표 달성 전에 SELL 신호를 남발하지 말 것

【당신의 역할】
① 최적 진입 타이밍 포착 (BUY) — 스윙 기준 2~3일 이상 보유 전제
② 추세 반전 명확 시 선제 청산 (SELL) — 단순 단기 조정은 SELL 금지
③ 관망 (HOLD) — 단, HOLD 남발 금지. 조건 충족 시 BUY로

【BUY 진입 2단계 필수 확인】
▶ 1단계 — 상승추세 확인 (둘 다 충족해야 진입 자격)
  • RSI ≥ 50 (상승 모멘텀 구간)
  • trendStrength = STRONG 또는 MODERATE (이평선 상승 방향)

▶ 2단계 — 타점 기준 (1단계 통과 후)
  • RSI가 50선을 밑에서 위로 돌파 (최근 RSI 45~55 구간) OR isMomentum=true
  • dayRangePct < 80 (일중 고점 근처 매수 금지 — 이평선 위로 안착한 저점 공략)
    단, 시장 breadth ≥ 65%(강세장): dayRangePct < 85 허용 (전 종목 고점 근처인 날)

【BUY 진입 패턴 — 글로벌 스윙 실전 기준】
0. 🔥 빅무버 우선진입: isBigMover=true(당일+5%↑) → 뉴스/실적/촉매 강한 주도주
   → 섹터 상위 모멘텀 주도. RSI 50~75 + ADX ≥ 15면 충분. confidence 0.70+
   → 빵빵한 상승 이유(실적·제품 발표·업그레이드)가 있으므로 이틀 이상 지속 가능
1. 🚀 모멘텀 브레이크아웃: isMomentum=true(당일+3%↑) + RSI 50~72 + ADX ≥ 20
   → 추세 추종. 미국 주식은 모멘텀이 3~5일 지속. 강력 BUY. confidence 0.72+
2. 📉 과매도 반등: RSI ≤ 35 + ADX ≥ 20 + score > 0 + trendStrength≠WEAK
   → 단기 반등. 단, 하락추세(trendStrength=WEAK)면 패스. confidence 0.67+
3. 📊 눌림목 재진입: RSI 50~65 + ADX ≥ 20 + score ≥ 25 + dayRangePct < 40
   → 상승 추세 내 저점 매수. 리스크/보상비율 우수. confidence 0.68+
   → 강세장 RSI 55~62는 정상 상승 구간 — 과열 아님
4. 💥 고베타 신호 (PLTR): signal=STRONG_BUY + RSI 50~68 + trendStrength≠WEAK
   → 변동성 크지만 추세 확인 후만 진입. confidence 0.65+
5. 💪 강한 기술 신호: signal=STRONG_BUY + score ≥ 35 + RSI 50~65 → BUY. confidence 0.68+

【섹터별 특성 반영】
- 고베타 (PLTR): 변동성 크므로 모멘텀 있을 때만 BUY, confidence 0.65+ OK
- 빅테크 (AAPL·GOOGL·AMZN·META·NVDA·AMD·AVGO): 안정적. 눌림목/모멘텀 양쪽 유효
- 방산·인프라 (RTX·LMT·GEV·ETN·PWR): 거시 환경 연동, 추세 신호 중시. 낮은 변동성 감안 RSI 기준 완화
- AI 반도체 공급망 (ANET·VRT): 데이터센터 수요 폭증 수혜. 모멘텀 지속 경향 강함
- 🇯🇵 일본 ADR (TM·SONY·MUFG): 엔화 약세 수혜 수출주. 미국장에서 거래되지만 도쿄 뉴스 반응. 변동성 낮음, confidence 0.65+ 필요. 분기 실적 호조·엔화 방향이 중요한 촉매
- 🇹🇼 대만 ADR (TSM·UMC): AI 반도체 공급망 핵심. NVDA·AAPL 실적 연동. TSM은 대장주급 안정성, UMC는 성숙공정 안정주. confidence 0.65+ 필요. 미·중 지정학 이슈에 민감

【confidence 기준】
- 0.68 이상: 고베타 성장주(PLTR) BUY (추세 확인 필수)
- 0.70 이상: 일반 종목·일본ADR·대만ADR BUY
- 0.72~0.88: 강한 신호 (최대 0.88)
- confidence 보너스 (해당 조건 합산, 총합 최대 +0.10 캡):
  · 일중 저가 근처(dayRangePct < 25): +0.04
  · 모멘텀(isMomentum=true): +0.04
  · 빅무버(isBigMover=true): +0.06 (촉매 명확)
  → 예: 모멘텀+빅무버 → +0.10 (캡). 보너스 없으면 기본 confidence만 사용

【SELL — 보유 종목만】
- PnL +10% 이상 + RSI 명확 하락추세(70↓) + score 급락(-20↓) → 수익 실현 SELL (스윙 목표 15~20% 전제 — 조기 청산 금지)
- score < -25 AND signal=STRONG_SELL AND trendStrength=WEAK → 추세 붕괴 SELL
- 손실 -3% 이상 + signal=SELL 또는 STRONG_SELL + ADX 급등(추세 반전 확인) → 선제 손절 SELL
- PnL +4~9% 구간에서 단순 RSI 하락만으로는 SELL 금지 — 스윙 추세 내 정상 조정일 수 있음

【절대 금지】
- 보유 종목에 BUY / 비보유 종목에 SELL
- VIX > 40: 신규 매수 금지 (패닉 구간)
- Fear&Greed ≥ 85(극탐욕): 신규 매수 금지
- RSI < 50 이고 trendStrength=WEAK인 종목 BUY 금지 (하락추세 진입 금지)
- dayRangePct ≥ 80 이고 isMomentum=false이고 isBigMover=false인 종목 BUY 금지 (일중 고점 매수 금지)
  단, 시장 breadth ≥ 65%(강세장): dayRangePct 85 미만까지 허용
- 시장 breadth(양봉 비율) < 35%: 시장 약세 → BUY하려면 기본 기준보다 confidence 0.05 더 높아야 함 (예: 기본 0.70 → 0.75 필요). 약세장에서 낮은 confidence로 BUY 금지
- 시장 breadth ≥ 65%(강세장): BUY 기준 0.02 완화 (예: 기본 0.70 → 0.68 OK). 강세장은 대부분 종목이 오르므로 약간 공격적 허용
- PnL +4~9% 구간에서 단순 RSI 하락만으로 SELL 금지 — 스윙 추세 내 정상 조정
- 확신 없으면 HOLD. 조건 미달 종목에 억지로 BUY 하지 말 것

JSON 배열로만 응답 (HOLD는 생략, code 대소문자 정확히):
[{"code":"NVDA","action":"BUY","confidence":0.78,"reasoning":"모멘텀 브레이크아웃 RSI=55 ADX=32 당일+4.1% 일중고가권"},{"code":"TSM","action":"BUY","confidence":0.71,"reasoning":"NVDA 실적 기대감 RSI=52 ADX=28 눌림목 dayRangePct=22"},{"code":"TSLA","action":"SELL","confidence":0.72,"reasoning":"PnL+6.2% RSI하락 score-18 모멘텀 소진"}]
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
  marketContext?: {
    fearGreed?: number;
    fearGreedLabel?: string;
    vix?: number;
    earningsRisk?: string[];
    breadthPct?: number;
    sectorMomentum?: string;
  },
): Promise<OverseasAIDecision[]> {
  const context = buildContext(stocks, availableCash, holdingCount, perfSummary, userInsights, marketContext);

  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await callVertexGemini(SYSTEM_PROMPT, context, { temperature: 0.1, label: '해외-분석' });

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('JSON 배열 없음');

      const raw = JSON.parse(jsonMatch[0]) as unknown[];
      const decisions: OverseasAIDecision[] = raw
        .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
        .map((d) => ({
          code: String(d.code ?? ''),
          action: (['BUY', 'SELL', 'HOLD'].includes(String(d.action)) ? String(d.action) : 'HOLD') as
            | 'BUY'
            | 'SELL'
            | 'HOLD',
          confidence: Math.min(1, Math.max(0, Number(d.confidence ?? 0.5))),
          reasoning: String(d.reasoning ?? ''),
        }))
        .filter((d) => d.code);

      logger.info(
        `🤖 AI 미국주식 판단: ${decisions.map((d) => `${d.code}=${d.action}(${(d.confidence * 100).toFixed(0)}%)`).join(', ')}`,
        { component: 'OVERSEAS_AI' },
      );
      return decisions;
    } catch (e) {
      logger.warn(`AI 분석 실패 (${attempt}/${MAX_RETRIES}): ${(e as Error).message}`, { component: 'OVERSEAS_AI' });
    }
  }

  return [];
}

function buildContext(
  stocks: OverseasStockInput[],
  cash: number,
  holdingCount: number,
  perfSummary?: string,
  userInsights?: string,
  marketContext?: {
    fearGreed?: number;
    fearGreedLabel?: string;
    vix?: number;
    earningsRisk?: string[];
    breadthPct?: number;
    sectorMomentum?: string;
  },
): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timeStr = `${kst.getUTCHours()}:${String(kst.getUTCMinutes()).padStart(2, '0')} KST`;

  const lines = stocks.map((s) => {
    const pnl = s.isHolding ? s.holdingPnlPct?.toFixed(1) : null;
    const softZone = s.isHolding && (s.holdingPnlPct ?? 0) >= 5 ? ' ⚠️소프트익절구간' : '';
    const holding = s.isHolding ? ` [보유 PnL=${pnl}%${softZone}]` : '';
    const bigMover = s.isBigMover ? ' 🔥빅무버' : '';
    const momentum = s.isMomentum && !s.isBigMover ? ' 🚀모멘텀' : '';
    const range = s.dayRangePct != null ? ` 일중${s.dayRangePct.toFixed(0)}%` : '';
    const maPos = s.aboveMA20 != null ? (s.aboveMA20 ? ' ↑MA' : ' ↓MA') : '';
    const bbTag = s.bollingerSqueeze
      ? s.bollingerBreakout === 'UP'
        ? ' 💥BB↑'
        : s.bollingerBreakout === 'DOWN'
          ? ' 💥BB↓'
          : ' 🔧BBsq'
      : '';
    return `${s.code}: $${s.currentPrice} ${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%${range} | RSI=${s.rsi.toFixed(0)} ADX=${s.adx.toFixed(0)} score=${s.score} signal=${s.signal}${maPos}${bbTag}${bigMover}${momentum}${holding}`;
  });

  // 동적 최소 매수 게이트: 포트폴리오의 2% 또는 $50 중 큰 값
  const portfolioValue = cash + holdingCount * 300; // 대략적 포트폴리오 추정
  const minBuyGate = Math.max(50, portfolioValue * 0.02);
  const maxPositions = Math.max(4, Math.min(10, Math.floor(portfolioValue / 500))); // 포트폴리오 규모별 동적 종목수
  const canBuy = cash >= minBuyGate && holdingCount < maxPositions;
  const parts = [
    `시각: ${timeStr} | 현금: $${cash.toFixed(0)} | 보유: ${holdingCount}/${maxPositions}종목 | 매수가능: ${canBuy ? '예' : '아니오(현금부족 또는 만석)'}`,
  ];
  if (perfSummary) parts.push(`📊 ${perfSummary} — 이 실적을 바탕으로 더 정확한 판단을 내려주세요.`);
  if (marketContext) {
    const fg = marketContext.fearGreed;
    const vix = marketContext.vix;
    const er = marketContext.earningsRisk;
    const fgStr = fg != null ? `Fear&Greed=${fg}(${marketContext.fearGreedLabel ?? ''})` : '';
    const vixStr = vix != null ? ` VIX=${vix.toFixed(1)}` : '';
    const erStr = er && er.length > 0 ? ` | ⚠️어닝리스크: ${er.join(',')}` : '';
    const breadthStr =
      marketContext.breadthPct != null
        ? ` | 양봉비율=${(marketContext.breadthPct * 100).toFixed(0)}%${marketContext.breadthPct < 0.35 ? '(⚠️시장약세—확신도+0.05)' : ''}`
        : '';
    const sectorStr = marketContext.sectorMomentum ? ` | 섹터모멘텀: ${marketContext.sectorMomentum}` : '';
    parts.push(`🌍 시장 환경: ${fgStr}${vixStr}${erStr}${breadthStr}${sectorStr}`);
  }
  if (userInsights) parts.push(`\n💡 운영자 인사이트: ${userInsights}`);
  parts.push('', ...lines, '', 'BUY/SELL/HOLD 판단을 JSON 배열로 출력하세요.');
  return parts.join('\n');
}
