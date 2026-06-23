-- 해외주식 물타기(평균단가 하향) 지원
-- averaging_count: 현재 물타기 횟수 (최대 2회)
-- initial_avg_price: 최초 매수 평균가 (물타기 효과 측정용)
ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS averaging_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS initial_avg_price NUMERIC DEFAULT 0;

-- 초기값: 이미 보유 중인 종목은 initial_avg_price = avg_price
UPDATE overseas_holdings SET initial_avg_price = avg_price WHERE initial_avg_price = 0 AND avg_price > 0;
