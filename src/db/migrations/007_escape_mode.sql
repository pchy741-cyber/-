-- 탈출 모드: 현재 마이너스 종목을 +0.5% 돌파 순간 자동 매도
-- escape_target_price 가 NULL 이 아닌 체인 = 탈출 대기 중
ALTER TABLE transaction_chains
  ADD COLUMN IF NOT EXISTS escape_target_price NUMERIC(18,4) DEFAULT NULL;

COMMENT ON COLUMN transaction_chains.escape_target_price
  IS '탈출 목표가: 현재가가 이 금액 이상이 되면 즉시 전량 매도. NULL = 탈출 모드 아님';
