-- 포트폴리오 배분: 국내 30% / 해외 70% (기존 70/30 → 30/70)
-- 해외 중심 운용 전략 (국내는 데이트레이딩 30%, 해외 중장기 70%)
UPDATE portfolio_allocation_config
SET kr_pct = 30, us_pct = 70, updated_at = NOW()
WHERE kr_pct = 70 AND us_pct = 30;
