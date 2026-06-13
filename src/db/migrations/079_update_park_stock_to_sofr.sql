-- 파킹 ETF를 KODEX 200 (069500) → KODEX 미국달러SOFR금리액티브 (449170)로 변경
-- 사유: KODEX 200은 주식시장 연동이라 하락장 파킹에 부적합
--       SOFR ETF는 달러+단기금리 수익으로 주식시장과 무상관

-- 기존 활성 파킹 레코드의 종목코드 업데이트
UPDATE defense_park_state
SET park_stock_code = '449170',
    park_stock_name = 'KODEX 미국달러SOFR금리액티브'
WHERE park_stock_code = '069500';

-- 기본값 변경 (새 레코드용)
ALTER TABLE defense_park_state
  ALTER COLUMN park_stock_code SET DEFAULT '449170';
