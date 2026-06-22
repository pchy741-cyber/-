/**
 * 하드 게이트: 절대 차단 조건
 *
 * 매수 차단 목록, 손절 쿨다운, 수동 매도, 잡주 필터 등
 * 이 게이트를 통과하지 못하면 이후 분석 일체 생략.
 */

import { isCommunityPumpBlocked } from '../../../automation/community-sentinel.js';
import { logger } from '../../../utils/logger.js';
import { getOverride } from '../../ai-overrides.js';
import { BUY_BLOCKED_CODES } from '../trading-rules.js';
import { checkSmartReentry } from './smart-reentry.js';
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
    isPaper,
    lossHistory,
    chartData,
    tradingValues,
  } = input;
  const code = stock.stock_code;
  const name = stock.stock_name;

  // 이미 포지션 있으면 스킵
  if (openStockCodes.has(code)) return true;

  // CEO 지시: 바이오/손실 종목 매수 차단 (Paper: CEO 블랙리스트만 유지)
  if (BUY_BLOCKED_CODES.has(code)) {
    logger.info(`  🚫 ${code}(${name}): 매수 차단 목록 — 스킵`, { component: 'TRACK_B' });
    return true;
  }

  // Community Sentinel: 펌프/작전주 리스크 감지 → 매수 차단
  if (isCommunityPumpBlocked(code)) {
    logger.info(`  🚫 ${code}(${name}): 커뮤니티 펌프 리스크 — 매수 차단`, { component: 'TRACK_B' });
    return true;
  }

  // ── 스마트 재진입: 손실 이력이 있는 종목에 대해 조건 기반 재진입 판단 ──
  // Paper 모드: 손실 블로킹 완전 bypass (적극적 데이터 수집)
  const lossRecord = lossHistory?.get(code);
  if (lossRecord && !isPaper) {
    const allowRebuy = getOverride<boolean>(`${code}_allowRebuy`);
    if (allowRebuy) {
      logger.info(`  🔓 ${code}(${name}): allowRebuy override로 손실 차단 해제`, { component: 'TRACK_B' });
    } else {
      const candles = chartData?.get(code);
      const tv = tradingValues?.get(code) ?? 0;
      const reentry = checkSmartReentry(lossRecord, candles, tv);
      if (!reentry.allowed) {
        logger.info(
          `  🚫 ${code}(${name}): 손실${lossRecord.lossPct.toFixed(1)}% 재진입 차단 — ${reentry.reason}`,
          { component: 'TRACK_B' },
        );
        return true;
      }
      // 스마트 재진입 허용 — suggestedSl은 input에 기록 (buy-execution에서 참조)
      logger.info(`  🔓 ${code}(${name}): ${reentry.reason}`, { component: 'TRACK_B' });
      if (reentry.suggestedSl) {
        input._smartReentrySl = reentry.suggestedSl;
      }
    }
  }

  // 레거시 lossBlockedCodes/bigLossBlockedCodes 체크 (lossHistory 미전달 시 폴백)
  if (!lossHistory) {
    if (bigLossBlockedCodes?.has(code) && !isPaper) {
      const aiForBigLoss = aiScoreMap.get(code) ?? 0;
      const highConviction = Number.isFinite(aiForBigLoss) && aiForBigLoss >= 90;
      if (!highConviction) {
        logger.info(`  🚫 ${code}(${name}): -5%초과 손실 차단 (폴백)`, { component: 'TRACK_B' });
        return true;
      }
    }
    if (lossBlockedCodes?.has(code)) {
      const aiForCooldown = aiScoreMap.get(code) ?? 0;
      const threshold = isPaper ? 60 : 80;
      if (!Number.isFinite(aiForCooldown) || aiForCooldown < threshold) {
        logger.info(`  🚫 ${code}(${name}): 손절 쿨다운 (폴백)`, { component: 'TRACK_B' });
        return true;
      }
    }
  }

  // 24시간 이내 CEO 수동 매도 재진입 금지 (Paper: 면제)
  if (manuallySoldCodes?.has(code) && !isPaper) {
    logger.info(`  🚫 ${code}(${name}): CEO 수동 매도 쿨다운 (24h) — 재진입 금지`, { component: 'TRACK_B' });
    return true;
  }

  // v10.3: 4시간 이내 매도 재진입 쿨다운 (반복매매=적자 주범)
  if (recentlySoldCodes?.has(code) && !isPaper) {
    logger.info(`  🕐 ${code}(${name}): 매도 후 4h 쿨다운 — 재진입 대기`, { component: 'TRACK_B' });
    return true;
  }

  // ── 잡주/저품질 종목 필터 (3중 게이트) ──

  // 1) 저가주: Live 5,000원 미만, Paper 1,000원 미만 (ETF 제외)
  // v10.4: Live 2000→5000, Paper 500→1000 (저가 잡주 거래 방지)
  const ETF_BRANDS: readonly string[] = ['KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'ACE', 'KOSEF'];
  const isETF = ETF_BRANDS.some((b) => name.toUpperCase().includes(b));
  const earlyPrice = livePrices.get(code);
  const junkPriceThreshold = isPaper ? 1000 : 5000;
  if (earlyPrice && earlyPrice.currentPrice > 0 && earlyPrice.currentPrice < junkPriceThreshold && !isETF) {
    logger.info(`  🗑️ ${code}(${name}): 저가주(${earlyPrice.currentPrice}원 < ${junkPriceThreshold}) — 잡주 필터`, {
      component: 'TRACK_B',
    });
    return true;
  }

  // 2) 외국인/기관 동반 이탈(STRONG_SELL) — Paper도 적용 (구조적 위험)
  if (junkStockCodes?.has(code)) {
    logger.info(`  🗑️ ${code}(${name}): 외국인+기관 동반 이탈(STRONG_SELL) — 잡주 필터`, { component: 'TRACK_B' });
    return true;
  }

  // 3) 구조적 패배 종목: 90일 내 승률 < 25%, 5건 이상 (Paper: 15%로 완화)
  const stockWr = winRates?.get(code);
  const minWinRate = isPaper ? 0.15 : 0.25;
  if (stockWr && stockWr.sampleCount >= 5 && stockWr.winRate < minWinRate) {
    logger.info(
      `  🗑️ ${code}(${name}): 패배 이력 승률=${(stockWr.winRate * 100).toFixed(0)}%(${stockWr.sampleCount}건) — 잡주 필터`,
      { component: 'TRACK_B' },
    );
    return true;
  }

  return false; // 통과
}
