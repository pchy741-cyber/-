-- 092: dividend_history 스키마 수정
-- C1: is_paper 컬럼 추가 (paper/live 배당 데이터 분리)
-- C2: unique 제약조건 추가 (ON CONFLICT DO NOTHING이 작동하도록)

-- is_paper 컬럼 추가
ALTER TABLE dividend_history ADD COLUMN IF NOT EXISTS is_paper BOOLEAN DEFAULT TRUE;

-- currency 컬럼 추가 (코드에서 참조하나 DDL에 없었음)
ALTER TABLE dividend_history ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';

-- 중복 방지용 unique 제약조건
-- (stock_code, pay_date, is_paper) 조합으로 같은 날 같은 종목 중복 수령 방지
CREATE UNIQUE INDEX IF NOT EXISTS uq_dividend_history_code_date_paper
  ON dividend_history (stock_code, pay_date, is_paper)
  WHERE pay_date IS NOT NULL;
