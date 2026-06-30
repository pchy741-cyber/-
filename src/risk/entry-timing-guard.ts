/**
 * 🎯 진입 타이밍 가드 — 매수 시점 정밀화 + 매도 보호
 *
 * CEO 강화 지시 (2026-06-12): 290건 매매일지 통계 분석 기반
 *   - 당일 매매: 23% 승률, -0.76% (마찰비용 +수수료에 잠식)
 *   - 1-2일: 38% 승률, +0.21% (초기 휩소에 SL 털림)
 *   - 6-10일: 75% 승률, +2.02% ⭐ (스윙 = 진짜 알파)
 *   - 저녁 18-24 KST: -6%~-14% 손실 다수 (미국 개장 휩소·갭하락)
 *
 * 3대 규칙:
 *   A. 저녁 18-24 KST 하드 블락 (모든 전략, 점수 무관)
 *   B. SWING/SNIPER만 허용 (SCALPING/EOD_BETTING 거절)
 *   C. 시간 가중치 트레일링 스탑 (48h 버퍼 + 3일+ 본절)
 */

import { getKrMarketPhase } from '../scheduler/loop-mode.js';

const COMP = 'ENTRY_TIMING';

/** 기본 매수 최소 점수 */
const BASE_MIN_SCORE = 70;
/** 마의시간 점수 보너스 요구 */
const CURSED_SCORE_BONUS = 5;
/** 장외(CLOSED) 점수 보너스 — Claude 수동매수 시 */
const CLOSED_MANUAL_SCORE_BONUS = 3;
/** 장외(CLOSED) 점수 보너스 — 자동매수 시 */
const CLOSED_AUTO_SCORE_BONUS = 5;

/** RSI 과매수 임계값 */
const RSI_OVERBOUGHT_THRESHOLD = 70;
/** RSI 역추세 (모멘텀 없는 과매도) 임계값 */
const RSI_OVERSOLD_THRESHOLD = 30;
/** 거래량 비율 최소 요구 */
const VOLUME_MIN_RATIO = 0.8;
/** 거래량 비율 강세 기준 */
const VOLUME_BULL_RATIO = 1.2;

/** 기술지표 다중 위험 차단 기준 (2개 이상 위험 시 차단) */
const MAX_TECH_FAILURES = 2;

// ── 허용 전략 (CEO 지시 #B) ─
// SWING = 6~10일 보유, 75% 승률 실증
// SNIPER = 고확신 집중 매수 (SWING과 비슷)
// BREAKOUT = 10일 보유 전략 (돌파 후 보유, 단타 아님)
// 나머지 (SCALPING/EOD_BETTING) = 단기 = 23% 승률 = 차단
const ALLOWED_STRATEGIES = new Set(['SWING', 'SNIPER', 'BOTTOM_FISHING', 'DEFENSE', 'BREAKOUT']);

export interface EntryTimingCheck {
  allowed: boolean;
  scoreBonus: number;
  reason: string;
  /** v16: 소프트 사이즈 조절 (1.0=정상, 0.3=30% 축소 등) */
  sizeMultiplier?: number;
  details: {
    phase: string;
    rsi: number | null;
    volumeRatio: number | null;
    aboveMa20: boolean | null;
    strategyMode?: string;
    kstHour?: number;
  };
}

export interface TechSnapshot {
  rsi?: number | null;
  volumeRatio?: number | null;
  aboveMa20?: boolean | null;
  isMomentum?: boolean | null;
}

/**
 * CEO 지시 #A: 저녁 18:00~24:00 KST 하드 블락
 * - 국내 단일가 16-18시 직후 유동성 메마름
 * - 미국 프리/정규장 개장 초기 휩소·갭하락 폭발
 * - 290건 분석: 이 시간대 매수 = -6%~-14% 손실 다수
 *
 * → 점수/모드/보너스 무관 100% 차단
 */
function isEveningHardBlock(kstHour: number, _kstMinute: number): boolean {
  return kstHour >= 18 && kstHour < 24;
}

/** CEO 지시 #B: SWING 외 전략 차단 */
function isStrategyAllowed(strategyMode: string | undefined): boolean {
  if (!strategyMode) return true; // 미지정 시 통과 (manual-buy 등)
  return ALLOWED_STRATEGIES.has(strategyMode);
}

export function checkEntryTiming(params: {
  tech?: TechSnapshot;
  aiScore: number;
  marketCode?: 'KR' | 'US';
  isClaudeManual?: boolean;
  strategyMode?: string;
}): EntryTimingCheck {
  const market = params.marketCode ?? 'KR';
  const tech = params.tech ?? {};

  // KST 시간 계산
  const now = new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();

  // ─ v17: 규칙 A: 저녁 18-24 KST → 하드블락 복원 (v16 regression 수정) ─
  // v16에서 소프트로 완화됐으나 CEO 290건 분석 -6%~-14% 손실 구간 → 하드블락 유지
  if (isEveningHardBlock(kstH, kstM)) {
    return {
      allowed: false,
      scoreBonus: 0,
      sizeMultiplier: 1,
      reason: `🚫 저녁 하드블락 (${String(kstH).padStart(2, '0')}:${String(kstM).padStart(2, '0')} KST): 18-24시 → 290건 분석 손실 구간`,
      details: {
        phase: 'EVENING_HARD',
        rsi: tech.rsi ?? null,
        volumeRatio: tech.volumeRatio ?? null,
        aboveMa20: tech.aboveMa20 ?? null,
        strategyMode: params.strategyMode,
        kstHour: kstH,
      },
    };
  }

  // ─ v16: 규칙 B: 단기 전략 → 소프트 (50% 축소) ─
  if (!isStrategyAllowed(params.strategyMode)) {
    return {
      allowed: true,
      scoreBonus: 10,
      sizeMultiplier: 0.5,
      reason: `🟡 전략 [${params.strategyMode}] → 50% 축소 (SWING 75% vs 단기 23% 승률)`,
      details: {
        phase: 'STRATEGY_SOFT',
        rsi: tech.rsi ?? null,
        volumeRatio: tech.volumeRatio ?? null,
        aboveMa20: tech.aboveMa20 ?? null,
        strategyMode: params.strategyMode,
        kstHour: kstH,
      },
    };
  }

  // ─ 시간대 검증 (KR 기준 마의시간 등) ─
  let phase = '';
  let scoreBonus = 0;
  if (market === 'KR') {
    phase = getKrMarketPhase();
    // v9-fix: CURSED 하드블럭 제거 — pipeline.ts의 isLunchBan이 이미 시간 차단 처리
    // entry-timing-guard까지 이중 차단하면 10:20~13:00 완전 매수 금지 → 기회 상실
    // 대신 score bonus +5 요구로 완화 (낮은 점수 진입만 차단)
    if (phase === 'CURSED') {
      scoreBonus = CURSED_SCORE_BONUS;
      if (params.aiScore < BASE_MIN_SCORE + scoreBonus) {
        return {
          allowed: false,
          scoreBonus,
          reason: `⚠️ 마의시간 (10:20~13:00): 점수 ${params.aiScore} < 필요 ${BASE_MIN_SCORE + scoreBonus} (저확신 차단)`,
          details: {
            phase,
            rsi: tech.rsi ?? null,
            volumeRatio: tech.volumeRatio ?? null,
            aboveMa20: tech.aboveMa20 ?? null,
            strategyMode: params.strategyMode,
            kstHour: kstH,
          },
        };
      }
    }
    if (phase === 'CLOSED') {
      // 저녁이 아닌 장외 (06:30~09:00, 15:30~18:00): 점수 보너스 요구
      scoreBonus = params.isClaudeManual ? CLOSED_MANUAL_SCORE_BONUS : CLOSED_AUTO_SCORE_BONUS;
      if (params.aiScore < BASE_MIN_SCORE + scoreBonus) {
        return {
          allowed: false,
          scoreBonus,
          reason: `🌙 장외 매수: 점수 ${params.aiScore} < 필요 ${BASE_MIN_SCORE + scoreBonus}`,
          details: {
            phase,
            rsi: tech.rsi ?? null,
            volumeRatio: tech.volumeRatio ?? null,
            aboveMa20: tech.aboveMa20 ?? null,
            strategyMode: params.strategyMode,
            kstHour: kstH,
          },
        };
      }
    }
  }

  // ─ 기술지표 다중 확증 ─
  const reasons: string[] = [];
  const failures: string[] = [];

  if (tech.rsi != null) {
    if (tech.rsi > RSI_OVERBOUGHT_THRESHOLD) failures.push(`RSI ${tech.rsi.toFixed(0)} > ${RSI_OVERBOUGHT_THRESHOLD} (과매수)`);
    else if (tech.rsi < RSI_OVERSOLD_THRESHOLD && !tech.isMomentum) failures.push(`RSI ${tech.rsi.toFixed(0)} < ${RSI_OVERSOLD_THRESHOLD} + 모멘텀 없음`);
    else reasons.push(`RSI ${tech.rsi.toFixed(0)} ✓`);
  }
  if (tech.volumeRatio != null) {
    if (tech.volumeRatio < VOLUME_MIN_RATIO) failures.push(`거래량 ${tech.volumeRatio.toFixed(1)}x < ${VOLUME_MIN_RATIO}`);
    else if (tech.volumeRatio >= VOLUME_BULL_RATIO) reasons.push(`거래량 ${tech.volumeRatio.toFixed(1)}x ✓`);
  }
  if (tech.aboveMa20 === false) failures.push(`MA20 아래 (하락추세)`);
  else if (tech.aboveMa20 === true) reasons.push(`MA20 위 ✓`);

  // v16: 기술지표 다중 위험 → 소프트 (50% 축소)
  if (failures.length >= MAX_TECH_FAILURES) {
    return {
      allowed: true,
      scoreBonus: scoreBonus + 5,
      sizeMultiplier: 0.5,
      reason: `🟡 기술지표 위험(${failures.length}개) → 50% 축소: ${failures.join(', ')}`,
      details: {
        phase,
        rsi: tech.rsi ?? null,
        volumeRatio: tech.volumeRatio ?? null,
        aboveMa20: tech.aboveMa20 ?? null,
        strategyMode: params.strategyMode,
        kstHour: kstH,
      },
    };
  }

  return {
    allowed: true,
    scoreBonus,
    reason: `진입 OK [${phase || market}/${params.strategyMode ?? 'AUTO'}] ${reasons.join(', ')}${failures.length === 1 ? ` (경고: ${failures[0]})` : ''}`,
    details: {
      phase,
      rsi: tech.rsi ?? null,
      volumeRatio: tech.volumeRatio ?? null,
      aboveMa20: tech.aboveMa20 ?? null,
      strategyMode: params.strategyMode,
      kstHour: kstH,
    },
  };
}

// ─────────────────────────────────────────────────────
// CEO 지시 #C: 시간 가중치 트레일링 스탑
// ─────────────────────────────────────────────────────

export type StopAction =
  | 'HOLD' // 매도 보류 (구조적 SL만 허용)
  | 'BREAK_EVEN' // 본절로 SL 이동
  | 'TRAIL_TIGHTEN' // 트레일링 강화
  | 'EXECUTE_SL'; // 손절 실행

export interface TimeWeightedStop {
  action: StopAction;
  effectiveSlPct: number;
  reason: string;
  holdingHours: number;
}

/**
 * 시간 가중치 트레일링 스탑
 *
 * Phase 1 (진입 후 0~48h): 초기 휩소 방어
 *   - 구조적 SL만 허용 (-5% 이상 큰 손실 or MA20 이탈)
 *   - 작은 손실 (-3%~-5%) 보류 → 6-10일 보유 패턴 유도
 *
 * Phase 2 (48~72h, 3일 차): 본절 이동
 *   - 수익권(+1%↑) 진입 시 SL → 본절(매수가)로 이동
 *   - 손실 중이면 일반 SL 적용
 *
 * Phase 3 (72h+, 수익권): 트레일링 강화
 *   - 평소 SL 또는 트레일링 사용
 *
 * @param params 보유 정보
 */
export function getTimeWeightedStop(params: {
  holdingHours: number;
  pnlPct: number;
  baseSlPct: number; // 기본 SL (예: -3.0)
  belowMa20?: boolean;
  belowPrevLow?: boolean; // 전저점 이탈
}): TimeWeightedStop {
  const { holdingHours, pnlPct, baseSlPct, belowMa20, belowPrevLow } = params;
  const absBase = Math.abs(baseSlPct);

  // Phase 1: 0~24h 초기 휩소 방어 (v12.3: 12h→24h — 미국장 프리마켓 갭 커버)
  if (holdingHours < 24) {
    // 구조적 위반: MA20 이탈 또는 전저점 이탈 → 무조건 매도
    if (belowMa20 || belowPrevLow) {
      return {
        action: 'EXECUTE_SL',
        effectiveSlPct: pnlPct,
        reason: `구조적 SL: ${belowMa20 ? 'MA20↓' : '전저점↓'} (${holdingHours.toFixed(0)}h)`,
        holdingHours,
      };
    }
    // v10: Phase1 SL 한계 1.5x→1.2x (AI 없이 과도한 손실 방지: -4.5%×1.2=-5.4%)
    if (pnlPct <= -absBase * 1.2) {
      return {
        action: 'EXECUTE_SL',
        effectiveSlPct: -absBase * 1.2,
        reason: `대손절: PnL ${pnlPct.toFixed(1)}% <= ${(-absBase * 1.2).toFixed(1)}% (Phase1 한계)`,
        holdingHours,
      };
    }
    // 작은 손실 보류: 초기 휩소로 판단
    return {
      action: 'HOLD',
      effectiveSlPct: -absBase * 1.2, // v10: 실제 작동 SL은 -1.2x
      reason: `🛡️ 초기 48h 버퍼: PnL ${pnlPct.toFixed(1)}% — 구조적 SL만 허용 (휩소 방어)`,
      holdingHours,
    };
  }

  // Phase 2: 24~48h 본절 이동 (v12.3: 12~24h→24~48h — 충분한 관찰 후 판단)
  if (holdingHours < 48) {
    // 수익권 충분 진입 시 본절
    if (pnlPct >= 3.0) {
      return {
        action: 'BREAK_EVEN',
        effectiveSlPct: -1.0, // v9: 0%→-1% (약간의 여유)
        reason: `💼 본절 이동 (${holdingHours.toFixed(0)}h, PnL +${pnlPct.toFixed(1)}%) — 최소 -1% 보장`,
        holdingHours,
      };
    }
    // 손실 중이면 일반 SL
    if (pnlPct <= baseSlPct) {
      return {
        action: 'EXECUTE_SL',
        effectiveSlPct: baseSlPct,
        reason: `Phase2 손절: PnL ${pnlPct.toFixed(1)}% <= ${baseSlPct}%`,
        holdingHours,
      };
    }
    return {
      action: 'HOLD',
      effectiveSlPct: baseSlPct,
      reason: `Phase2 유지: PnL ${pnlPct.toFixed(1)}% (본절 대기)`,
      holdingHours,
    };
  }

  // Phase 3: 24h+ 트레일링 강화 (v10.3: 72h→24h)
  // 수익권: 본절 + 트레일링
  if (pnlPct >= 2.0) {
    return {
      action: 'TRAIL_TIGHTEN',
      effectiveSlPct: Math.max(0, pnlPct - 2.0), // 고점 대비 -2% 트레일링
      reason: `🚀 트레일링 (Phase3, ${(holdingHours / 24).toFixed(1)}일): SL = +${Math.max(0, pnlPct - 2.0).toFixed(1)}%`,
      holdingHours,
    };
  }
  // 본절 도달 — 본절 유지
  if (pnlPct >= 0) {
    return {
      action: 'BREAK_EVEN',
      effectiveSlPct: -1.0, // v9: 0%→-1% (노이즈 여유)
      reason: `Phase3 본절 유지 (${(holdingHours / 24).toFixed(1)}일)`,
      holdingHours,
    };
  }
  // Phase3 SL: 기본 SL 이하 급락 시 즉시 손절 (갭다운 방어)
  if (pnlPct <= baseSlPct) {
    return {
      action: 'EXECUTE_SL',
      effectiveSlPct: baseSlPct,
      reason: `Phase3 SL: PnL ${pnlPct.toFixed(1)}% <= SL ${baseSlPct}% (${(holdingHours / 24).toFixed(1)}일)`,
      holdingHours,
    };
  }
  // v9-fix: 손실 중 강제 청산 72h→120h (5일, 회복 기회 부여)
  if (holdingHours >= 120) {
    return {
      action: 'EXECUTE_SL',
      effectiveSlPct: baseSlPct,
      reason: `Phase3 손절 (5일+ 손실): PnL ${pnlPct.toFixed(1)}%`,
      holdingHours,
    };
  }
  // 3~5일 손실 중: SL 위 범위에서 회복 대기
  return {
    action: 'HOLD',
    effectiveSlPct: baseSlPct,
    reason: `Phase3 유지 (${(holdingHours / 24).toFixed(1)}일 손실 중): PnL ${pnlPct.toFixed(1)}% — 5일까지 회복 대기`,
    holdingHours,
  };
}

