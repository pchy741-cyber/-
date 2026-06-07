/**
 * 해외 주식 규칙 기반 분석기 — Gemini 대체 (비용 $0)
 *
 * analyzer.ts의 Gemini 프롬프트에 정의된 5개 진입 패턴을 그대로 규칙화.
 * OverseasAIDecision[] 동일 인터페이스 반환 → overseas-job.ts drop-in 교체.
 *
 * 매도: sell-logic.ts(SL/TP/ATR/트레일링)이 주력 → 여기선 추세붕괴/선제손절만 보조.
 */
import type { OverseasStockInput, OverseasAIDecision } from './analyzer.js';
import type { CrossMarketSignal } from '../../scheduler/overseas/cross-market.js';
import { logger } from '../../utils/logger.js';

const COMP = 'RULE_OVERSEAS';

export function analyzeOverseasRuleBased(
  stocks: OverseasStockInput[],
  availableCash: number,
  holdingCount: number,
  marketContext?: { fearGreed?: number; vix?: number; breadthPct?: number },
  crossSignals?: CrossMarketSignal[],
): OverseasAIDecision[] {
  const decisions: OverseasAIDecision[] = [];

  // 크로스마켓 신호 맵 (usCode → signal)
  const crossMap = new Map<string, CrossMarketSignal>();
  if (crossSignals) {
    for (const sig of crossSignals) crossMap.set(sig.usCode, sig);
  }

  const vix = marketContext?.vix ?? 0;
  const fg = marketContext?.fearGreed ?? 50;
  const breadth = marketContext?.breadthPct ?? 0.5;
  const isBearish = breadth < 0.35;
  const isBullish = breadth >= 0.65;

  // VIX > 40 또는 극탐욕 → 매수 차단 (매도만)
  const globalBlock = vix > 40 || fg >= 85;

  // 동적 포지션 한도
  const portfolioValue = availableCash + holdingCount * 300;
  const minBuyGate = Math.max(50, portfolioValue * 0.02);
  const maxPositions = Math.max(4, Math.min(10, Math.floor(portfolioValue / 500)));
  const canBuy = !globalBlock && availableCash >= minBuyGate && holdingCount < maxPositions;

  for (const s of stocks) {
    // ── 보유 종목: 매도 평가 ──
    if (s.isHolding) {
      const sell = evaluateSell(s);
      if (sell) decisions.push(sell);
      continue;
    }

    if (!canBuy) continue;

    // ── 비보유 종목: 매수 평가 ──
    // 절대 금지: RSI < 50 + WEAK trend
    if (s.rsi < 50 && s.trendStrength === 'WEAK') continue;

    // 일중 고점 매수 금지 (강세장은 85까지 허용)
    const maxDayRange = isBullish ? 85 : 80;
    if ((s.dayRangePct ?? 100) >= maxDayRange && !s.isMomentum && !s.isBigMover) continue;

    // 크로스마켓 신호 확인
    const crossSig = crossMap.get(s.code);
    const crossBonus = crossSig
      ? (crossSig.signalType === 'BULLISH' ? crossSig.confidence * 0.08 : -crossSig.confidence * 0.06)
      : 0;

    // BEARISH 크로스마켓 → 매수 스킵
    if (crossSig?.signalType === 'BEARISH' && crossSig.confidence >= 0.6) continue;

    // confidence 보너스/페널티
    const bonus =
      (s.isBigMover ? 0.07 : 0) +
      (s.isMomentum && !s.isBigMover ? 0.05 : 0) +
      ((s.dayRangePct ?? 50) < 25 ? 0.05 : 0) +
      (isBearish ? -0.05 : 0) +
      (isBullish ? 0.02 : 0) +
      crossBonus;

    const cap = (c: number) => Math.min(0.88, Math.max(0, c));
    let matched = false;

    // Pattern 0: 🔥 빅무버 우선진입
    if (!matched && s.isBigMover && s.rsi >= 50 && s.rsi <= 75 && s.adx >= 15) {
      if ((s.dayRangePct ?? 0) < maxDayRange) {
        decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.70 + bonus),
          reasoning: `빅무버 +${s.changePct.toFixed(1)}% RSI=${s.rsi.toFixed(0)} ADX=${s.adx.toFixed(0)} 일중${(s.dayRangePct ?? 0).toFixed(0)}%` });
        matched = true;
      }
    }

    // Pattern 1: 🚀 모멘텀 브레이크아웃
    if (!matched && s.isMomentum && s.rsi >= 50 && s.rsi <= 72 && s.adx >= 20) {
      decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.72 + bonus),
        reasoning: `모멘텀돌파 +${s.changePct.toFixed(1)}% RSI=${s.rsi.toFixed(0)} ADX=${s.adx.toFixed(0)}` });
      matched = true;
    }

    // Pattern 2: 📉 과매도 반등
    if (!matched && s.rsi <= 35 && s.adx >= 20 && s.score > 0 && s.trendStrength !== 'WEAK') {
      decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.67 + bonus),
        reasoning: `과매도반등 RSI=${s.rsi.toFixed(0)} ADX=${s.adx.toFixed(0)} score=${s.score}` });
      matched = true;
    }

    // Pattern 3: 📊 눌림목 재진입
    if (!matched && s.rsi >= 50 && s.rsi <= 65 && s.adx >= 20 && s.score >= 25 && (s.dayRangePct ?? 100) < 40) {
      decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.68 + bonus),
        reasoning: `눌림목재진입 RSI=${s.rsi.toFixed(0)} score=${s.score} 일중${(s.dayRangePct ?? 0).toFixed(0)}%` });
      matched = true;
    }

    // Pattern 4: 💥 고베타 신호
    if (!matched && s.signal === 'STRONG_BUY' && s.rsi >= 50 && s.rsi <= 68 && s.trendStrength !== 'WEAK') {
      decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.65 + bonus),
        reasoning: `강신호 signal=${s.signal} RSI=${s.rsi.toFixed(0)} score=${s.score}` });
      matched = true;
    }

    // Pattern 5: 💪 강한 기술 신호
    if (!matched && s.signal === 'STRONG_BUY' && s.score >= 35 && s.rsi >= 50 && s.rsi <= 65) {
      decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.68 + bonus),
        reasoning: `기술강신호 score=${s.score} RSI=${s.rsi.toFixed(0)} signal=${s.signal}` });
      matched = true;
    }

    // Pattern 6: BB 스퀴즈 돌파
    if (!matched && s.bollingerSqueeze && s.bollingerBreakout === 'UP' && s.rsi >= 50 && s.rsi <= 70 && s.adx >= 18) {
      decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.68 + bonus),
        reasoning: `BB스퀴즈돌파 RSI=${s.rsi.toFixed(0)} ADX=${s.adx.toFixed(0)}` });
      matched = true;
    }

    // Pattern 7: 🌏 크로스마켓 선행 신호 (아시아장 연동)
    if (!matched && crossSig?.signalType === 'BULLISH' && crossSig.confidence >= 0.5 && s.rsi >= 45 && s.rsi <= 72 && s.score >= 0) {
      decisions.push({ code: s.code, action: 'BUY', confidence: cap(0.65 + bonus),
        reasoning: `크로스마켓 아시아${crossSig.asiaCode}${crossSig.asiaChangePct >= 0 ? '+' : ''}${crossSig.asiaChangePct.toFixed(1)}% RSI=${s.rsi.toFixed(0)} conf=${(crossSig.confidence * 100).toFixed(0)}%` });
      matched = true;
    }
  }

  const buys = decisions.filter(d => d.action === 'BUY');
  const sells = decisions.filter(d => d.action === 'SELL');
  logger.info(`📊 규칙기반 해외분석: ${buys.length}BUY ${sells.length}SELL / ${stocks.length}종목 (VIX=${vix} F&G=${fg} breadth=${(breadth * 100).toFixed(0)}%)`, { component: COMP });

  return decisions;
}

function evaluateSell(s: OverseasStockInput): OverseasAIDecision | null {
  const pnl = s.holdingPnlPct ?? 0;

  // 추세 붕괴: score < -25 + STRONG_SELL + WEAK
  if (s.score < -25 && s.signal === 'STRONG_SELL' && s.trendStrength === 'WEAK') {
    return { code: s.code, action: 'SELL', confidence: 0.78,
      reasoning: `추세붕괴 score=${s.score} signal=${s.signal} trend=WEAK` };
  }

  // 선제 손절: PnL < -3% + SELL signal + 강한 추세 반전
  if (pnl <= -3 && (s.signal === 'SELL' || s.signal === 'STRONG_SELL') && s.adx >= 25) {
    return { code: s.code, action: 'SELL', confidence: 0.72,
      reasoning: `선제손절 PnL=${pnl.toFixed(1)}% signal=${s.signal} ADX=${s.adx.toFixed(0)}` };
  }

  // 수익 실현: PnL ≥ 10% + RSI/score 하락 (스윙 목표 15~20% 전에 조기 청산 방지)
  if (pnl >= 10 && s.rsi >= 70 && s.score < -20) {
    return { code: s.code, action: 'SELL', confidence: 0.70,
      reasoning: `수익실현 PnL=${pnl.toFixed(1)}% RSI=${s.rsi.toFixed(0)} score=${s.score}` };
  }

  return null; // HOLD — sell-logic.ts가 SL/TP/ATR 처리
}
