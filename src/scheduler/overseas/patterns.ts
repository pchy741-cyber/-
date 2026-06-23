/**
 * Memory Agent 패턴 — 거래 결과 자동 패턴 추출 + 저승률 종목 차단
 */
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { ctxMode } from './utils.js';

export interface TradingPattern {
  pattern: string;
  evidence: string;
  confidence: number;
  actionable: boolean;
}

export async function extractTradingPatterns(isPaper?: boolean): Promise<TradingPattern[]> {
  const patterns: TradingPattern[] = [];
  const mode = ctxMode(isPaper);

  try {
    // 종목별 승률 패턴
    const { rows: stockWr } = await getPool().query(
      `
      SELECT stock_code,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE filled_price > avg_buy_price) AS wins,
             ROUND(AVG(CASE WHEN filled_price > avg_buy_price
               THEN ((filled_price - avg_buy_price) / avg_buy_price * 100)
               ELSE NULL END)::numeric, 1) AS avg_win_pct,
             ROUND(AVG(CASE WHEN filled_price <= avg_buy_price
               THEN ((filled_price - avg_buy_price) / avg_buy_price * 100)
               ELSE NULL END)::numeric, 1) AS avg_loss_pct
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
        AND avg_buy_price > 0 AND filled_price > 0
        AND created_at >= NOW() - INTERVAL '60 days'
      GROUP BY stock_code
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC
    `,
      [mode],
    );

    for (const r of stockWr) {
      const wr = Number(r.wins) / Number(r.total);
      const code = r.stock_code;
      if (wr >= 0.7 && Number(r.total) >= 5) {
        patterns.push({
          pattern: `${code} 고승률 종목`,
          evidence: `승률 ${(wr * 100).toFixed(0)}% (${r.total}건), 평균수익 +${r.avg_win_pct ?? 0}%`,
          confidence: wr,
          actionable: true,
        });
      // v10.11.4: >= 4 → >= 5 (전체 모듈 최소 샘플 수 통일)
    } else if (wr <= 0.25 && Number(r.total) >= 5) {
        patterns.push({
          pattern: `${code} 저승률 종목 — 제외 검토`,
          evidence: `승률 ${(wr * 100).toFixed(0)}% (${r.total}건), 평균손실 ${r.avg_loss_pct ?? 0}%`,
          confidence: 1 - wr,
          actionable: true,
        });
      }
    }

    // 시간대별 승률 패턴 (요일)
    const { rows: dayWr } = await getPool().query(
      `
      SELECT
        EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York') AS dow,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE filled_price > avg_buy_price) AS wins
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
        AND avg_buy_price > 0 AND filled_price > 0
        AND created_at >= NOW() - INTERVAL '90 days'
      GROUP BY dow
      HAVING COUNT(*) >= 5
      ORDER BY dow
    `,
      [mode],
    );

    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    for (const r of dayWr) {
      const wr = Number(r.wins) / Number(r.total);
      const dow = Number(r.dow);
      if (wr <= 0.3 && Number(r.total) >= 5) {
        patterns.push({
          pattern: `${dayNames[dow]}요일 저승률`,
          evidence: `승률 ${(wr * 100).toFixed(0)}% (${r.total}건) — 진입 축소 권장`,
          confidence: 0.7,
          actionable: true,
        });
      }
    }

    // 패턴을 DB에 저장 (learned_insights 테이블 활용)
    for (const p of patterns.filter((p) => p.actionable)) {
      await getPool()
        .query(
          `
        INSERT INTO overseas_state (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = $2
      `,
          [`pattern_${p.pattern.replace(/\s/g, '_').substring(0, 50)}`, JSON.stringify(p)],
        )
        .catch(() => {});
    }
  } catch (e) {
    logger.warn(`패턴 추출 실패: ${(e as Error).message}`, { component: 'RISK_INTEL' });
  }

  return patterns;
}

/** Memory Agent: 저승률 종목 차단 Set 반환 (승률 25% 이하, 4건 이상) */
export async function getMemoryBlockedStocks(isPaper?: boolean): Promise<Set<string>> {
  try {
    const mode = ctxMode(isPaper);
    const { rows } = await getPool().query(
      `
      SELECT stock_code
      FROM orders
      WHERE side = 'SELL' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
        AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
        AND avg_buy_price > 0 AND filled_price > 0
        AND created_at >= NOW() - INTERVAL '60 days'
      GROUP BY stock_code
      HAVING COUNT(*) >= 5
        AND (COUNT(*) FILTER (WHERE filled_price > avg_buy_price))::float / COUNT(*) <= 0.25
    `,
      [mode],
    );
    return new Set(rows.map((r: { stock_code: string }) => String(r.stock_code)));
  } catch {
    return new Set();
  }
}
