-- Live/Paper 모두 kr30/us70 통일
-- Live: 0/100 → 30/70 (국내 30% 복원 — 완전 해외 집중은 현금 예약 없이 국내가 선점)
-- Paper: 이미 30/70이지만 혹시 변경됐을 경우 대비
UPDATE portfolio_allocation_config
SET kr_pct = 30, us_pct = 70, updated_at = NOW();
