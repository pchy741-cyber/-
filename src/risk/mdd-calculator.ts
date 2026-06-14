/**
 * 📉 월간 MDD (Maximum Drawdown) 통합 계산기 — SSoT (Single Source of Truth)
 *
 * 이전 (2026-06-12 이전):
 *   - automation/mdd-guard.ts: computeMonthlyMdd()
 *   - risk/risk-engine.ts: checkMonthlyMDD() 내 인라인 계산
 *   - api/routes/review/copilot.ts: 동일 쿼리 반복
 *   - api/routes/review/copilot-lite.ts: 동일 쿼리 반복
 *
 * 변경:
 *   - 모든 곳에서 computeMonthlyMddPct() / getMonthlyMddSnapshot() 사용
 *   - 외부 입출금 감지 (50% 급감 = 정상이 아닌 외부 사유)
 *   - 소자산 면제 (currentTotal < threshold)
 */

import { getPool } from '../db/client.js';
import { getKSTNow } from '../utils/time.js';

export interface MonthlyMddSnapshot {
  /** 월간 고점 (KRW) */
  peak: number;
  /** 최신 평가액 (KRW) */
  latest: number;
  /** MDD % (양수, 0이면 손실 없음) */
  mddPct: number;
  /** 외부 입출금 감지 여부 (50% 이상 급감) */
  externalActivity: boolean;
  /** 측정 가능한 스냅샷 개수 (< 2면 의미 없음) */
  samples: number;
}

/**
 * 월간 MDD 스냅샷 — 모든 호출처가 이 함수 통과
 *
 * 반환값 해석:
 *   - samples < 2: 데이터 부족, mddPct = 0
 *   - externalActivity = true: 50% 이상 급감, MDD 판단 신뢰 불가 (외부 매도/출금 가능성)
 *   - mddPct: 고점 대비 낙폭 %
 */
export async function getMonthlyMddSnapshot(isPaper: boolean): Promise<MonthlyMddSnapshot> {
  // KST 기준 월초 계산 (UTC 서버에서도 정확한 한국시간 사용)
  const kstNow = getKSTNow();
  const monthStart = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), 1, 0, 0, 0, 0));
  // KST 00:00 = UTC 전날 15:00
  monthStart.setTime(monthStart.getTime() - 9 * 60 * 60 * 1000);

  let rows: { total_value: string }[] = [];
  try {
    const result = await getPool().query<{ total_value: string }>(
      `SELECT total_value FROM portfolio_snapshots
       WHERE snapshot_at >= $1 AND is_paper = $2
       ORDER BY snapshot_at ASC`,
      [monthStart.toISOString(), isPaper],
    );
    rows = result.rows;
  } catch {
    return { peak: 0, latest: 0, mddPct: 0, externalActivity: false, samples: 0 };
  }

  const values = rows.map((r) => Number(r.total_value)).filter((v) => v > 0);
  if (values.length < 2) {
    return { peak: 0, latest: 0, mddPct: 0, externalActivity: false, samples: values.length };
  }

  const peak = Math.max(...values);
  const latest = values[values.length - 1];
  const externalActivity = peak > 0 && latest < peak * 0.5;
  const mddPct = peak > 0 ? ((peak - latest) / peak) * 100 : 0;

  return { peak, latest, mddPct, externalActivity, samples: values.length };
}

/**
 * 월간 MDD %만 필요할 때 — 외부 활동/소자산 체크 없이 단순 값만
 */
export async function computeMonthlyMddPct(isPaper: boolean): Promise<number> {
  const snap = await getMonthlyMddSnapshot(isPaper);
  return snap.mddPct;
}
