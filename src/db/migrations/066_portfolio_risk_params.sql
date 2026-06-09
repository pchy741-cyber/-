-- 포트폴리오 리스크 파라미터를 DB로 이관
-- 실전(live)과 연습(paper) 모드의 리스크 파라미터를 독립적으로 설정 가능하게 함
-- 기존: config.paperRisk + 하드코딩 0.25 → DB 기반으로 전환

ALTER TABLE portfolio_allocation_config
  ADD COLUMN IF NOT EXISTS position_cap_pct NUMERIC(5,2) DEFAULT 25,
  ADD COLUMN IF NOT EXISTS max_invested_pct NUMERIC(5,2) DEFAULT 88,
  ADD COLUMN IF NOT EXISTS cash_reserve_pct NUMERIC(5,2) DEFAULT 20,
  ADD COLUMN IF NOT EXISTS max_positions INT DEFAULT 8,
  ADD COLUMN IF NOT EXISTS max_daily_trades INT DEFAULT 3;

-- 연습모드 행에 연습모드 기본값 적용 (실전 기본값으로 채워진 것을 덮어씀)
UPDATE portfolio_allocation_config
SET
  position_cap_pct = 40,
  max_invested_pct = 97,
  cash_reserve_pct = 3,
  max_positions = 20,
  max_daily_trades = 20
WHERE is_paper = true;

-- 연습 모드 행이 없으면 삽입
INSERT INTO portfolio_allocation_config
  (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc,
   trailing_stop_pct, is_paper, position_cap_pct, max_invested_pct, cash_reserve_pct, max_positions, max_daily_trades)
SELECT 70, 30, 30, 20, 25, 20, 30, 5, true, 40, 97, 3, 20, 20
WHERE NOT EXISTS (SELECT 1 FROM portfolio_allocation_config WHERE is_paper = true);

-- 실전 모드 행이 없으면 삽입
INSERT INTO portfolio_allocation_config
  (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc,
   trailing_stop_pct, is_paper, position_cap_pct, max_invested_pct, cash_reserve_pct, max_positions, max_daily_trades)
SELECT 30, 70, 30, 20, 25, 20, 30, 5, false, 25, 88, 20, 8, 3
WHERE NOT EXISTS (SELECT 1 FROM portfolio_allocation_config WHERE is_paper = false);
