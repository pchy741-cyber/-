-- 081_chains_pnl_pct_sell_reason.sql
-- transaction_chains에 pnl_pct, sell_reason 컬럼 추가
-- 코드(client.ts, auto-pilot.ts, profit-guards.ts)에서 이미 참조하지만 마이그레이션 누락

-- 1) pnl_pct: 실현 손익률 (%) — 체결 시 계산, 종목별 연속 손실·승률 등에 사용
ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS pnl_pct DECIMAL(8,4);

-- 2) sell_reason: 매도 사유 (close_reason과 별도 — 구조화된 매도 분류 코드)
ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS sell_reason VARCHAR(50);

-- 3) 기존 CLOSED 체인의 pnl_pct 백필 (total_invested > 0인 경우만)
UPDATE transaction_chains
SET pnl_pct = CASE
  WHEN total_invested > 0 THEN (realized_pnl / total_invested) * 100
  ELSE 0
END
WHERE status = 'CLOSED' AND pnl_pct IS NULL AND total_invested > 0;
