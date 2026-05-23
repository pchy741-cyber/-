/**
 * 종목별 과거 승률 계산 — score_accuracy 테이블 기반
 * AI 없어도 "이 종목은 과거에 얼마나 잘 됐나"를 반영해 진입 임계값 동적 조정
 */
import { config } from '../config/index.js';
import { getPool } from '../db/client.js';

export interface StockWinRate {
  winRate: number;      // 0~1
  avgPnlPct: number;    // 평균 실현 수익률 %
  sampleCount: number;  // 근거 매매 건수
}

/**
 * 종목 코드 목록의 90일 내 승률 조회
 * 최소 3건 이상인 종목만 반환 (표본 부족 종목은 neutral 처리)
 */
export async function getStockWinRates(stockCodes: string[]): Promise<Map<string, StockWinRate>> {
  const map = new Map<string, StockWinRate>();
  if (stockCodes.length === 0) return map;
  try {
    const { rows } = await getPool().query(`
      SELECT
        stock_code,
        COUNT(*)::int                                        AS total,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END)::int AS wins,
        AVG(realized_pnl_pct)::float                         AS avg_pnl
      FROM score_accuracy
      WHERE stock_code = ANY($1)
        AND recorded_at >= NOW() - INTERVAL '90 days'
        AND is_paper = $2
      GROUP BY stock_code
      HAVING COUNT(*) >= 3
    `, [stockCodes, config.isPaper]);
    for (const r of rows) {
      map.set(String(r.stock_code), {
        winRate: Number(r.wins) / Number(r.total),
        avgPnlPct: Number(r.avg_pnl ?? 0),
        sampleCount: Number(r.total),
      });
    }
  } catch { /* DB 없으면 빈 맵 반환 — 외부 로직에서 0 보정 처리 */ }
  return map;
}

/**
 * 승률 기반 minTechScore 보정값
 * 고승률 종목 → 진입 쉽게, 저승률 종목 → 진입 엄격하게
 */
export function getWinRateThresholdAdj(wr: StockWinRate | undefined): number {
  if (!wr || wr.sampleCount < 3) return 0;
  // 데이터 많을수록 신뢰도 → 더 강하게 적용
  const dataBias = wr.sampleCount >= 8 ? 1.3 : wr.sampleCount >= 5 ? 1.15 : 1.0;
  if (wr.winRate >= 0.80 && wr.avgPnlPct > 0) return Math.round(-20 * dataBias); // 80%+ 검증 → 매우 적극
  if (wr.winRate >= 0.65 && wr.avgPnlPct > 0) return Math.round(-15 * dataBias); // 고승률 → 적극 진입
  if (wr.winRate >= 0.55) return Math.round(-8 * dataBias);
  if (wr.winRate <= 0.28) return Math.round(+20 * dataBias);  // 저승률 → 강력 차단
  if (wr.winRate <= 0.40) return Math.round(+12 * dataBias);
  return 0;
}

/**
 * 승률 기반 confidence 보정값
 */
export function getWinRateConfidenceBoost(wr: StockWinRate | undefined): number {
  if (!wr || wr.sampleCount < 3) return 0;
  const dataBias = wr.sampleCount >= 8 ? 1.3 : wr.sampleCount >= 5 ? 1.15 : 1.0;
  if (wr.winRate >= 0.80) return Math.min(0.20, +(0.12 * dataBias));
  if (wr.winRate >= 0.65) return Math.min(0.15, +(0.08 * dataBias));
  if (wr.winRate >= 0.55) return +(0.04 * dataBias);
  if (wr.winRate <= 0.28) return -(0.12 * dataBias);
  if (wr.winRate <= 0.40) return -(0.06 * dataBias);
  return 0;
}

/**
 * 로그용 승률 요약 문자열
 */
export function winRateSummary(code: string, wr: StockWinRate | undefined): string {
  if (!wr) return '';
  const adj = getWinRateThresholdAdj(wr);
  const sign = adj > 0 ? `+${adj}` : String(adj);
  return ` [승률${(wr.winRate * 100).toFixed(0)}%/${wr.sampleCount}건 → 임계${sign}]`;
}
