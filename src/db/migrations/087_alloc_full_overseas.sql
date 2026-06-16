-- 087: 해외주식 100% 배분 — 국내 비중 0%
-- 사용자 요청: 100% 원화→달러 전환, 해외주식 실전모드 전용 운용
UPDATE portfolio_allocation_config
SET kr_pct = 0, us_pct = 100, updated_at = NOW()
WHERE is_paper = false AND kr_pct > 0;
