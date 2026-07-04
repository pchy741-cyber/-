/**
 * 하드 게이트: 절대 차단 조건
 *
 * 매수 차단 목록, 손절 쿨다운, 수동 매도, 잡주 필터 등
 * 이 게이트를 통과하지 못하면 이후 분석 일체 생략.
 */

import { isCommunityPumpBlocked } from '../../../automation/community-sentinel.js';
import { logger } from '../../../utils/logger.js';
import { getOverride } from '../../ai-overrides.js';
import { isDailyStopLossBlocked } from '../sell-cooldown.js';
import { BUY_BLOCKED_CODES, MEGA_CAP_PRIORITY_CODES } from '../trading-rules.js';
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
  // v22.3: 대형주는 차트 데이터 부족 시에도 재진입 허용 (봇 성능 문제지 종목 문제 아님)
  const lossRecord = lossHistory?.get(code);
  const isMegaCap = MEGA_CAP_PRIORITY_CODES.has(code);
  if (lossRecord) {
    const allowRebuy = getOverride<boolean>(`${code}_allowRebuy`);
    if (allowRebuy) {
      logger.info(`  🔓 ${code}(${name}): allowRebuy override로 손실 차단 해제`, { component: 'TRACK_B' });
    } else {
      const candles = chartData?.get(code);
      const tv = tradingValues?.get(code) ?? 0;
      const reentry = checkSmartReentry(lossRecord, candles, tv);
      if (!reentry.allowed) {
        // v22.3: 대형주는 "차트 데이터 부족" 시 재진입 허용 (스마트재진입 면제)
        if (isMegaCap && reentry.reason.includes('차트 데이터 부족')) {
          logger.info(`  ⚠️ ${code}(${name}): 대형주 차트 미로딩 → 재진입 허용 (손실${lossRecord.lossPct.toFixed(1)}%)`, { component: 'TRACK_B' });
        } else if (isMegaCap && lossRecord.lossPct > -5) {
          // 대형주 손실 -5% 미만이면 기술적 조건 미충족이어도 재진입 허용 (타이밍 문제)
          logger.info(`  ⚠️ ${code}(${name}): 대형주 소폭손실(${lossRecord.lossPct.toFixed(1)}%) → 재진입 허용`, { component: 'TRACK_B' });
        } else {
          logger.info(
            `  🚫 ${code}(${name}): 손실${lossRecord.lossPct.toFixed(1)}% 재진입 차단 — ${reentry.reason}`,
            { component: 'TRACK_B' },
          );
          return true;
        }
      } else {
        // 스마트 재진입 허용 — suggestedSl은 input에 기록 (buy-execution에서 참조)
        logger.info(`  🔓 ${code}(${name}): ${reentry.reason}`, { component: 'TRACK_B' });
        if (reentry.suggestedSl) {
          input._smartReentrySl = reentry.suggestedSl;
        }
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
      const threshold = isPaper ? 45 : 80; // Paper: 45점 이상이면 쿨다운 해제 (전수조사 극대화)
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

  // v21: 당일 동일 종목 2회 손절 → 재진입 완전 차단 (금호타이어/한솔테크닉스 같은 반복 손절 패턴 원천 차단)
  if (isDailyStopLossBlocked(code, isPaper ?? false)) {
    logger.info(`  🚫 ${code}(${name}): 당일 2회 손절 — 재진입 완전 차단`, { component: 'TRACK_B' });
    return true;
  }

  // v22: 매도 후 쿨다운 — Paper 모드에도 적용 (반복매매=적자 주범)
  if (recentlySoldCodes?.has(code)) {
    logger.info(`  🕐 ${code}(${name}): 매도 후 쿨다운 — 재진입 대기`, { component: 'TRACK_B' });
    return true;
  }

  // ── 잡주/저품질 종목 필터 ──

  // v22.3: 거래대금 필터 — 극저유동성만 차단 (ETF 제외)
  // 15억→ 한국 중소형 우량주도 거래대금 15-30억 구간 많음, 너무 높으면 좋은 종목 차단
  const ETF_BRANDS: readonly string[] = ['KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'ACE', 'KOSEF'];
  const isETF = ETF_BRANDS.some((b) => name.toUpperCase().includes(b));
  const tv = tradingValues?.get(code) ?? 0;
  const minTradingValue = isPaper ? 3_0000_0000 : 15_0000_0000; // Paper: 3억, Live: 15억
  if (tv > 0 && tv < minTradingValue && !isETF) {
    logger.info(
      `  🗑️ ${code}(${name}): 거래대금 부족(${(tv / 1_0000_0000).toFixed(0)}억 < ${minTradingValue / 1_0000_0000}억) — 유동성 필터`,
      { component: 'TRACK_B' },
    );
    return true;
  }

  // 1) 저가주: Live 5,000원 미만, Paper 1,000원 미만 (ETF 제외)
  // v10.4: Live 2000→5000, Paper 500→1000 (저가 잡주 거래 방지)
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

  // 3) 구조적 패배 종목: 90일 내 승률 < 25%, 5건 이상 — 대형주 면제
  const stockWr = winRates?.get(code);
  const minWinRate = isPaper ? 0.10 : 0.25; // Paper: 10%까지 허용 (극단 케이스 학습)
  if (stockWr && stockWr.sampleCount >= 5 && stockWr.winRate < minWinRate) {
    // v22.3: 대형주는 봇 성능 문제이지 종목 문제 아님 → 면제
    if (!MEGA_CAP_PRIORITY_CODES.has(code)) {
      logger.info(
        `  🗑️ ${code}(${name}): 패배 이력 승률=${(stockWr.winRate * 100).toFixed(0)}%(${stockWr.sampleCount}건) — 잡주 필터`,
        { component: 'TRACK_B' },
      );
      return true;
    }
  }

  // v22.3: 14일 내 2회+ 손절 블랙리스트 — 대형주/우량주는 면제 (스마트 재진입으로 대체)
  // 잡주 = 상폐위험/작전주/개미피해 종목. 삼성전자/현대로템 등은 진입타이밍 문제이지 종목 문제 아님
  if (input.repeatLoserCodes?.has(code)) {
    const isBluechip = MEGA_CAP_PRIORITY_CODES.has(code);
    const highTv = (tradingValues?.get(code) ?? 0) >= 100_0000_0000; // 거래대금 100억+ = 주도주
    if (isBluechip || highTv) {
      // 우량주는 블랙리스트 대신 스마트 재진입 체크에 맡김 (위에서 이미 처리됨)
      logger.info(`  ⚠️ ${code}(${name}): 반복손절이지만 우량주 → 블랙리스트 면제 (스마트재진입 의존)`, { component: 'TRACK_B' });
    } else {
      logger.info(`  🚫 ${code}(${name}): 14일 내 2회+ 손절 — 7일 자동 블랙리스트`, { component: 'TRACK_B' });
      return true;
    }
  }

  return false; // 통과
}
