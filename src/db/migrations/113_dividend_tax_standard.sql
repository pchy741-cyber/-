-- 배당 과세표준율 컬럼 추가
-- 1.0 = 100% 과세 (US ETF 기본값)
ALTER TABLE dividend_watchlist
  ADD COLUMN IF NOT EXISTS tax_standard_rate NUMERIC(5,4) DEFAULT 1.0;
