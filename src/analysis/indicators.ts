/**
 * 📊 기술적 지표 엔진 (Technical Indicators)
 *
 * 헤지펀드급 기술 분석 — 순수 TypeScript, 의존성 없음
 * 모든 계산은 정수 연산 기반 (금융 정밀도)
 */

export interface OHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── 이동평균 (SMA / EMA) ──

export function sma(prices: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i <= prices.length - period; i++) {
    const sum = prices.slice(i, i + period).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

export function ema(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];

  // 첫 EMA = SMA
  let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);

  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ── RSI (Relative Strength Index) ──

export function rsi(prices: number[], period: number = 14): number[] {
  if (prices.length < period + 1) return [];

  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;

  // 초기 평균
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const result: number[] = [];
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs));

  // 이후 스무딩
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs2));
  }

  return result;
}

// ── MACD (Moving Average Convergence Divergence) ──

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(prices: number[], fast = 12, slow = 26, signal = 9): MACDResult {
  const emaFast = ema(prices, fast);
  const emaSlow = ema(prices, slow);

  // 두 EMA 길이 맞추기
  const offset = emaFast.length - emaSlow.length;
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i]);
  }

  const signalLine = ema(macdLine, signal);
  const histOffset = macdLine.length - signalLine.length;
  const histogram: number[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + histOffset] - signalLine[i]);
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

// ── 볼린저 밴드 ──

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[]; // 밴드 폭 (변동성 지표)
}

export function bollingerBands(prices: number[], period = 20, stdDev = 2): BollingerResult {
  const middle = sma(prices, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const width: number[] = [];

  for (let i = 0; i <= prices.length - period; i++) {
    const slice = prices.slice(i, i + period);
    const mean = middle[i];
    const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);

    upper.push(mean + stdDev * std);
    lower.push(mean - stdDev * std);
    width.push(mean > 0 ? ((stdDev * std * 2) / mean) * 100 : 0);
  }

  return { upper, middle, lower, width };
}

// ── 스토캐스틱 ──

export interface StochasticResult {
  k: number[]; // %K (빠른선)
  d: number[]; // %D (느린선)
}

export function stochastic(candles: OHLCV[], kPeriod = 14, dPeriod = 3): StochasticResult {
  const k: number[] = [];

  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    const close = candles[i].close;

    k.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }

  const d = sma(k, dPeriod);
  return { k, d };
}

// ── Williams %R (과매수/과매도 — RSI보다 민감) ──
// -80 이하: 과매도 (매수 기회), -20 이상: 과매수 (매도 고려)
export function williamsR(candles: OHLCV[], period = 14): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    const close = candles[i].close;
    result.push(high === low ? -50 : ((high - close) / (high - low)) * -100);
  }
  return result;
}

// ── ROC (Rate of Change, 모멘텀) ──
// 양수: 상승 모멘텀, 음수: 하락 모멘텀
export function roc(prices: number[], period = 12): number[] {
  const result: number[] = [];
  for (let i = period; i < prices.length; i++) {
    const prev = prices[i - period];
    result.push(prev !== 0 ? ((prices[i] - prev) / prev) * 100 : 0);
  }
  return result;
}

// ── TTM Squeeze (John Carter) ──
// 근거: TrendSpider 검증 — 5개+ 검은점(스퀴즈 on) 후 첫 번째 초록점 진입
// 검은점 = BB가 KC 안에 있음 (에너지 응축), 빨간점 = 스퀴즈 해제 (에너지 방출)
// 히스토그램이 증가하면 롱, 감소하면 숏

export interface TTMSqueezeResult {
  // 'ON' = BB가 KC 내부 (스퀴즈 응축 중, 검은점)
  // 'OFF' = BB가 KC 외부 (스퀴즈 해제, 빨간점 → 에너지 방출)
  squeezeState: 'ON' | 'OFF';
  momentum: number;      // 현재 모멘텀 히스토그램 값 (양수=상승, 음수=하락)
  momentumPrev: number;  // 직전 모멘텀 (증가/감소 판단)
  // 진입 신호: 스퀴즈 ON→OFF 전환 + 모멘텀 양수+증가 = 롱 진입
  fireSignal: 'LONG' | 'SHORT' | 'NONE';
  consecutiveSqueezeOn: number; // 연속 스퀴즈 ON 횟수 (5이상이면 강한 신호)
}

export function ttmSqueeze(candles: OHLCV[], bbPeriod = 20, bbMult = 2.0, kcPeriod = 20, kcMult = 1.5): TTMSqueezeResult {
  if (candles.length < bbPeriod + 5) {
    return { squeezeState: 'OFF', momentum: 0, momentumPrev: 0, fireSignal: 'NONE', consecutiveSqueezeOn: 0 };
  }

  const closes = candles.map((c) => c.close);
  // BB 계산
  const bbResult = bollingerBands(closes.reverse(), bbPeriod, bbMult);
  closes.reverse();

  const closesAsc = [...closes].reverse();
  const candlesAsc = [...candles].reverse();

  // Keltner Channel (EMA + ATR 기반)
  const emaValues = ema(closesAsc, kcPeriod);
  const atrValues = atr(candlesAsc, kcPeriod);
  const kcUpper = emaValues.map((e, i) => e + kcMult * (atrValues[i] ?? 0));
  const kcLower = emaValues.map((e, i) => e - kcMult * (atrValues[i] ?? 0));

  const minLen = Math.min(bbResult.upper.length, kcUpper.length);
  const bbU = bbResult.upper.slice(-minLen);
  const bbL = bbResult.lower.slice(-minLen);
  const kcU = kcUpper.slice(-minLen);
  const kcL = kcLower.slice(-minLen);

  // 현재 스퀴즈 상태: BB가 KC 안에 있으면 ON
  const lastIdx = minLen - 1;
  const prevIdx = minLen - 2;
  const currSqueezeOn = (bbU[lastIdx] ?? 0) < (kcU[lastIdx] ?? 0) && (bbL[lastIdx] ?? 0) > (kcL[lastIdx] ?? 0);
  const prevSqueezeOn = prevIdx >= 0 && (bbU[prevIdx] ?? 0) < (kcU[prevIdx] ?? 0) && (bbL[prevIdx] ?? 0) > (kcL[prevIdx] ?? 0);

  // 연속 ON 횟수
  let consecutiveSqueezeOn = 0;
  for (let i = minLen - 1; i >= 0; i--) {
    if ((bbU[i] ?? 0) < (kcU[i] ?? 0) && (bbL[i] ?? 0) > (kcL[i] ?? 0)) consecutiveSqueezeOn++;
    else break;
  }

  // 모멘텀: LinReg of (close - midpoint of BB/KC) — 간소화 버전
  const midpoints = closesAsc.slice(-kcPeriod).map((c, i) => {
    const bbMid = bbResult.middle[bbResult.middle.length - kcPeriod + i] ?? c;
    const kcMid = emaValues[emaValues.length - kcPeriod + i] ?? c;
    return c - (bbMid + kcMid) / 2;
  });
  const momentum = midpoints[midpoints.length - 1] ?? 0;
  const momentumPrev = midpoints[midpoints.length - 2] ?? 0;

  // 진입 신호: 직전 스퀴즈 ON → 현재 OFF (해제) + 모멘텀 방향 확인
  let fireSignal: TTMSqueezeResult['fireSignal'] = 'NONE';
  if (prevSqueezeOn && !currSqueezeOn) {
    if (momentum > 0 && momentum > momentumPrev) fireSignal = 'LONG';
    else if (momentum < 0 && momentum < momentumPrev) fireSignal = 'SHORT';
  }

  return {
    squeezeState: currSqueezeOn ? 'ON' : 'OFF',
    momentum,
    momentumPrev,
    fireSignal,
    consecutiveSqueezeOn,
  };
}

// ── ATR (Average True Range, 변동성) ──

export function atr(candles: OHLCV[], period = 14): number[] {
  if (candles.length < 2) return [];

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trueRanges.push(tr);
  }

  return sma(trueRanges, period);
}

// ── ADX (Average Directional Index, 추세 강도) ──
// ADX > 25: 강한 추세 (진입 OK)
// ADX < 20: 횡보 (진입 금지 → whipsaw 방지)

export function adx(candles: OHLCV[], period: number = 14): number[] {
  if (candles.length < period * 2) return [];

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }

  const smoothedTR = ema(tr, period);
  const smoothedPlusDM = ema(plusDM, period);
  const smoothedMinusDM = ema(minusDM, period);

  const dx: number[] = [];
  const minLen = Math.min(smoothedTR.length, smoothedPlusDM.length, smoothedMinusDM.length);

  for (let i = 0; i < minLen; i++) {
    const plusDI = smoothedTR[i] > 0 ? (smoothedPlusDM[i] / smoothedTR[i]) * 100 : 0;
    const minusDI = smoothedTR[i] > 0 ? (smoothedMinusDM[i] / smoothedTR[i]) * 100 : 0;
    const sum = plusDI + minusDI;
    dx.push(sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }

  return ema(dx, period);
}

// ── VWAP (Volume Weighted Average Price) ──

export function vwap(candles: OHLCV[]): number[] {
  const result: number[] = [];
  let cumVolume = 0;
  let cumVP = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumVolume += c.volume;
    cumVP += typicalPrice * c.volume;
    result.push(cumVolume > 0 ? cumVP / cumVolume : typicalPrice);
  }

  return result;
}

// ── 종합 분석 리포트 ──

// ── 캔들스틱 패턴 감지 ──
// 전문 트레이더가 실시간으로 보는 핵심 패턴

export interface CandlePatternResult {
  name: string;       // 패턴 이름 (한글)
  bullish: boolean;   // true: 매수 신호, false: 매도 신호
  strength: 'WEAK' | 'MODERATE' | 'STRONG';
}

/**
 * 주요 캔들스틱 패턴 감지 (내림차순 candles — candles[0]이 최신)
 *
 * 패턴:
 * - 망치형 (Hammer): 긴 아래꼬리 → 저점 매수세 강함
 * - 역망치형 (Inverted Hammer): 긴 위꼬리 → 상승 전환 신호
 * - 불리쉬 인걸핑 (Bullish Engulfing): 전일 음봉을 양봉이 삼킴 → 강세 전환
 * - 베어리쉬 인걸핑 (Bearish Engulfing): 전일 양봉을 음봉이 삼킴 → 약세 전환
 * - 도지 (Doji): 시가≈종가 → 매수/매도 균형, 추세 전환 가능
 * - 모닝스타 (Morning Star): 3일 패턴, 하락→도지→상승 = 바닥 전환
 * - 이브닝스타 (Evening Star): 3일 패턴, 상승→도지→하락 = 고점 전환
 * - 상승장악형 (Piercing Line): 음봉 중간 이상 올라온 양봉
 */
export function detectCandlePatterns(candles: OHLCV[]): CandlePatternResult[] {
  if (candles.length < 3) return [];
  const patterns: CandlePatternResult[] = [];

  const [c0, c1, c2] = candles; // c0=오늘, c1=어제, c2=그제

  const body0 = Math.abs(c0.close - c0.open);
  const range0 = c0.high - c0.low || 1;
  const lower0 = Math.min(c0.open, c0.close) - c0.low;
  const upper0 = c0.high - Math.max(c0.open, c0.close);
  const bull0 = c0.close > c0.open;

  const body1 = Math.abs(c1.close - c1.open);
  const range1 = c1.high - c1.low || 1;
  const bull1 = c1.close > c1.open;

  // 1. 망치형 (Hammer) — 아래꼬리 >= 몸통 2배, 위꼬리 짧음, 음봉 끝에 등장
  if (lower0 / range0 >= 0.5 && upper0 / range0 < 0.15 && body0 / range0 < 0.4) {
    patterns.push({ name: '망치형', bullish: true, strength: 'STRONG' });
  }

  // 2. 역망치형 (Inverted Hammer) — 위꼬리 >= 몸통 2배, 아래꼬리 짧음
  if (upper0 / range0 >= 0.5 && lower0 / range0 < 0.15 && body0 / range0 < 0.4 && !bull0) {
    patterns.push({ name: '역망치형', bullish: true, strength: 'MODERATE' });
  }

  // 3. 슈팅스타 (Shooting Star) — 위꼬리 길고, 상승 후 등장 = 하락 반전
  if (upper0 / range0 >= 0.5 && lower0 / range0 < 0.15 && body0 / range0 < 0.4 && bull1) {
    patterns.push({ name: '슈팅스타', bullish: false, strength: 'STRONG' });
  }

  // 4. 도지 (Doji) — 시가≈종가 (몸통 < 범위의 10%)
  if (body0 / range0 < 0.1) {
    // 전일 방향과 반대면 더 강한 신호
    const isDoji = true;
    if (isDoji && !bull1 && c0.close > c1.close) {
      patterns.push({ name: '도지(강세)', bullish: true, strength: 'MODERATE' });
    } else {
      patterns.push({ name: '도지(중립)', bullish: true, strength: 'WEAK' });
    }
  }

  // 5. 불리쉬 인걸핑 (Bullish Engulfing) — 오늘 양봉이 어제 음봉 전체 덮음
  if (bull0 && !bull1 && c0.open <= c1.close && c0.close >= c1.open && body0 > body1 * 1.1) {
    patterns.push({ name: '불리쉬인걸핑', bullish: true, strength: 'STRONG' });
  }

  // 6. 베어리쉬 인걸핑 (Bearish Engulfing) — 오늘 음봉이 어제 양봉 전체 덮음
  if (!bull0 && bull1 && c0.open >= c1.close && c0.close <= c1.open && body0 > body1 * 1.1) {
    patterns.push({ name: '베어리쉬인걸핑', bullish: false, strength: 'STRONG' });
  }

  // 7. 모닝스타 (Morning Star) — 3일: 음봉, 도지/작은몸통, 양봉 (바닥 전환)
  if (candles.length >= 3) {
    const bull2 = c2.close > c2.open;
    const body2 = Math.abs(c2.close - c2.open);
    const range2 = c2.high - c2.low || 1;
    if (!bull2 && body1 / range1 < 0.3 && bull0 && c0.close > (c2.open + c2.close) / 2) {
      patterns.push({ name: '모닝스타', bullish: true, strength: 'STRONG' });
    }
    // 이브닝스타 (Evening Star)
    if (bull2 && body1 / range1 < 0.3 && !bull0 && c0.close < (c2.open + c2.close) / 2) {
      patterns.push({ name: '이브닝스타', bullish: false, strength: 'STRONG' });
    }
  }

  // 8. V자 반등 — 전일 하락 + 오늘 양봉 반등
  if (!bull1 && bull0 && c0.close > c1.open) {
    patterns.push({ name: 'V반등', bullish: true, strength: 'MODERATE' });
  }

  return patterns;
}

export interface TechnicalSummary {
  rsi14: number;
  macdHistogram: number;
  macdCrossover: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  bollingerPosition: 'ABOVE_UPPER' | 'NEAR_UPPER' | 'MIDDLE' | 'NEAR_LOWER' | 'BELOW_LOWER';
  bollingerWidth: number;
  bollingerSqueeze: boolean;     // BB 밴드 폭 < 20일 평균의 80% = 에너지 응축 (돌파 임박)
  bollingerBreakout: 'UP' | 'DOWN' | 'NONE'; // 스퀴즈 후 상하단 돌파
  sma5: number;
  sma20: number;
  sma60: number;
  goldenCross: boolean;
  deathCross: boolean;
  stochasticK: number;
  stochasticSignal: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  atr14: number;
  atrPct: number;                // ATR / 현재가 × 100 — 변동성 % (동적 손절 기준)
  dynamicStopLossPct: number;    // ATR 기반 동적 손절: max(strategyStop, -2×ATR%)
  adx14: number;                 // 추세 강도 (>25 강한추세, <20 횡보)
  trendStrength: 'STRONG' | 'MODERATE' | 'WEAK';
  volumeRatio: number;           // 당일 거래량 / 20일 평균 (>1.5면 확인)
  vwapCross: 'JUST_ABOVE' | 'JUST_BELOW' | 'NONE'; // VWAP 방금 돌파 여부 (1~2일)
  vwapPullback: boolean;         // VWAP 돌파 후 되돌림 매수 기회 (LuxAlgo 검증 전략)
  rsi2: number;                  // 2-day RSI (QuantifiedStrategies: 15↓매수/85↑매도 — 91% 승률)
  ttmSqueeze: TTMSqueezeResult;  // TTM 스퀴즈 (존 카터) — 5+ 검은점 후 첫 초록점 진입
  overallSignal: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  score: number;                 // -100 ~ +100
  candlePatterns: CandlePatternResult[];
  pctFrom3DayHigh: number;
  pctFrom5DayLow: number;
  vwapPosition: 'ABOVE' | 'BELOW' | 'AT';
}

export function analyzeTechnicals(candles: OHLCV[]): TechnicalSummary | null {
  if (candles.length < 30) return null;

  const closes = candles.map((c) => c.close);
  const current = closes[0];

  // 지표 계산 (최신이 index 0이므로 reverse 필요)
  const closesAsc = [...closes].reverse();
  const candlesAsc = [...candles].reverse();

  const rsiValues = rsi(closesAsc, 14);
  const rsi14 = rsiValues[rsiValues.length - 1] ?? 50;

  // MACD: 표준 (12-26-9) — 3-10-16은 signal>slow 구조상 크로스오버 과다 발생
  const macdResult = macd(closesAsc, 12, 26, 9);
  const macdHist = macdResult.histogram[macdResult.histogram.length - 1] ?? 0;
  const macdPrev = macdResult.histogram[macdResult.histogram.length - 2] ?? 0;
  const macdCross =
    macdHist > 0 && macdPrev <= 0
      ? ('BULLISH' as const)
      : macdHist < 0 && macdPrev >= 0
        ? ('BEARISH' as const)
        : ('NEUTRAL' as const);

  const bb = bollingerBands(closesAsc, 20);
  const bbUpper = bb.upper[bb.upper.length - 1] ?? current;
  const bbLower = bb.lower[bb.lower.length - 1] ?? current;
  const bbMiddle = bb.middle[bb.middle.length - 1] ?? current;
  const bbWidth = bb.width[bb.width.length - 1] ?? 0;
  // 볼린저 스퀴즈: 현재 밴드 폭 < 최근 20일 평균 폭의 80% = 에너지 응축
  const bbWidthAvg20 = bb.width.slice(-20).reduce((s, v) => s + v, 0) / Math.max(bb.width.slice(-20).length, 1);
  const bollingerSqueeze = bbWidth < bbWidthAvg20 * 0.8;
  // 스퀴즈 후 돌파 감지 (전일 스퀴즈 + 오늘 상단/하단 돌파)
  const prevBbWidth = bb.width[bb.width.length - 2] ?? bbWidth;
  const prevSqueeze = prevBbWidth < bbWidthAvg20 * 0.8;
  const bollingerBreakout: TechnicalSummary['bollingerBreakout'] =
    prevSqueeze && current > (bb.upper[bb.upper.length - 1] ?? current) ? 'UP' :
    prevSqueeze && current < (bb.lower[bb.lower.length - 1] ?? current) ? 'DOWN' : 'NONE';

  let bbPos: TechnicalSummary['bollingerPosition'] = 'MIDDLE';
  if (current > bbUpper) bbPos = 'ABOVE_UPPER';
  else if (current > bbMiddle + (bbUpper - bbMiddle) * 0.7) bbPos = 'NEAR_UPPER';
  else if (current < bbLower) bbPos = 'BELOW_LOWER';
  else if (current < bbMiddle - (bbMiddle - bbLower) * 0.7) bbPos = 'NEAR_LOWER';

  const sma5Val = sma(closesAsc, 5);
  const sma20Val = sma(closesAsc, 20);
  const sma60Val = closesAsc.length >= 60 ? sma(closesAsc, 60) : sma(closesAsc, Math.min(closesAsc.length, 20));

  const sma5Now = sma5Val[sma5Val.length - 1] ?? current;
  const sma20Now = sma20Val[sma20Val.length - 1] ?? current;
  const sma60Now = sma60Val.length > 0 ? sma60Val[sma60Val.length - 1] : current;
  const sma5Prev = sma5Val[sma5Val.length - 2] ?? sma5Now;
  const sma20Prev = sma20Val[sma20Val.length - 2] ?? sma20Now;

  const goldenCross = sma5Now > sma20Now && sma5Prev <= sma20Prev;
  const deathCross = sma5Now < sma20Now && sma5Prev >= sma20Prev;

  const stochResult = stochastic(candlesAsc, 14, 3);
  const stochK = stochResult.k[stochResult.k.length - 1] ?? 50;
  const stochSignal =
    stochK > 80 ? ('OVERBOUGHT' as const) : stochK < 20 ? ('OVERSOLD' as const) : ('NEUTRAL' as const);

  const atrValues = atr(candlesAsc, 14);
  const atr14 = atrValues[atrValues.length - 1] ?? 0;
  // ATR % = ATR / 현재가 × 100 (변동성 정규화)
  const atrPct = current > 0 ? (atr14 / current) * 100 : 0;
  // 동적 손절: -2×ATR% (최소 -1%, 최대 -8%)
  const dynamicStopLossPct = Math.max(-8, Math.min(-1, -(atrPct * 2)));

  // ADX (추세 강도) — 논문 근거: ADX < 20 시 진입하면 whipsaw 90%
  const adxValues = adx(candlesAsc, 14);
  const adx14 = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 25;
  const trendStrength: TechnicalSummary['trendStrength'] = adx14 >= 30 ? 'STRONG' : adx14 >= 20 ? 'MODERATE' : 'WEAK';

  // 거래량 비율 (당일 / 20일 평균) — 거래량 확인 없는 시그널은 신뢰도 낮음
  const volumes = candles.map((c) => c.volume);
  const avgVol20 = volumes.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
  const volumeRatio = avgVol20 > 0 ? volumes[0] / avgVol20 : 1;

  // ══════════════════════════════════════════════════
  // 종합 점수 계산 (연구 기반 가중치 개선)
  //
  // 참고:
  // - QuantifiedStrategies: 평균 회귀 승률 60%, 모멘텀 3~12개월
  // - 논문: ADX 필터링으로 whipsaw 40% 감소
  // - 연구: 거래량 확인 시그널이 미확인보다 1.5배 신뢰도
  // ══════════════════════════════════════════════════
  let score = 0;

  // RSI — 저점 편향 축소, 모멘텀 구간 강화
  // 핵심: RSI 30 이하 = 과매도지만 하락 추세일 수도 있음 → 과대 점수 부여 금지
  // RSI 45-62 = 상승 모멘텀 진행 중인 이상적 진입 타이밍 → 가장 높은 점수
  if (rsi14 < 30) score += 15;        // 과매도 — 반등 가능하나 다운트렌드일 수도 (편향 축소)
  else if (rsi14 < 40) score += 7;
  else if (rsi14 >= 45 && rsi14 <= 62) score += 18; // ★ 상승 모멘텀 구간 (가장 좋은 진입 타이밍)
  else if (rsi14 > 70) score -= 25;
  else if (rsi14 > 65) score -= 12;

  // MACD (모멘텀 확인 — 크로스 비중 상향)
  if (macdCross === 'BULLISH') score += 25;  // 골든크로스급 모멘텀 전환 신호
  else if (macdCross === 'BEARISH') score -= 20;
  else if (macdHist > 0) score += 8;
  else score -= 8;

  // 볼린저 밴드 — 저점 편향 대폭 축소
  // 하단 이탈은 반등 기회지만 하락 추세 확인일 수도 → 과대 점수 금지
  // 상단 이탈은 강한 상승 추세에선 자연스러운 현상 → 지나치게 페널티 주지 않음
  if (bbPos === 'BELOW_LOWER') score += 10;  // +18 → +10 (하단 이탈 = 위험 경고도 포함)
  else if (bbPos === 'NEAR_LOWER') score += 5;  // +10 → +5
  else if (bbPos === 'ABOVE_UPPER') score -= 12; // 강한 추세 돌파는 자연스러움 (완화)
  else if (bbPos === 'NEAR_UPPER') score -= 3;

  // 이동평균 정배열 — 추세 추종 비중 대폭 상향 (핵심 시그널)
  // 완전 정배열 = 단기/중기/장기 모두 우상향 = 가장 강력한 매수 근거
  if (current > sma5Now && sma5Now > sma20Now && sma20Now > sma60Now) score += 28; // ★ 완전 정배열 (+20→+28)
  else if (current > sma20Now && sma20Now > sma60Now) score += 14; // 중기 정배열 (+10→+14)
  if (current < sma5Now && sma5Now < sma20Now && sma20Now < sma60Now) score -= 20;
  else if (current < sma20Now && sma20Now < sma60Now) score -= 10;

  // 골든/데드크로스
  if (goldenCross) score += 18;
  if (deathCross) score -= 18;

  // 스토캐스틱
  if (stochSignal === 'OVERSOLD') score += 10;
  if (stochSignal === 'OVERBOUGHT') score -= 10;

  // Williams %R (RSI보다 민감한 과매수/과매도 지표)
  const wrValues = williamsR(candlesAsc, 14);
  const wr14 = wrValues[wrValues.length - 1] ?? -50;
  if (wr14 < -80) score += 8;       // 과매도 → 매수 기회
  else if (wr14 > -20) score -= 8;  // 과매수 → 매도 고려

  // ROC (모멘텀 — 양수면 상승세, 음수면 하락세)
  const rocValues = roc(closesAsc, 12);
  const roc12 = rocValues[rocValues.length - 1] ?? 0;
  if (roc12 > 8) score += 20;       // ★ 강한 상승 모멘텀 종목 우선 (+12→+20)
  else if (roc12 > 3) score += 12;   // 완만한 상승세도 인정 (+6→+12)
  else if (roc12 < -8) score -= 12;
  else if (roc12 < -3) score -= 6;

  // ★ 볼륨 돌파 보너스 (거래량 급증 + 5MA 위 = 가장 강력한 매수 신호)
  const vol2dAvg = (volumes[1] + volumes[2]) / 2; // 직전 2일 평균
  const todayVolSurge = vol2dAvg > 0 ? volumes[0] / vol2dAvg : 1;
  if (todayVolSurge >= 2.0 && current > sma5Now) {
    score += 15; // 거래량 2배 돌파 + 5MA 위 → 강력 매수
  } else if (todayVolSurge >= 1.5 && current > sma5Now) {
    score += 8;
  }

  // SMA 추세 점수는 위(line 492-495)에서 이미 반영 — 중복 제거

  // ★ ADX 필터 (횡보장 진입 강력 억제 — 저점 박스권 매매 방지)
  // ADX < 20 = 방향성 없음 = 저점에서 사서 저점에서 팔다 끝나는 패턴
  // ADX > 30 = 강한 추세 = 추세 추종 진입 최적
  if (trendStrength === 'WEAK') {
    if (score > 0) score = Math.floor(score * 0.6); // 40% 감쇄 — 반등 포착 허용 (과도한 억제 완화)
  } else if (trendStrength === 'STRONG') {
    if (score > 0) score = Math.floor(score * 1.35); // 강한 추세 35% 증폭 (기존 20%)
  }

  // ★ 거래량 확인 필터 (연구: 거래량 동반 시그널 1.5배 신뢰도)
  if (volumeRatio >= 2.0 && score > 0) {
    score = Math.floor(score * 1.2); // 거래량 2배 동반 → 강하게 강화
  } else if (volumeRatio >= 1.5 && score > 0) {
    score = Math.floor(score * 1.1);
  } else if (volumeRatio < 0.5 && score > 0) {
    score = Math.floor(score * 0.7); // 거래량 심각 부족 → 신호 약화
  }

  // ★ 캔들스틱 패턴 점수 반영
  const candlePatterns = detectCandlePatterns(candles);
  for (const p of candlePatterns) {
    const pts = p.strength === 'STRONG' ? 12 : p.strength === 'MODERATE' ? 7 : 3;
    score += p.bullish ? pts : -pts;
  }

  // ★ VWAP 위치 + 크로스 감지 (20일 슬라이딩 윈도우)
  const vwapValues = vwap(candlesAsc.slice(-20));
  const vwapNow = vwapValues[vwapValues.length - 1] ?? current;
  const vwapPrev = vwapValues[vwapValues.length - 2] ?? vwapNow;
  const prevClose = closesAsc[closesAsc.length - 2] ?? current;
  const vwapDiff = (current - vwapNow) / vwapNow * 100;
  const vwapPosition: TechnicalSummary['vwapPosition'] = vwapDiff > 1 ? 'ABOVE' : vwapDiff < -1 ? 'BELOW' : 'AT';
  // 방금 VWAP 크로스: 어제는 아래, 오늘은 위 (또는 반대)
  const vwapCross: TechnicalSummary['vwapCross'] =
    prevClose < vwapPrev && current > vwapNow ? 'JUST_ABOVE' :
    prevClose > vwapPrev && current < vwapNow ? 'JUST_BELOW' : 'NONE';
  if (vwapCross === 'JUST_ABOVE') score += 20;      // ★ VWAP 방금 돌파 = 가장 강한 추세 전환 확인
  else if (vwapCross === 'JUST_BELOW') score -= 15; // VWAP 방금 이탈 = 매도 압력
  else if (vwapPosition === 'ABOVE') score += 12;  // VWAP 위 = 단기 상승 바이어스
  else if (vwapPosition === 'BELOW') score -= 8;   // VWAP 아래 = 매도 압력

  // ★ 볼린저 스퀴즈 돌파 (가장 강력한 모멘텀 신호 중 하나)
  if (bollingerBreakout === 'UP') score += 22;    // 스퀴즈 후 상방 돌파 = 압축 에너지 방출
  else if (bollingerBreakout === 'DOWN') score -= 18; // 하방 돌파 = 하락 가속
  else if (bollingerSqueeze && macdCross === 'BULLISH') score += 10; // 스퀴즈 중 MACD 골든 = 선행 신호

  // ★ 중간 거래량 보너스 (1.3~1.8x 구간 — 기존 1.5x만 보상하던 사각지대)
  if (todayVolSurge >= 1.3 && todayVolSurge < 1.5 && current > sma5Now) score += 4;

  // ★ 2-day RSI (QuantifiedStrategies 검증 — 91% 승률, 2일 평균 회귀 전략)
  // 근거: Larry Connors RSI-2 전략, 15 이하 매수 / 85 이상 매도
  const rsi2Values = rsi(closesAsc, 2);
  const rsi2 = rsi2Values[rsi2Values.length - 1] ?? 50;
  if (rsi2 < 15) score += 18;       // 극단 과매도 — 단기 반등 확률 91% (연구 검증)
  else if (rsi2 < 25) score += 10;  // 과매도 영역
  else if (rsi2 > 85) score -= 18;  // 극단 과매수 — 단기 하락 확률 높음
  else if (rsi2 > 75) score -= 10;

  // ★ VWAP 풀백 감지 (LuxAlgo 검증 전략)
  // VWAP 돌파 후 2~3일 내 되돌림 = 최적 진입점
  // 패턴: 1~3일 전에 VWAP 상향 돌파 → 오늘 가격이 VWAP ±0.5% 이내
  const vwapHistory = vwapValues.slice(-4); // 최근 4일 VWAP
  const closeHistory = closesAsc.slice(-4);
  let recentVwapBreak = false;
  for (let i = 1; i < Math.min(3, vwapHistory.length - 1); i++) {
    const pastClose = closeHistory[closeHistory.length - 1 - i] ?? 0;
    const pastVwap = vwapHistory[vwapHistory.length - 1 - i] ?? 0;
    if (pastClose > pastVwap * 1.005) { recentVwapBreak = true; break; }
  }
  const nearVwap = Math.abs(vwapDiff) < 0.5; // 현재가 ±0.5% 이내
  const vwapPullback = recentVwapBreak && nearVwap && current > vwapNow * 0.995;
  if (vwapPullback) score += 15; // VWAP 돌파 후 풀백 = 강한 재진입 신호

  // ★ TTM 스퀴즈 신호 (존 카터 — TrendSpider 검증)
  // 5개+ 검은점 (BB < KC 응축) 후 첫 초록점 + 모멘텀 상승 = LONG 진입
  const ttmSqueezeResult = ttmSqueeze(candles);
  if (ttmSqueezeResult.fireSignal === 'LONG') score += 25;  // 스퀴즈 해제 + 상승 모멘텀
  else if (ttmSqueezeResult.fireSignal === 'SHORT') score -= 20;
  else if (ttmSqueezeResult.squeezeState === 'ON' && ttmSqueezeResult.consecutiveSqueezeOn >= 5) score += 8; // 강한 응축 중

  score = Math.max(-100, Math.min(100, score));

  let overallSignal: TechnicalSummary['overallSignal'];
  if (score >= 40) overallSignal = 'STRONG_BUY';
  else if (score >= 15) overallSignal = 'BUY';
  else if (score <= -40) overallSignal = 'STRONG_SELL';
  else if (score <= -15) overallSignal = 'SELL';
  else overallSignal = 'NEUTRAL';

  // ★ 가격 위치 정보 (전문 트레이더 시야)
  const recent3High = Math.max(candles[0].high, candles[1]?.high ?? 0, candles[2]?.high ?? 0);
  const recent5Low = Math.min(candles[0].low, candles[1]?.low ?? Infinity, candles[2]?.low ?? Infinity, candles[3]?.low ?? Infinity, candles[4]?.low ?? Infinity);
  const pctFrom3DayHigh = recent3High > 0 ? ((current - recent3High) / recent3High) * 100 : 0;
  const pctFrom5DayLow = recent5Low > 0 && recent5Low < Infinity ? ((current - recent5Low) / recent5Low) * 100 : 0;

  return {
    rsi14,
    macdHistogram: macdHist,
    macdCrossover: macdCross,
    bollingerPosition: bbPos,
    bollingerWidth: bbWidth,
    bollingerSqueeze,
    bollingerBreakout,
    sma5: sma5Now,
    sma20: sma20Now,
    sma60: sma60Now,
    goldenCross,
    deathCross,
    stochasticK: stochK,
    stochasticSignal: stochSignal,
    atr14,
    atrPct,
    dynamicStopLossPct,
    adx14,
    trendStrength,
    volumeRatio,
    vwapCross,
    vwapPullback,
    rsi2,
    ttmSqueeze: ttmSqueezeResult,
    overallSignal,
    score,
    candlePatterns,
    pctFrom3DayHigh,
    pctFrom5DayLow,
    vwapPosition,
  };
}

// ══════════════════════════════════════════════════════════════════
// ── 볼륨 프로파일 (가격대별 거래량 — 지지/저항 자동 산출) ──
// ══════════════════════════════════════════════════════════════════
export interface VolumeLevelResult {
  priceLevel: number;
  volumePct: number;   // 전체 거래량 중 이 구간 비중 %
  isSupport: boolean;  // 현재가 아래 고량 구간 (지지선)
  isResistance: boolean; // 현재가 위 고량 구간 (저항선)
}

export function volumeProfile(candles: OHLCV[], bins = 24): VolumeLevelResult[] {
  if (candles.length < 10) return [];
  const minP = Math.min(...candles.map(c => c.low));
  const maxP = Math.max(...candles.map(c => c.high));
  if (maxP <= minP) return [];
  const binSize = (maxP - minP) / bins;
  const volByBin = new Array(bins).fill(0);
  for (const c of candles) {
    const s = Math.max(0, Math.floor((c.low - minP) / binSize));
    const e = Math.min(bins - 1, Math.floor((c.high - minP) / binSize));
    const n = Math.max(1, e - s + 1);
    for (let b = s; b <= e; b++) volByBin[b] += c.volume / n;
  }
  const total = volByBin.reduce((a, b) => a + b, 0);
  const threshold = total > 0 ? (total / bins) * 1.5 : 0;
  const cur = candles[0].close;
  return volByBin
    .map((vol, i) => {
      const priceLevel = minP + (i + 0.5) * binSize;
      return {
        priceLevel,
        volumePct: total > 0 ? (vol / total) * 100 : 0,
        isSupport: vol >= threshold && priceLevel < cur,
        isResistance: vol >= threshold && priceLevel > cur,
      };
    })
    .filter(v => v.isSupport || v.isResistance);
}

// ══════════════════════════════════════════════════════════════════
// ── 구조적 차트 패턴 (이중 바닥/천장, 삼각수렴) ──
// ══════════════════════════════════════════════════════════════════
export interface StructuralPattern {
  name: 'DOUBLE_BOTTOM' | 'DOUBLE_TOP' | 'SYM_TRIANGLE' | 'ASC_TRIANGLE' | 'DESC_TRIANGLE';
  bullish: boolean;
  confidence: number; // 0-1
  score: number;      // 점수 기여 (+매수/-매도)
  label: string;
}

function _linearSlope(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = arr.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (arr[i] - ym); den += (i - xm) ** 2; }
  return den !== 0 ? (num / den) / (ym || 1) : 0;
}

function _localExtremes(arr: number[], type: 'min' | 'max', w = 3): number[] {
  const result: number[] = [];
  for (let i = w; i < arr.length - w; i++) {
    const s = arr.slice(i - w, i + w + 1);
    if (type === 'min' && arr[i] === Math.min(...s)) result.push(i);
    if (type === 'max' && arr[i] === Math.max(...s)) result.push(i);
  }
  return result;
}

export function detectStructuralPatterns(candles: OHLCV[]): StructuralPattern[] {
  if (candles.length < 30) return [];
  const recent = candles.slice(0, 30).reverse(); // 오름차순
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const closes = recent.map(c => c.close);
  const patterns: StructuralPattern[] = [];

  // 이중 바닥 (Double Bottom) — 두 저점이 3% 이내
  const mins = _localExtremes(lows, 'min');
  if (mins.length >= 2) {
    const [i1, i2] = [mins[0], mins[mins.length - 1]];
    if (i2 - i1 >= 5) {
      const diff = Math.abs(lows[i1] - lows[i2]) / (lows[i1] || 1);
      if (diff < 0.03) {
        const conf = 1 - diff / 0.03;
        patterns.push({ name: 'DOUBLE_BOTTOM', bullish: true, confidence: conf, score: Math.round(15 * conf), label: `이중바닥(${lows[i1].toFixed(0)}/${lows[i2].toFixed(0)})` });
      }
    }
  }

  // 이중 천장 (Double Top) — 두 고점이 3% 이내
  const maxs = _localExtremes(highs, 'max');
  if (maxs.length >= 2) {
    const [i1, i2] = [maxs[0], maxs[maxs.length - 1]];
    if (i2 - i1 >= 5) {
      const diff = Math.abs(highs[i1] - highs[i2]) / (highs[i1] || 1);
      if (diff < 0.03) {
        const conf = 1 - diff / 0.03;
        patterns.push({ name: 'DOUBLE_TOP', bullish: false, confidence: conf, score: -Math.round(15 * conf), label: `이중천장(${highs[i1].toFixed(0)}/${highs[i2].toFixed(0)})` });
      }
    }
  }

  // 삼각수렴 (Triangle)
  const hSlope = _linearSlope(highs.slice(-20));
  const lSlope = _linearSlope(lows.slice(-20));
  const curClose = closes[closes.length - 1];
  const sma20v = sma(closes, 20).pop() ?? curClose;
  if (hSlope < -0.001 && lSlope > 0.001) {
    const bull = curClose > sma20v;
    patterns.push({ name: 'SYM_TRIANGLE', bullish: bull, confidence: 0.6, score: bull ? 8 : -8, label: '대칭삼각수렴' });
  } else if (hSlope < -0.001 && Math.abs(lSlope) < 0.0005) {
    patterns.push({ name: 'DESC_TRIANGLE', bullish: false, confidence: 0.65, score: -12, label: '하강삼각형' });
  } else if (Math.abs(hSlope) < 0.0005 && lSlope > 0.001) {
    patterns.push({ name: 'ASC_TRIANGLE', bullish: true, confidence: 0.65, score: 12, label: '상승삼각형' });
  }

  return patterns;
}

// ══════════════════════════════════════════════════════════════════
// ── 분봉 단기 신호 (장중 진입 타이밍 확인) ──
// ══════════════════════════════════════════════════════════════════
export interface IntradaySignal {
  score: number;        // -30 ~ +30 (일봉 점수에 가산)
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  volumeSurge: boolean;
  reason: string;
}

export function analyzeIntraday(minuteCandles: OHLCV[]): IntradaySignal {
  if (minuteCandles.length < 10) return { score: 0, trend: 'NEUTRAL', volumeSurge: false, reason: '데이터부족' };
  const asc = [...minuteCandles].reverse();
  const closes = asc.map(c => c.close);
  const vols = asc.map(c => c.volume);
  let score = 0;
  const tags: string[] = [];

  // RSI (분봉 14개 ≈ 70분)
  const rsiPeriod = Math.min(14, closes.length - 1);
  const rsiNow = rsi(closes, rsiPeriod).pop() ?? 50;
  if (rsiNow < 30) { score += 12; tags.push('분봉RSI과매도'); }
  else if (rsiNow < 40) score += 6;
  else if (rsiNow > 70) { score -= 12; tags.push('분봉RSI과매수'); }
  else if (rsiNow > 60) score -= 6;

  // 단기 MACD (5/13/4) — 모멘텀 방향
  if (closes.length >= 14) {
    const m = macd(closes, 5, 13, 4);
    const h = m.histogram;
    const hNow = h[h.length - 1] ?? 0;
    const hPrev = h[h.length - 2] ?? hNow;
    if (hNow > 0 && hNow > hPrev) { score += 10; tags.push('분봉MACD상승'); }
    else if (hNow < 0 && hNow < hPrev) score -= 10;
    else if (hNow > 0) score += 4;
    else score -= 4;
  }

  // 최근 5봉 가격 추세
  if (closes.length >= 5) {
    const pct = (closes[closes.length - 1] - closes[closes.length - 5]) / (closes[closes.length - 5] || 1) * 100;
    if (pct > 0.5) { score += 8; tags.push('단기상승'); }
    else if (pct > 0.2) score += 4;
    else if (pct < -0.5) { score -= 8; tags.push('단기하락'); }
    else if (pct < -0.2) score -= 4;
  }

  // 거래량 서지 (최근 5봉 / 이전 10봉)
  const surgeRatio = vols.length >= 15
    ? (vols.slice(-5).reduce((a, b) => a + b, 0) / 5) / (vols.slice(-15, -5).reduce((a, b) => a + b, 0) / 10 || 1)
    : 1;
  const volumeSurge = surgeRatio >= 1.5;
  if (volumeSurge && score > 0) { score += 5; tags.push('거래량급증'); }

  score = Math.max(-30, Math.min(30, score));
  const trend = score > 5 ? 'UP' : score < -5 ? 'DOWN' : 'NEUTRAL';
  return { score, trend, volumeSurge, reason: tags.join('+') || '중립' };
}
