/**
 * 백테스트: AI 스코어 vs 실제 수익률 상관관계
 *
 * 질문: "AI 스코어 높은 종목이 실제로 더 많이 벌었나?"
 *
 * 실행: npx tsx scripts/backtest-score-vs-pnl.ts
 */

import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT ?? 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
      }
);

// ───────────────────────────────────────────────────────────
// 1. 스코어 티어별 수익률 분포
// ───────────────────────────────────────────────────────────
async function scoreTierVsPnl() {
  const { rows } = await pool.query(`
    WITH chain_pnl AS (
      SELECT
        tc.id,
        tc.stock_code,
        tc.opened_at,
        tc.closed_at,
        tc.strategy_mode,
        tc.avg_buy_price,
        tc.realized_pnl,
        tc.total_invested,
        CASE
          WHEN tc.total_invested > 0
          THEN ROUND((tc.realized_pnl / tc.total_invested * 100)::numeric, 2)
          ELSE NULL
        END AS pnl_pct,
        EXTRACT(EPOCH FROM (tc.closed_at - tc.opened_at)) / 86400 AS holding_days
      FROM transaction_chains tc
      WHERE tc.status = 'CLOSED'
        AND tc.closed_at IS NOT NULL
        AND tc.total_invested > 0
        AND tc.avg_buy_price > 0
    ),
    with_score AS (
      SELECT
        cp.*,
        s.composite_score,
        s.fundamental_score,
        s.technical_score,
        s.sentiment_score,
        s.score_date
      FROM chain_pnl cp
      LEFT JOIN LATERAL (
        SELECT composite_score, fundamental_score, technical_score, sentiment_score, score_date
        FROM ai_scores
        WHERE stock_code = cp.stock_code
          AND score_date <= cp.opened_at::date
        ORDER BY score_date DESC
        LIMIT 1
      ) s ON true
      WHERE s.composite_score IS NOT NULL
    )
    SELECT
      CASE
        WHEN composite_score >= 90 THEN '🟢 90+ (최고)'
        WHEN composite_score >= 80 THEN '🟡 80~89'
        WHEN composite_score >= 70 THEN '🟠 70~79'
        ELSE                             '🔴 70 미만'
      END AS score_tier,
      COUNT(*) AS 거래수,
      ROUND(AVG(pnl_pct)::numeric, 2) AS 평균수익률,
      ROUND(MIN(pnl_pct)::numeric, 2) AS 최소수익률,
      ROUND(MAX(pnl_pct)::numeric, 2) AS 최대수익률,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pnl_pct)::numeric, 2) AS 중앙값,
      COUNT(*) FILTER (WHERE pnl_pct > 0) AS 수익거래,
      COUNT(*) FILTER (WHERE pnl_pct <= 0) AS 손실거래,
      ROUND((COUNT(*) FILTER (WHERE pnl_pct > 0)::numeric / COUNT(*) * 100)::numeric, 1) AS 승률,
      ROUND(AVG(holding_days)::numeric, 1) AS 평균보유일
    FROM with_score
    GROUP BY score_tier
    ORDER BY MIN(composite_score) DESC
  `);
  return rows;
}

// ───────────────────────────────────────────────────────────
// 2. 상위 스코어 종목별 실적 (종목별 상세)
// ───────────────────────────────────────────────────────────
async function topScoreStockDetail() {
  const { rows } = await pool.query(`
    WITH chain_pnl AS (
      SELECT
        tc.stock_code,
        tc.realized_pnl,
        tc.total_invested,
        tc.opened_at,
        CASE WHEN tc.total_invested > 0
          THEN ROUND((tc.realized_pnl / tc.total_invested * 100)::numeric, 2)
          ELSE NULL END AS pnl_pct
      FROM transaction_chains tc
      WHERE tc.status = 'CLOSED' AND tc.total_invested > 0
    ),
    with_score AS (
      SELECT
        cp.*,
        s.composite_score,
        w.stock_name
      FROM chain_pnl cp
      JOIN watchlist w ON cp.stock_code = w.stock_code
      LEFT JOIN LATERAL (
        SELECT composite_score
        FROM ai_scores
        WHERE stock_code = cp.stock_code
          AND score_date <= cp.opened_at::date
        ORDER BY score_date DESC
        LIMIT 1
      ) s ON true
      WHERE s.composite_score >= 80
    )
    SELECT
      stock_code,
      stock_name,
      ROUND(AVG(composite_score)::numeric, 1) AS avg_score,
      COUNT(*) AS 거래수,
      ROUND(AVG(pnl_pct)::numeric, 2) AS 평균수익률,
      COUNT(*) FILTER (WHERE pnl_pct > 0)::float / COUNT(*) * 100 AS 승률,
      ROUND(SUM(realized_pnl)::numeric, 0) AS 누적손익원
    FROM with_score
    GROUP BY stock_code, stock_name
    HAVING COUNT(*) >= 2
    ORDER BY 평균수익률 DESC
    LIMIT 20
  `);
  return rows;
}

// ───────────────────────────────────────────────────────────
// 3. 스코어 분포 현황 (스코어 자체가 어떻게 분포되어 있나)
// ───────────────────────────────────────────────────────────
async function scoreDistribution() {
  const { rows } = await pool.query(`
    SELECT
      ROUND(composite_score / 10) * 10 AS score_band,
      COUNT(*) AS 스코어수,
      COUNT(DISTINCT stock_code) AS 종목수
    FROM ai_scores
    WHERE composite_score IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'
    GROUP BY score_band
    ORDER BY score_band DESC
  `);
  return rows;
}

// ───────────────────────────────────────────────────────────
// 4. 전략 모드별 수익률
// ───────────────────────────────────────────────────────────
async function strategyModeVsPnl() {
  const { rows } = await pool.query(`
    SELECT
      strategy_mode AS 전략모드,
      COUNT(*) AS 거래수,
      ROUND(AVG(
        CASE WHEN total_invested > 0
          THEN realized_pnl / total_invested * 100
          ELSE NULL END
      )::numeric, 2) AS 평균수익률,
      ROUND(SUM(realized_pnl)::numeric, 0) AS 누적손익원,
      COUNT(*) FILTER (WHERE realized_pnl > 0) AS 수익,
      COUNT(*) FILTER (WHERE realized_pnl <= 0) AS 손실
    FROM transaction_chains
    WHERE status = 'CLOSED' AND total_invested > 0
    GROUP BY strategy_mode
    ORDER BY 누적손익원 DESC
  `);
  return rows;
}

// ───────────────────────────────────────────────────────────
// 5. 최근 30일 실현 손익 요약
// ───────────────────────────────────────────────────────────
async function recentSummary() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS 총거래수,
      ROUND(SUM(realized_pnl)::numeric, 0) AS 총실현손익,
      ROUND(AVG(
        CASE WHEN total_invested > 0
          THEN realized_pnl / total_invested * 100
          ELSE NULL END
      )::numeric, 2) AS 평균수익률,
      COUNT(*) FILTER (WHERE realized_pnl > 0) AS 수익거래,
      COUNT(*) FILTER (WHERE realized_pnl <= 0) AS 손실거래
    FROM transaction_chains
    WHERE status = 'CLOSED'
      AND closed_at >= NOW() - INTERVAL '30 days'
      AND total_invested > 0
  `);
  return rows[0];
}

// ───────────────────────────────────────────────────────────
// 메인
// ───────────────────────────────────────────────────────────
async function main() {
  console.log('\n========================================');
  console.log('  QUANTOPS 백테스트 — AI 스코어 vs 수익률');
  console.log('========================================\n');

  try {
    // 최근 요약
    const recent = await recentSummary();
    console.log('📊 최근 30일 실현 손익 요약');
    console.log('─'.repeat(40));
    console.log(`  총 거래: ${recent.총거래수}건`);
    console.log(`  총 실현손익: ${Number(recent.총실현손익).toLocaleString()}원`);
    console.log(`  평균 수익률: ${recent.평균수익률}%`);
    console.log(`  승률: ${recent.수익거래}승 ${recent.손실거래}패`);
    console.log();

    // 스코어 분포
    const dist = await scoreDistribution();
    console.log('📈 최근 90일 AI 스코어 분포');
    console.log('─'.repeat(40));
    for (const r of dist) {
      const bar = '█'.repeat(Math.min(Math.round(Number(r.스코어수) / 2), 30));
      console.log(`  ${String(r.score_band).padStart(3)}점대: ${bar} ${r.스코어수}건 (${r.종목수}종목)`);
    }
    console.log();

    // 스코어 티어별 수익률
    const tiers = await scoreTierVsPnl();
    console.log('🎯 스코어 티어별 수익률 (핵심 질문)');
    console.log('─'.repeat(70));
    console.log(
      '티어'.padEnd(18) +
      '거래수'.padStart(6) +
      '평균수익률'.padStart(10) +
      '중앙값'.padStart(8) +
      '최소'.padStart(8) +
      '최대'.padStart(8) +
      '승률'.padStart(8) +
      '보유일'.padStart(8)
    );
    console.log('─'.repeat(70));
    for (const r of tiers) {
      console.log(
        String(r.score_tier).padEnd(18) +
        String(r.거래수).padStart(6) +
        `${r.평균수익률}%`.padStart(10) +
        `${r.중앙값}%`.padStart(8) +
        `${r.최소수익률}%`.padStart(8) +
        `${r.최대수익률}%`.padStart(8) +
        `${r.승률}%`.padStart(8) +
        `${r.평균보유일}일`.padStart(8)
      );
    }
    console.log();

    // 전략 모드별
    const modes = await strategyModeVsPnl();
    console.log('⚙️ 전략 모드별 수익률');
    console.log('─'.repeat(50));
    for (const r of modes) {
      console.log(
        `  ${String(r.전략모드).padEnd(12)} | ${String(r.거래수).padStart(4)}건 | 평균 ${String(r.평균수익률).padStart(6)}% | 누적 ${Number(r.누적손익원).toLocaleString().padStart(12)}원 | ${r.수익}승 ${r.손실}패`
      );
    }
    console.log();

    // 종목별 상세 (스코어 80+)
    const stocks = await topScoreStockDetail();
    if (stocks.length > 0) {
      console.log('🏆 스코어 80+ 종목별 실적');
      console.log('─'.repeat(60));
      for (const r of stocks) {
        const winRate = Math.round(Number(r.승률));
        console.log(
          `  ${String(r.stock_name || r.stock_code).padEnd(14)} | 스코어 ${String(r.avg_score).padStart(4)} | ${String(r.거래수).padStart(3)}건 | 평균 ${String(r.평균수익률).padStart(6)}% | 승률 ${winRate}% | 누적 ${Number(r.누적손익원).toLocaleString()}원`
        );
      }
    } else {
      console.log('ℹ️ 스코어 80+ 종목 중 2건 이상 거래된 종목 없음 (데이터 부족)');
    }

    console.log('\n========================================');
    console.log('  분석 완료');
    console.log('========================================\n');

  } catch (err: any) {
    console.error('❌ 오류:', err.message);
    if (err.message.includes('connect')) {
      console.error('  → DATABASE_URL 환경변수 확인 필요');
      console.error('  → .env 파일에 DATABASE_URL이 설정되어 있는지 확인하세요');
    }
  } finally {
    await pool.end();
  }
}

main();
