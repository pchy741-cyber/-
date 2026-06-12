/**
 * 🎯 진입 타이밍 가드 — 매수 시점 정밀화
 *
 * 매매일지 290건 분석 (CEO 2026-06-12):
 *  - 당일 매매: 승률 23%, 평균 -0.76% (가장 나쁨)
 *  - 1-2일 보유: 38%, +0.21%
 *  - 6-10일 보유: 75%, +2.02% (가장 좋음)
 *  - 저녁 매수 (18~24시 KR): 큰 손실 다수 (-6%~-14%)
 *
 * 강화:
 *  1. KR 장외 매수 가드: 18:00~08:30 KST 매수 시 점수 +5 보너스 요구
 *  2. 황금구간 가산: 황금구간 매수는 표준 진입 (이미 AutoPilot에서 -10)
 *  3. 마의시간 절대 차단: 10:20~13:00 KST 신규매수 X
 *  4. 기술지표 다중 확증: RSI 30~65 + 거래량 1.2x+ + MA20 위
 */

import { getKrMarketPhase } from '../scheduler/loop-mode.js';
import { logger } from '../utils/logger.js';

const COMP = 'ENTRY_TIMING';

export interface EntryTimingCheck {
  allowed: boolean;
  scoreBonus: number; // 필요한 추가 점수 (예: +5점)
  reason: string;
  details: {
    phase: string;
    rsi: number | null;
    volumeRatio: number | null;
    aboveMa20: boolean | null;
  };
}

export interface TechSnapshot {
  rsi?: number | null;
  volumeRatio?: number | null;
  aboveMa20?: boolean | null;
  isMomentum?: boolean | null;
}

/**
 * 진입 시점 검증
 *
 * @param tech 기술지표 (없으면 시간만 체크)
 * @param aiScore 현재 AI 점수
 * @param marketCode 'KR' 또는 'US'
 */
export function checkEntryTiming(params: {
  tech?: TechSnapshot;
  aiScore: number;
  marketCode?: 'KR' | 'US';
  isClaudeManual?: boolean; // Claude Code 수동 매수는 일부 가드 완화
}): EntryTimingCheck {
  const market = params.marketCode ?? 'KR';
  const tech = params.tech ?? {};

  // ─ 1. 시간대 검증 (KR만) ─
  let phase = '';
  let scoreBonus = 0;
  if (market === 'KR') {
    phase = getKrMarketPhase();
    if (phase === 'CURSED') {
      return {
        allowed: false,
        scoreBonus: 99,
        reason: `☠️ 마의시간 (10:20~13:00) — 신규 매수 절대 금지`,
        details: { phase, rsi: tech.rsi ?? null, volumeRatio: tech.volumeRatio ?? null, aboveMa20: tech.aboveMa20 ?? null },
      };
    }
    if (phase === 'CLOSED') {
      // 장외: 점수 +5 보너스 요구
      scoreBonus = 5;
      // Claude 수동은 보너스 +3로 완화
      if (params.isClaudeManual) scoreBonus = 3;
      if (params.aiScore < 70 + scoreBonus) {
        return {
          allowed: false,
          scoreBonus,
          reason: `🌙 장외 매수 차단: 점수 ${params.aiScore} < 필요 ${70 + scoreBonus} (저녁 매수 패턴 손실 다수)`,
          details: { phase, rsi: tech.rsi ?? null, volumeRatio: tech.volumeRatio ?? null, aboveMa20: tech.aboveMa20 ?? null },
        };
      }
    }
    // 황금구간/개장벨/마감벨은 그대로 진행
  }

  // ─ 2. 기술지표 다중 확증 (지표가 제공된 경우만) ─
  const reasons: string[] = [];
  const failures: string[] = [];

  if (tech.rsi != null) {
    if (tech.rsi > 70) {
      failures.push(`RSI ${tech.rsi.toFixed(0)} > 70 (과매수)`);
    } else if (tech.rsi < 30) {
      // RSI 30 미만은 과매도 — 눌림 가능성 있지만 추가 확증 필요
      if (tech.isMomentum) {
        reasons.push(`RSI ${tech.rsi.toFixed(0)} 과매도 + 모멘텀`);
      } else {
        failures.push(`RSI ${tech.rsi.toFixed(0)} < 30 + 모멘텀 없음 (낙도 가능)`);
      }
    } else {
      reasons.push(`RSI ${tech.rsi.toFixed(0)} 정상`);
    }
  }

  if (tech.volumeRatio != null) {
    if (tech.volumeRatio < 0.8) {
      failures.push(`거래량 ${tech.volumeRatio.toFixed(1)}x < 0.8 (저유동)`);
    } else if (tech.volumeRatio >= 1.2) {
      reasons.push(`거래량 ${tech.volumeRatio.toFixed(1)}x ✓`);
    }
  }

  if (tech.aboveMa20 === false) {
    failures.push(`MA20 아래 (하락 추세)`);
  } else if (tech.aboveMa20 === true) {
    reasons.push(`MA20 위 ✓`);
  }

  // 기술지표 2개 이상 실패 시 차단
  if (failures.length >= 2) {
    return {
      allowed: false,
      scoreBonus,
      reason: `🚫 기술지표 다중 위험: ${failures.join(', ')}`,
      details: { phase, rsi: tech.rsi ?? null, volumeRatio: tech.volumeRatio ?? null, aboveMa20: tech.aboveMa20 ?? null },
    };
  }

  return {
    allowed: true,
    scoreBonus,
    reason: `진입 OK [${phase || market}] ${reasons.join(', ')}${failures.length === 1 ? ` (경고: ${failures[0]})` : ''}`,
    details: { phase, rsi: tech.rsi ?? null, volumeRatio: tech.volumeRatio ?? null, aboveMa20: tech.aboveMa20 ?? null },
  };
}

/** 조기 매도 차단 — 보유 1일 미만 + PnL > -3% 면 매도 보류 */
export function shouldHoldLonger(params: { holdingDays: number; pnlPct: number }): { hold: boolean; reason: string } {
  const { holdingDays, pnlPct } = params;
  // 손실 -3% 이상은 무조건 손절 허용 (안전)
  if (pnlPct <= -3) {
    return { hold: false, reason: `손절 임계 통과 (PnL ${pnlPct.toFixed(1)}%)` };
  }
  // 보유 0.5일 미만 + 작은 손익은 보유 권장 (당일 매매 패턴 = 승률 23%)
  if (holdingDays < 0.5 && pnlPct > -3) {
    return {
      hold: true,
      reason: `🕐 당일 보유 ${(holdingDays * 24).toFixed(0)}h — 75% 승률 6-10일 보유 패턴 유도 (당일 매매 -0.76%)`,
    };
  }
  return { hold: false, reason: `정상 매도 (${holdingDays.toFixed(1)}일 보유)` };
}
