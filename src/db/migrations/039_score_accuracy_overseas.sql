-- score_accuracy: 해외주식 SELL 기록 지원 (chain_id 없이 order_id 기반 dedup)
ALTER TABLE score_accuracy ADD COLUMN IF NOT EXISTS order_id UUID;
ALTER TABLE score_accuracy ADD COLUMN IF NOT EXISTS market VARCHAR(2) DEFAULT 'KR';

-- 해외 주문별 중복 방지 인덱스
CREATE UNIQUE INDEX IF NOT EXISTS uix_score_accuracy_order_id
  ON score_accuracy(order_id) WHERE order_id IS NOT NULL;
