/**
 * 🔬 진입 조건 핑거프린트 — 어떤 패턴으로 매수했을 때 이기는지 학습
 *
 * 기술지표 조합을 구조화된 핑거프린트로 변환하고,
 * 과거 동일 패턴의 승률을 조회해 진입 품질을 사전 평가한다.
 *
 * Flow:
 *   매수 결정 시 → computeFingerprint() → 핑거프린트 생성
 *   → getPatternFeedback() → 과거 동일 패턴 승률 조회
 *   → score adjustment (+10 ~ -15) 적용
 *   체인 종료 시 → recordScoreAccuracy에 fingerprint 저장
 *   → 다음 진입 시 피드백 루프 완성
 */

import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ── 핑거프린트 구조 ──

export interface EntryFingerprint {
  rsiZone: 'oversold' | 'low' | 'neutral' | 'high' | 'overbought';
  volZone: 'surge' | 'high' | 'normal' | 'low';
  trendState: 'bull' | 'partial_bull' | 'neutral' | 'partial_bear' | 'bear';
  regime: string; // TREND_BULL, RANGE_LOW_VOL, etc.
  adx: 'strong' | 'moderate' | 'weak';
  macd: 'bullish' | 'bearish' | 'neutral';
}

export interface PatternFeedback {
  winRate: number; // 0~1
  sampleCount: number; // 과거 건수
  avgPnlPct: number; // 평균 수익률
  scoreAdj: number; // 점수 보정 (-15 ~ +10)
  reason: string;
}

// ── 핑거프린트 생성 ──

export function computeFingerprint(params: {
  rsi: number;
  volumeRatio: number;
  smaAlignment: string; // 'full_bull' | 'partial_bull' | 'neutral' | etc.
  regime?: string;
  adxStrength?: string; // 'STRONG' | 'MODERATE' | 'WEAK'
  macdState?: string; // 'BULLISH' | 'BEARISH' | etc.
}): EntryFingerprint {
  const { rsi, volumeRatio, smaAlignment, regime, adxStrength, macdState } = params;

  // RSI 구간
  let rsiZone: EntryFingerprint['rsiZone'];
  if (rsi < 30) rsiZone = 'oversold';
  else if (rsi < 45) rsiZone = 'low';
  else if (rsi < 60) rsiZone = 'neutral';
  else if (rsi < 70) rsiZone = 'high';
  else rsiZone = 'overbought';

  // 거래량 구간
  let volZone: EntryFingerprint['volZone'];
  if (volumeRatio >= 2.0) volZone = 'surge';
  else if (volumeRatio >= 1.3) volZone = 'high';
  else if (volumeRatio >= 0.7) volZone = 'normal';
  else volZone = 'low';

  // 추세 상태 (SMA alignment을 단순화)
  let trendState: EntryFingerprint['trendState'];
  const sma = (smaAlignment ?? '').toLowerCase();
  if (sma.includes('full_bull') || sma.includes('full bull')) trendState = 'bull';
  else if (sma.includes('partial_bull') || sma.includes('bull')) trendState = 'partial_bull';
  else if (sma.includes('full_bear') || sma.includes('full bear')) trendState = 'bear';
  else if (sma.includes('partial_bear') || sma.includes('bear')) trendState = 'partial_bear';
  else trendState = 'neutral';

  // ADX
  let adx: EntryFingerprint['adx'];
  const adxStr = (adxStrength ?? '').toUpperCase();
  if (adxStr === 'STRONG') adx = 'strong';
  else if (adxStr === 'WEAK') adx = 'weak';
  else adx = 'moderate';

  // MACD
  let macd: EntryFingerprint['macd'];
  const macdStr = (macdState ?? '').toUpperCase();
  if (macdStr.includes('BULLISH')) macd = 'bullish';
  else if (macdStr.includes('BEARISH')) macd = 'bearish';
  else macd = 'neutral';

  return {
    rsiZone,
    volZone,
    trendState,
    regime: regime ?? 'UNKNOWN',
    adx,
    macd,
  };
}

/** 핑거프린트 → DB 저장/조회용 문자열 키 */
export function fingerprintKey(fp: EntryFingerprint): string {
  return `${fp.rsiZone}|${fp.volZone}|${fp.trendState}|${fp.regime}|${fp.adx}|${fp.macd}`;
}

// ── 패턴 피드백 조회 ──

/**
 * 과거 동일/유사 패턴의 승률을 조회하여 점수 보정값 반환
 *
 * 단순 "완전 일치" 대신 **유사도 기반 매칭**:
 *  1차: rsiZone + trendState 일치 (가장 중요한 2축)
 *  2차: volZone + macd 추가 매칭 시 신뢰도 상승
 */
export async function getPatternFeedback(fp: EntryFingerprint): Promise<PatternFeedback> {
  const defaultResult: PatternFeedback = {
    winRate: 0.5,
    sampleCount: 0,
    avgPnlPct: 0,
    scoreAdj: 0,
    reason: '패턴 데이터 부족',
  };

  try {
    const isPaper = getCtxIsPaper();
    const fpKey = fingerprintKey(fp);

    // v9-fix: 데이터 스누핑 방지 — 최근 7일 제외 (holdout gap)
    // 학습 데이터와 적용 기간 분리하여 오버피팅 방지
    // 1차: 정확히 일치하는 핑거프린트 조회
    const { rows: exact } = await getPool().query(
      `
      SELECT outcome, realized_pnl_pct
      FROM score_accuracy
      WHERE entry_fingerprint = $1
        AND is_paper = $2
        AND recorded_at BETWEEN NOW() - INTERVAL '120 days' AND NOW() - INTERVAL '7 days'
    `,
      [fpKey, isPaper],
    );

    // 2차: RSI구간 + 추세 일치 (더 넓은 매칭)
    const { rows: similar } = await getPool().query(
      `
      SELECT outcome, realized_pnl_pct
      FROM score_accuracy
      WHERE entry_fingerprint LIKE $1
        AND is_paper = $2
        AND recorded_at BETWEEN NOW() - INTERVAL '120 days' AND NOW() - INTERVAL '7 days'
    `,
      [`${fp.rsiZone}|%|${fp.trendState}|%`, isPaper],
    );

    // 정확 일치 5건 이상 → 정확 일치 사용, 아니면 유사 매칭
    const data = exact.length >= 5 ? exact : similar;
    if (data.length < 3) return defaultResult;

    const wins = data.filter((r: any) => r.outcome === 'WIN').length;
    const winRate = wins / data.length;
    const avgPnlPct = data.reduce((s: number, r: any) => s + (Number(r.realized_pnl_pct) || 0), 0) / data.length;

    // 데이터 많을수록 보정 강도 증가
    const dataBias = data.length >= 15 ? 1.3 : data.length >= 8 ? 1.1 : 1.0;

    let scoreAdj = 0;
    let reason = '';

    if (winRate >= 0.65 && avgPnlPct > 0) {
      scoreAdj = Math.round(10 * dataBias);
      reason = `고승률 패턴(${(winRate * 100).toFixed(0)}%, ${data.length}건) → +${scoreAdj}`;
    } else if (winRate >= 0.55) {
      scoreAdj = Math.round(5 * dataBias);
      reason = `양호 패턴(${(winRate * 100).toFixed(0)}%, ${data.length}건) → +${scoreAdj}`;
    } else if (winRate <= 0.25 && data.length >= 8) {
      // 8건 이상에서만 강한 페널티 (5건은 샘플 부족), 캡 -10 (기존 -15 → 스파이럴 방지)
      scoreAdj = Math.round(Math.max(-10, -10 * dataBias));
      reason = `위험 패턴(${(winRate * 100).toFixed(0)}%, ${data.length}건) → ${scoreAdj}`;
    } else if (winRate <= 0.35) {
      scoreAdj = Math.round(Math.max(-6, -6 * dataBias));
      reason = `저승률 패턴(${(winRate * 100).toFixed(0)}%, ${data.length}건) → ${scoreAdj}`;
    } else {
      reason = `보통 패턴(${(winRate * 100).toFixed(0)}%, ${data.length}건)`;
    }

    if (scoreAdj !== 0) {
      logger.info(`🔬 패턴 피드백 [${fpKey}]: ${reason}`, { component: 'PATTERN' });
    }

    return { winRate, sampleCount: data.length, avgPnlPct, scoreAdj, reason };
  } catch {
    return defaultResult;
  }
}
