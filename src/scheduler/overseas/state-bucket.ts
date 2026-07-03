/**
 * 해외 버킷 분류 — state.ts에서 분리
 */

/**
 * 황금비율 버킷별 투자 비중 계산
 * v10.8: 시장가 기준 (원가 기준 → 포트폴리오 비중 왜곡 방지)
 * currentPrices 맵이 있으면 시장가 사용, 없으면 avgPrice 폴백
 */
export function getBucketWeight(
  holdings: Map<string, { qty: number; avgPrice: number; bucket: string }>,
  portfolioValue: number,
  bucket: string,
  currentPrices?: Map<string, number>,
): number {
  if (portfolioValue <= 0) return 0;
  let bucketValue = 0;
  for (const [code, h] of holdings) {
    if (h.bucket === bucket) {
      const price = currentPrices?.get(code) ?? h.avgPrice;
      bucketValue += h.qty * price;
    }
  }
  return bucketValue / portfolioValue;
}

/**
 * 진입 전략 기반 버킷 자동 분류
 * - Premarket Dip / Vision Scalp 진입 → TACTICAL
 * - Momentum / BigMover / 추세확인 → SWING
 * - 우량주(BLUE_CHIP) + 장기시그널 → CORE
 */
export function classifyBucket(entrySource: string, isBlueChip = false): string {
  if (entrySource === 'DIP_BUY' || entrySource === 'SCALP') return 'TACTICAL';
  if (isBlueChip && (entrySource === 'TECHNICAL' || entrySource === 'OVERSOLD')) return 'CORE';
  return 'SWING';
}
