/**
 * 모멘텀 반전 전까지 홀딩 로직
 *
 * 트레일링 스탑이 고점 대비 기계적 하락폭으로만 판단하여
 * 상승 추세 내 정상 눌림(pullback)에서도 조기 매도하는 문제 해결.
 *
 * 모멘텀(추세)이 여전히 살아있으면 매도를 유보하여
 * 승리 거래의 평균 수익을 높인다.
 */

import type { TechnicalSummary } from '../../analysis/indicators.js';
import { safeQuery } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

export interface MomentumHoldInput {
  tech: TechnicalSummary | null;
  pnlPct: number;          // 현재 수익률
  curPeak: number;          // 고점 수익률
  dropFromPeakAbs: number;  // |고점 대비 하락폭| (양수)
  chainId: string;
  stockCode: string;
  isPaper: boolean;
  isRunner: boolean;
  currentPrice: number;
}

export interface MomentumHoldResult {
  shouldHold: boolean;
  reason: string;
  holdCount: number;
}

/**
 * 모멘텀이 유지되는지 판단하여 트레일링 스탑 매도를 유보할지 결정
 *
 * 안전 한도 (force sell — 모멘텀 무시):
 * 1. holdCount >= maxHold → 동적 한도 초과 시 반드시 매도
 *    curPeak >= 10%: 9회(18분), >= 5%: 7회(14분), 기본: 4회(8분)
 * 2. pnlPct < 0.5% → 수익 거의 소진 → 본절 방어 우선
 * 3. curPeak >= 15% && dropFromPeakAbs >= 5% → 대형 고점 이탈 = 진짜 반전
 *
 * 모멘텀 지속 조건 (전부 충족해야 홀드):
 * 1. ADX >= 22 (추세 존재)
 * 2. MACD !== 'BEARISH' (약세 전환 없음)
 * 3. RSI 40~72 (과매수/과매도 아님)
 * 4. 현재가 > SMA20 (중기 추세 위)
 * 5. 거래량비율 >= 0.6 (볼륨 사망 아님)
 *
 * 러너: 3/5 충족 (2개 실패 허용 — 폭발 모멘텀 보호)
 * 고점 8%+ 비러너: 4/5 충족 (1개 실패 허용 — 이미 검증된 추세)
 * 기본 비러너: 4/5 충족 (1개 실패 허용 — 조기 매도 방지)
 */
export async function shouldMomentumHold(input: MomentumHoldInput): Promise<MomentumHoldResult> {
  const { tech, pnlPct, curPeak, dropFromPeakAbs, chainId, stockCode, isRunner } = input;

  const noHold: MomentumHoldResult = { shouldHold: false, reason: '', holdCount: 0 };

  // ── 기술지표 없음 → 판단 불가 → 보수적(매도) ──
  if (!tech) return { ...noHold, reason: 'tech=null' };

  // ── 메타데이터 읽기 ──
  let meta: { holdCount: number; lastPeakPnl: number };
  try {
    meta = await getMomentumHoldMeta(chainId);
  } catch {
    return { ...noHold, reason: 'meta read failed' };
  }

  // ── 안전 한도 체크 (force sell) ──

  // 1. 최대 홀드 횟수 초과 (고점이 높을수록 pullback 구간 길어짐 → 추가 관찰)
  // v20: 한도 확대 — 이전 6/5/3 → 9/7/4 (정상 눌림에서 조기 매도 방지 → 평균 수익 확대)
  const maxHold = curPeak >= 10 ? 9 : curPeak >= 5 ? 7 : 4;
  if (meta.holdCount >= maxHold) {
    logger.info(
      `🔋→📉 모멘텀홀드 해제: ${stockCode} 최대 횟수(${meta.holdCount}/${maxHold}) 도달 → 매도 진행`,
      { component: 'MOMENTUM_HOLD' },
    );
    return { ...noHold, reason: `max hold count ${meta.holdCount}/${maxHold}`, holdCount: meta.holdCount };
  }

  // 2. 수익 거의 소진 → 본절 방어 우선
  if (pnlPct < 0.5) {
    logger.info(
      `🔋→📉 모멘텀홀드 해제: ${stockCode} 수익 소진(+${pnlPct.toFixed(1)}% < 0.5%) → 본절 방어`,
      { component: 'MOMENTUM_HOLD' },
    );
    return { ...noHold, reason: `pnl too low ${pnlPct.toFixed(1)}%`, holdCount: meta.holdCount };
  }

  // 3. 대형 고점 이탈 = 진짜 반전
  if (curPeak >= 15 && dropFromPeakAbs >= 5) {
    logger.info(
      `🔋→📉 모멘텀홀드 해제: ${stockCode} 대형 이탈 (고점+${curPeak.toFixed(1)}% 낙폭${dropFromPeakAbs.toFixed(1)}%) → 반전`,
      { component: 'MOMENTUM_HOLD' },
    );
    return { ...noHold, reason: `large peak drop ${curPeak.toFixed(1)}%→-${dropFromPeakAbs.toFixed(1)}%`, holdCount: meta.holdCount };
  }

  // ── 모멘텀 지속 조건 체크 ──
  let passCount = 0;
  const failReasons: string[] = [];

  // 1. ADX >= 22 (추세 존재)
  if (tech.adx14 >= 22) {
    passCount++;
  } else {
    failReasons.push(`ADX=${tech.adx14.toFixed(0)}<22`);
  }

  // 2. MACD !== 'BEARISH' (약세 전환 없음)
  if (tech.macdCrossover !== 'BEARISH') {
    passCount++;
  } else {
    failReasons.push(`MACD=BEARISH`);
  }

  // 3. RSI 40~72 (과매수/과매도 아님)
  if (tech.rsi14 >= 40 && tech.rsi14 <= 72) {
    passCount++;
  } else {
    failReasons.push(`RSI=${tech.rsi14.toFixed(0)}∉[40,72]`);
  }

  // 4. 현재가 > SMA20 (중기 추세 위)
  if (input.currentPrice > tech.sma20 && tech.sma20 > 0) {
    passCount++;
  } else {
    failReasons.push(`price≤SMA20`);
  }

  // 5. 거래량비율 >= 0.6 (볼륨 사망 아님)
  if (tech.volumeRatio >= 0.6) {
    passCount++;
  } else {
    failReasons.push(`vol=${tech.volumeRatio.toFixed(1)}<0.6`);
  }

  // 러너: 3/5 (폭발 모멘텀 보호), 고점8%+ 비러너: 4/5 (검증된 추세), 기본: 4/5
  // v20: 비러너 기본 5→4 (5/5 = 사실상 홀드 불가 → 조기 매도 과다)
  const requiredPass = isRunner ? 3 : curPeak >= 8 ? 4 : 4;
  if (passCount < requiredPass) {
    logger.info(
      `🔋→📉 모멘텀홀드 해제: ${stockCode} 조건 미충족 ${passCount}/${requiredPass} [${failReasons.join(', ')}] → 매도 진행`,
      { component: 'MOMENTUM_HOLD' },
    );
    return { ...noHold, reason: `conditions ${passCount}/${requiredPass}: ${failReasons.join(',')}`, holdCount: meta.holdCount };
  }

  // ── 모멘텀 유지 → 홀드 ──
  const newCount = meta.holdCount + 1;
  try {
    await setMomentumHoldMeta(chainId, newCount, curPeak);
  } catch {
    // DB 쓰기 실패해도 이번 사이클은 홀드 허용 (카운트만 미증가 → 다음에 재시도)
  }

  const passInfo = `${passCount}/5 ADX=${tech.adx14.toFixed(0)} MACD=${tech.macdCrossover} RSI=${tech.rsi14.toFixed(0)} vol=${tech.volumeRatio.toFixed(1)}x`;
  return {
    shouldHold: true,
    reason: passInfo,
    holdCount: newCount,
  };
}

// ── 메타데이터 헬퍼 ──

interface MomentumHoldMeta {
  holdCount: number;
  lastPeakPnl: number;
}

export async function getMomentumHoldMeta(chainId: string): Promise<MomentumHoldMeta> {
  try {
    const { rows } = await safeQuery<{ hold_count: number | null; last_peak: number | null }>(
      `SELECT
        (metadata->>'momentum_hold_count')::int AS hold_count,
        (metadata->>'momentum_hold_last_peak')::float AS last_peak
      FROM transaction_chains WHERE id = $1`,
      [chainId],
    );
    return {
      holdCount: rows[0]?.hold_count ?? 0,
      lastPeakPnl: rows[0]?.last_peak ?? 0,
    };
  } catch {
    return { holdCount: 0, lastPeakPnl: 0 };
  }
}

export async function setMomentumHoldMeta(chainId: string, count: number, peak: number): Promise<void> {
  try {
    await safeQuery(
      `UPDATE transaction_chains
       SET metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object('momentum_hold_count', $2::int, 'momentum_hold_last_peak', $3::float)
       WHERE id = $1`,
      [chainId, count, peak],
    );
  } catch (e) {
    logger.warn(`모멘텀홀드 메타 저장 실패: ${e}`, { component: 'MOMENTUM_HOLD' });
  }
}

/**
 * 신고점 갱신 시 홀드 카운트 리셋
 * 새로운 고점 = 추세 재확인 → 카운트 0으로 초기화
 */
export async function resetMomentumHoldIfNewHigh(chainId: string, newPeakPnl: number): Promise<void> {
  try {
    const meta = await getMomentumHoldMeta(chainId);
    if (meta.holdCount > 0) {
      await setMomentumHoldMeta(chainId, 0, newPeakPnl);
      logger.info(`🔄 모멘텀홀드 카운트 리셋: 신고점 +${newPeakPnl.toFixed(1)}% → 카운트 0`, {
        component: 'MOMENTUM_HOLD',
      });
    }
  } catch (e) {
    logger.warn(`모멘텀홀드 리셋 실패: ${e}`, { component: 'MOMENTUM_HOLD' });
  }
}
