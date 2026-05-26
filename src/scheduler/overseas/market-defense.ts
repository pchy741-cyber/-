/**
 * 숏 시그널 / 선제적 방어 — F&G + VIX 기반 포지션 축소 및 매수 차단
 * 시장 과열/공포 감지 후 자동으로 방어 모드 전환
 */
import { logger } from '../../utils/logger.js';
import { getFearGreedIndex } from '../../market/external-signals.js';

// ── 타입 ──

export type DefenseLevel = 'NONE' | 'CAUTION' | 'REDUCE' | 'EMERGENCY';

export interface DefenseSignal {
  level: DefenseLevel;
  positionReduction: number;  // 0~0.5 (포지션 축소 비율)
  blockNewBuys: boolean;
  trailTighten: number;       // 추가 트레일링 타이트닝 (%p)
  reasons: string[];
}

// ── 캐시 (10분) ──
let _defenseCache: { signal: DefenseSignal; fetchedAt: number } | null = null;
const DEFENSE_CACHE_TTL = 10 * 60_000; // 10분

// ── 임계값 상수 ──
const THRESHOLDS = {
  CAUTION:   { fg: 70, vix: 22 },
  REDUCE:    { fg: 78, vix: 28 },
  EMERGENCY: { fg: 85, vix: 35 },
  NORMAL_FG_MIN: 30,
  NORMAL_FG_MAX: 65,
  NORMAL_VIX_MAX: 22,
} as const;

/**
 * 시장 방어 수준 평가
 * - NONE: 정상 (F&G 30~65, VIX < 22)
 * - CAUTION: F&G >= 70 OR VIX >= 22
 * - REDUCE: F&G >= 78 OR VIX >= 28
 * - EMERGENCY: F&G >= 85 OR VIX >= 35
 * - 복합 조건: F&G > 70 AND VIX > 22 → 한 단계 업그레이드
 */
export async function evaluateMarketDefense(): Promise<DefenseSignal> {
  // 캐시 유효 시 반환
  if (_defenseCache && Date.now() - _defenseCache.fetchedAt < DEFENSE_CACHE_TTL) {
    return _defenseCache.signal;
  }

  const defaultSignal: DefenseSignal = {
    level: 'NONE',
    positionReduction: 0,
    blockNewBuys: false,
    trailTighten: 0,
    reasons: [],
  };

  try {
    const sentiment = await getFearGreedIndex();
    if (!sentiment) {
      _defenseCache = { signal: defaultSignal, fetchedAt: Date.now() };
      return defaultSignal;
    }

    const { fearGreedScore: fg, vix } = sentiment;
    const reasons: string[] = [];
    let level: DefenseLevel = 'NONE';

    // 단계별 판정 (높은 단계부터)
    if (fg >= THRESHOLDS.EMERGENCY.fg || vix >= THRESHOLDS.EMERGENCY.vix) {
      level = 'EMERGENCY';
      if (fg >= THRESHOLDS.EMERGENCY.fg) reasons.push(`F&G=${fg}(극탐욕)`);
      if (vix >= THRESHOLDS.EMERGENCY.vix) reasons.push(`VIX=${vix.toFixed(1)}(공황)`);
    } else if (fg >= THRESHOLDS.REDUCE.fg || vix >= THRESHOLDS.REDUCE.vix) {
      level = 'REDUCE';
      if (fg >= THRESHOLDS.REDUCE.fg) reasons.push(`F&G=${fg}(과열)`);
      if (vix >= THRESHOLDS.REDUCE.vix) reasons.push(`VIX=${vix.toFixed(1)}(스트레스)`);
    } else if (fg >= THRESHOLDS.CAUTION.fg || vix >= THRESHOLDS.CAUTION.vix) {
      level = 'CAUTION';
      if (fg >= THRESHOLDS.CAUTION.fg) reasons.push(`F&G=${fg}(탐욕)`);
      if (vix >= THRESHOLDS.CAUTION.vix) reasons.push(`VIX=${vix.toFixed(1)}(주의)`);
    }

    // 복합 조건: F&G > 70 AND VIX > 22 → 한 단계 업그레이드
    if (fg > THRESHOLDS.CAUTION.fg && vix > THRESHOLDS.CAUTION.vix) {
      if (level === 'CAUTION') {
        level = 'REDUCE';
        reasons.push('복합조건(F&G+VIX) 업그레이드');
      } else if (level === 'REDUCE') {
        level = 'EMERGENCY';
        reasons.push('복합조건(F&G+VIX) 업그레이드');
      }
    }

    // 레벨별 파라미터
    const signal = buildDefenseSignal(level, reasons);

    _defenseCache = { signal, fetchedAt: Date.now() };

    if (level !== 'NONE') {
      logger.info(
        `[MarketDefense] ${level}: reduction=${(signal.positionReduction * 100).toFixed(0)}% block=${signal.blockNewBuys} trail+${signal.trailTighten} — ${reasons.join(', ')}`,
        { component: 'OVERSEAS' },
      );
    }

    return signal;
  } catch (err: any) {
    logger.warn(`시장 방어 평가 실패: ${err.message}`, { component: 'OVERSEAS' });
    _defenseCache = { signal: defaultSignal, fetchedAt: Date.now() };
    return defaultSignal;
  }
}

/** 레벨별 방어 파라미터 구성 */
function buildDefenseSignal(level: DefenseLevel, reasons: string[]): DefenseSignal {
  switch (level) {
    case 'EMERGENCY':
      return {
        level,
        positionReduction: 0.4,
        blockNewBuys: true,
        trailTighten: 2.0,
        reasons,
      };
    case 'REDUCE':
      return {
        level,
        positionReduction: 0.2,
        blockNewBuys: false,
        trailTighten: 1.0,
        reasons,
      };
    case 'CAUTION':
      return {
        level,
        positionReduction: 0,
        blockNewBuys: false,
        trailTighten: 0.5,
        reasons,
      };
    default:
      return {
        level: 'NONE',
        positionReduction: 0,
        blockNewBuys: false,
        trailTighten: 0,
        reasons,
      };
  }
}
