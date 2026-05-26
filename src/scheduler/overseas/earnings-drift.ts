/**
 * 어닝 드리프트 사냥 — 실적 발표 후 갭업/갭다운 + 고거래량 드리프트 감지
 * 어닝 서프라이즈 후 가격이 수일간 같은 방향으로 움직이는 PEAD 효과 활용
 */
import { logger } from '../../utils/logger.js';
import { getUpcomingEarnings } from '../../market/external-signals.js';
import type { TechResult } from './sell-logic.js';

// ── 타입 ──

export interface EarningsDriftSignal {
  code: string;
  gapPct: number;        // 갭업/갭다운 %
  volumeRatio: number;   // 평균 대비 거래량 배수
  direction: 'BULL' | 'BEAR';
  strength: number;      // 0~1 신호 강도
}

// ── 캐시 (같은 어닝 이벤트 중복 감지 방지) ──
const _driftCache = new Map<string, { signal: EarningsDriftSignal; detectedAt: number }>();
const DRIFT_CACHE_TTL = 24 * 60 * 60_000; // 24시간

/**
 * 어닝 발표 후 갭업 +5% 이상 + 거래량 2x → 매수 신호
 * - techResults에서 changePct >= 5% && 거래량 데이터 확인
 * - getUpcomingEarnings로 최근 어닝 발표 종목 확인 (daysUntil이 0~-2인 종목)
 * - 갭업 + 고거래량 = BULL 드리프트 신호
 */
export async function detectEarningsDrift(
  codes: string[],
  techResults: TechResult[],
): Promise<EarningsDriftSignal[]> {
  const signals: EarningsDriftSignal[] = [];

  try {
    // 최근 어닝 발표 종목 조회 (daysUntil 0 ~ -2 = 방금 발표됨)
    const earnings = await getUpcomingEarnings(codes);
    const recentEarningsCodes = new Set(
      earnings
        .filter(e => e.daysUntil <= 0 && e.daysUntil >= -2)
        .map(e => e.code),
    );

    if (recentEarningsCodes.size === 0) return signals;

    for (const tech of techResults) {
      if (!recentEarningsCodes.has(tech.code)) continue;

      // 캐시된 신호가 있으면 재사용
      const cached = _driftCache.get(tech.code);
      if (cached && Date.now() - cached.detectedAt < DRIFT_CACHE_TTL) {
        signals.push(cached.signal);
        continue;
      }

      const changePct = tech.price.changePct;
      const absChange = Math.abs(changePct);

      // 갭업/갭다운 5% 이상만 감지
      if (absChange < 5) continue;

      // 거래량 배수 추정 (dayRangePct 기반 프록시 — 정확한 평균 거래량 없음)
      // 높은 dayRangePct + isBigMover = 고거래량 신호
      const volumeRatio = tech.isBigMover ? 3.0
        : tech.isMomentum ? 2.0
        : tech.dayRangePct > 60 ? 1.5
        : 1.0;

      // 거래량 2배 미만이면 스킵
      if (volumeRatio < 2.0) continue;

      const direction: 'BULL' | 'BEAR' = changePct > 0 ? 'BULL' : 'BEAR';
      // 신호 강도: gapPct/10 * volumeRatio/3, 최대 1.0
      const strength = Math.min(1, (absChange / 10) * (volumeRatio / 3));

      const signal: EarningsDriftSignal = {
        code: tech.code,
        gapPct: changePct,
        volumeRatio,
        direction,
        strength,
      };

      signals.push(signal);
      _driftCache.set(tech.code, { signal, detectedAt: Date.now() });

      logger.info(
        `[EarningsDrift] ${tech.code} ${direction} gap=${changePct.toFixed(1)}% vol=${volumeRatio.toFixed(1)}x strength=${strength.toFixed(2)}`,
        { component: 'OVERSEAS' },
      );
    }

    // 만료된 캐시 정리
    const now = Date.now();
    for (const [key, val] of _driftCache) {
      if (now - val.detectedAt > DRIFT_CACHE_TTL) _driftCache.delete(key);
    }
  } catch (err: any) {
    logger.warn(`어닝 드리프트 감지 실패: ${err.message}`, { component: 'OVERSEAS' });
  }

  return signals;
}
