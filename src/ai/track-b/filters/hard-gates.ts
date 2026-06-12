/**
 * 하드 게이트: 절대 차단 조건
 *
 * 매수 차단 목록, 손절 쿨다운, 수동 매도, 잡주 필터 등
 * 이 게이트를 통과하지 못하면 이후 분석 일체 생략.
 */

import { logger } from '../../../utils/logger.js';
import { getOverride } from '../../ai-overrides.js';
import { BUY_BLOCKED_CODES } from '../trading-rules.js';
import type { HardGateInput } from './types.js';

/**
 * 하드 게이트 검사 — 통과하지 못하면 즉시 스킵
 * @returns true = 차단(skip), false = 통과(pass)
 */
export function isHardBlocked(input: HardGateInput): boolean {
  const {
    stock,
    openStockCodes,
    lossBlockedCodes,
    bigLossBlockedCodes,
    manuallySoldCodes,
    recentlySoldCodes,
    junkStockCodes,
    winRates,
    livePrices,
    aiScoreMap,
  } = input;
  const code = stock.stock_code;
  const name = stock.stock_name;

  // 이미 포지션 있으면 스킵
  if (openStockCodes.has(code)) return true;

  // CEO 지시: 바이오/손실 종목 매수 차단
  if (BUY_BLOCKED_CODES.has(code)) {
    logger.info(`  🚫 ${code}(${name}): 매수 차단 목록 — 스킵`, { component: 'TRACK_B' });
    return true;
  }

  // -5% 초과 손실 종목 → 30일 절대 차단
  if (bigLossBlockedCodes?.has(code)) {
    const allowRebuy = getOverride<boolean>(`${code}_allowRebuy`);
    if (!allowRebuy) {
      logger.info(`  🚫 ${code}(${name}): -5%초과 손실 30일 차단 (allowRebuy 필요)`, { component: 'TRACK_B' });
      return true;
    }
    logger.info(`  🔓 ${code}: allowRebuy override로 -5% 차단 해제`, { component: 'TRACK_B' });
  }

  // 14일 이내 손절 쿨다운 (AI 85+ 시 쿨다운 무시)
  if (lossBlockedCodes?.has(code)) {
    const aiForCooldown = aiScoreMap.get(code) ?? 0;
    // NaN 방어: Number.isFinite 체크 (NaN < 85 = false → 쿨다운 우회 버그 방지)
    if (!Number.isFinite(aiForCooldown) || aiForCooldown < 85) {
      logger.info(`  🚫 ${code}(${name}): 손절 쿨다운 (14일) — 재진입 금지`, { component: 'TRACK_B' });
      return true;
    }
    logger.info(`  🔓 ${code}(${name}): 손절 쿨다운 무시 (AI ${aiForCooldown}점 ≥ 85)`, { component: 'TRACK_B' });
  }

  // 24시간 이내 CEO 수동 매도 재진입 금지
  if (manuallySoldCodes?.has(code)) {
    logger.info(`  🚫 ${code}(${name}): CEO 수동 매도 쿨다운 (24h) — 재진입 금지`, { component: 'TRACK_B' });
    return true;
  }

  // 2시간 이내 매도 재진입 쿨다운
  if (recentlySoldCodes?.has(code)) {
    logger.info(`  🕐 ${code}(${name}): 매도 후 2h 쿨다운 — 재진입 대기`, { component: 'TRACK_B' });
    return true;
  }

  // ── 잡주/저품질 종목 필터 (3중 게이트) ──

  // 1) 저가주: 2,000원 미만 (ETF 제외 — KODEX 인버스 등 저가 ETF는 정상 종목)
  const ETF_BRANDS = ['KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'ACE', 'KOSEF'];
  const isETF = ETF_BRANDS.some((b) => name.toUpperCase().includes(b));
  const earlyPrice = livePrices.get(code);
  if (earlyPrice && earlyPrice.currentPrice > 0 && earlyPrice.currentPrice < 2000 && !isETF) {
    logger.info(`  🗑️ ${code}(${name}): 저가주(${earlyPrice.currentPrice}원 < 2000) — 잡주 필터`, {
      component: 'TRACK_B',
    });
    return true;
  }

  // 2) 외국인/기관 동반 이탈(STRONG_SELL)
  if (junkStockCodes?.has(code)) {
    logger.info(`  🗑️ ${code}(${name}): 외국인+기관 동반 이탈(STRONG_SELL) — 잡주 필터`, { component: 'TRACK_B' });
    return true;
  }

  // 3) 구조적 패배 종목: 90일 내 승률 < 25%, 5건 이상
  const stockWr = winRates?.get(code);
  if (stockWr && stockWr.sampleCount >= 5 && stockWr.winRate < 0.25) {
    logger.info(
      `  🗑️ ${code}(${name}): 패배 이력 승률=${(stockWr.winRate * 100).toFixed(0)}%(${stockWr.sampleCount}건) — 잡주 필터`,
      { component: 'TRACK_B' },
    );
    return true;
  }

  return false; // 통과
}
