-- v22-audit: score_accuracy outcome을 net 기준으로 재라벨링
-- US: 왕복 0.70% (편도 0.35%×2) → gross 0.4~0.75% 구간은 BREAK_EVEN으로 재분류
-- KR: 왕복 0.21% → 기존 0.25% threshold 유지 (이미 net 양수 보장)

-- US: gross 0.4~0.75% WIN → BREAK_EVEN (실제 net 음수였던 거래)
UPDATE score_accuracy
SET outcome = 'BREAK_EVEN'
WHERE market = 'US'
  AND outcome = 'WIN'
  AND realized_pnl_pct > 0.4
  AND realized_pnl_pct <= 0.75;

-- US: gross -0.75~-0.4% LOSS → BREAK_EVEN (대칭 보정)
UPDATE score_accuracy
SET outcome = 'BREAK_EVEN'
WHERE market = 'US'
  AND outcome = 'LOSS'
  AND realized_pnl_pct < -0.4
  AND realized_pnl_pct >= -0.75;
