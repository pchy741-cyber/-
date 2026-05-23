-- 029_orders_avg_buy_price.sql
-- 해외 매도 주문에 평균 매수가 컬럼 추가
-- 기존: ai_reasoning 문자열에서 [avgBuy:123.45] 파싱 → 불안정
-- 개선: avg_buy_price 컬럼에 직접 저장, 파싱은 폴백

ALTER TABLE orders ADD COLUMN IF NOT EXISTS avg_buy_price NUMERIC;

-- 기존 데이터 마이그레이션: ai_reasoning에서 avgBuy 추출하여 컬럼에 저장
UPDATE orders
SET avg_buy_price = (regexp_match(ai_reasoning, '\[avgBuy:([0-9]+\.?[0-9]*)\]'))[1]::numeric
WHERE avg_buy_price IS NULL
  AND side = 'SELL'
  AND trigger_source = 'OVERSEAS'
  AND ai_reasoning ~ '\[avgBuy:[0-9]';
