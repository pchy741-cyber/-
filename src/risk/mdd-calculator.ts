/**
 * 📉 월간 MDD (Maximum Drawdown) 통합 계산기 — SSoT (Single Source of Truth)
 *
 * v25 변경:
 *   - 50% 급감 휴리스틱 → cash_flows 기반 정밀 판정
 *   - 입출금 반영 후에도 급감이면 진짜 MDD
 *   - 일 종가(마지막 스냅샷) 기준으로 변경
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
  /** 외부 입출금 감지 여부 (cash_flows 기반) */
  externalActivity: boolean;
  /** 측정 가능한 스냅샷 개수 (< 2면 의미 없음) */
  samples: number;
}

/**
 * 월간 MDD 스냅샷 — 모든 호출처가 이 함수 통과
 *
 * v25: cash_flows 테이블 기반 입출금 감지 (기존 50% 휴리스틱 대체)
 * 입출금이 있는 날은 flow-adjusted 평가액으로 MDD 계산
 */
export async function getMonthlyMddSnapshot(isPaper: boolean): Promise<MonthlyMddSnapshot> {
  const kstNow = getKSTNow();
  const monthStart = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), 1, 0, 0, 0, 0));
  // KST 00:00 = UTC 전날 15:00
  monthStart.setTime(monthStart.getTime() - 9 * 60 * 60 * 1000);
  const pool = getPool();

  let snapRows: { date: string; total_value: string }[] = [];
  let flowRows: { date: string; net_flow: string }[] = [];

  try {
    // v25: 일 마지막 스냅샷 (종가 기준)
    const [snapResult, flowResult] = await Promise.all([
      pool.query<{ date: string; total_value: string }>(
        `SELECT DISTINCT ON ((snapshot_at AT TIME ZONE 'Asia/Seoul')::date)
           (snapshot_at AT TIME ZONE 'Asia/Seoul')::date AS date,
           total_value
         FROM portfolio_snapshots
         WHERE snapshot_at >= $1 AND is_paper = $2
         ORDER BY (snapshot_at AT TIME ZONE 'Asia/Seoul')::date, snapshot_at DESC`,
        [monthStart.toISOString(), isPaper],
      ),
      pool.query<{ date: string; net_flow: string }>(
        `SELECT (flow_at AT TIME ZONE 'Asia/Seoul')::date AS date,
                SUM(amount_krw) AS net_flow
         FROM cash_flows
         WHERE is_paper = $1
           AND flow_at >= $2
         GROUP BY 1`,
        [isPaper, monthStart.toISOString()],
      ).catch(() => ({ rows: [] as { date: string; net_flow: string }[] })),
    ]);
    snapRows = snapResult.rows;
    flowRows = flowResult.rows;
  } catch {
    return { peak: 0, latest: 0, mddPct: 0, externalActivity: false, samples: 0 };
  }

  if (snapRows.length < 2) {
    return { peak: 0, latest: 0, mddPct: 0, externalActivity: false, samples: snapRows.length };
  }

  // cash flow 맵
  const flowMap = new Map<string, number>();
  for (const f of flowRows) flowMap.set(f.date, Number(f.net_flow));
  const hasFlows = flowMap.size > 0;

  // TWR 에퀴티 커브 (flow 제거 후 순수 성과)
  const equityCurve: number[] = [1];
  for (let i = 1; i < snapRows.length; i++) {
    const vPrev = Number(snapRows[i - 1].total_value);
    const vCur = Number(snapRows[i].total_value);
    const flow = flowMap.get(snapRows[i].date) ?? 0;
    const denom = vPrev + flow;
    if (denom > 0) {
      const r = (vCur - vPrev - flow) / denom;
      equityCurve.push(equityCurve[equityCurve.length - 1] * (1 + r));
    } else {
      equityCurve.push(equityCurve[equityCurve.length - 1]);
    }
  }

  let peak = equityCurve[0];
  let maxDd = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = peak > 0 ? ((peak - val) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const latestValue = Number(snapRows[snapRows.length - 1].total_value);
  const peakValue = Number(snapRows.reduce((best, r) =>
    Number(r.total_value) > Number(best.total_value) ? r : best, snapRows[0]).total_value);

  return {
    peak: peakValue,
    latest: latestValue,
    mddPct: maxDd,
    externalActivity: hasFlows,
    samples: snapRows.length,
  };
}

/**
 * 월간 MDD %만 필요할 때 — 외부 활동/소자산 체크 없이 단순 값만
 */
export async function computeMonthlyMddPct(isPaper: boolean): Promise<number> {
  const snap = await getMonthlyMddSnapshot(isPaper);
  return snap.mddPct;
}
