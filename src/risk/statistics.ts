/**
 * 통계 유틸리티 — PSR, DSR, 왜도/첨도, 정규분포 CDF
 *
 * 레퍼런스:
 *   PSR/MinTRL: Bailey & López de Prado, "The Sharpe Ratio Efficient Frontier", 2012
 *   DSR: 동저자, "The Deflated Sharpe Ratio", 2014
 */

// ── Normal CDF — Abramowitz & Stegun (error < 7.5e-8) ──

export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y =
    1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp((-absX * absX) / 2);
  return 0.5 * (1 + sign * y);
}

// ── Inverse Normal CDF — Beasley-Springer-Moro ──

export function normalInvCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

// ── Moments ──

/** 표본 왜도 γ₃ (biased estimator — PSR 공식 준거) */
export function sampleSkewness(arr: number[]): number {
  const n = arr.length;
  if (n < 3) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return arr.reduce((s, v) => s + ((v - mean) / std) ** 3, 0) / n;
}

/** 표본 첨도 γ₄ (full kurtosis, normal=3 — PSR 공식 준거) */
export function sampleKurtosis(arr: number[]): number {
  const n = arr.length;
  if (n < 4) return 3;
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return 3;
  return arr.reduce((s, v) => s + ((v - mean) / std) ** 4, 0) / n;
}

// ── PSR (Probabilistic Sharpe Ratio) ──

/**
 * PSR = Φ( (SR_hat - SR*) × √(n-1) / √(1 - γ₃·SR_hat + (γ₄-1)/4·SR_hat²) )
 *
 * @param srHat - 비연환산 일별 샤프 (sample)
 * @param srStar - 벤치마크 샤프 (기본 0)
 * @param n - 관측수
 * @param skew - γ₃ (일별 수익률 왜도)
 * @param kurt - γ₄ (일별 수익률 첨도, normal=3)
 */
export function computePSR(
  srHat: number,
  srStar: number,
  n: number,
  skew: number,
  kurt: number,
): number {
  if (n < 3 || srHat <= srStar) return 0;
  const denomInner = 1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat;
  if (denomInner <= 0) return 0;
  const z = ((srHat - srStar) * Math.sqrt(n - 1)) / Math.sqrt(denomInner);
  return normalCdf(z);
}

/**
 * MinTRL — 현재 SR이 SR*보다 유의하게 크다고 판정하기 위한 최소 관측수
 * MinTRL = 1 + (1 - γ₃·SR_hat + (γ₄-1)/4·SR_hat²) × (z_{0.95} / (SR_hat - SR*))²
 */
export function computeMinTRL(
  srHat: number,
  srStar: number,
  skew: number,
  kurt: number,
): number {
  if (srHat <= srStar) return Infinity;
  const z95 = 1.645;
  const varFactor = 1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat;
  if (varFactor <= 0) return Infinity;
  return Math.ceil(1 + varFactor * (z95 / (srHat - srStar)) ** 2);
}

// ── DSR (Deflated Sharpe Ratio) ──

const EULER_MASCHERONI = 0.5772156649;

/**
 * DSR = PSR(SR*) where SR* = 우연히 N회 시도에서 기대되는 최대 SR
 *
 * SR* ≈ √(V[SR_trials]) × ( (1-γ)·Φ⁻¹(1 - 1/N) + γ·Φ⁻¹(1 - 1/(N·e)) )
 *
 * @param srHat - 선정된 최고 변형의 SR
 * @param trialSRs - 모든 시도의 SR 배열
 * @param n - 관측수 (일별 수익률 수)
 * @param skew - 최고 변형 수익률 왜도
 * @param kurt - 최고 변형 수익률 첨도
 */
export function computeDSR(
  srHat: number,
  trialSRs: number[],
  n: number,
  skew: number,
  kurt: number,
): number {
  const N = trialSRs.length;
  if (N < 2 || n < 3) return 0;

  // V[SR_trials] = 시도들의 SR 분산
  const mean = trialSRs.reduce((s, v) => s + v, 0) / N;
  const variance = trialSRs.reduce((s, v) => s + (v - mean) ** 2, 0) / (N - 1);
  const stdSR = Math.sqrt(variance);

  if (stdSR === 0) return computePSR(srHat, 0, n, skew, kurt);

  // Expected max SR from N random trials
  const gamma = EULER_MASCHERONI;
  const srStar =
    stdSR *
    ((1 - gamma) * normalInvCdf(1 - 1 / N) +
      gamma * normalInvCdf(1 - 1 / (N * Math.E)));

  return computePSR(srHat, srStar, n, skew, kurt);
}
