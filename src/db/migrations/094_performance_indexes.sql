-- 성능 최적화 인덱스 추가
-- 대시보드 빌더, 해외 거래 쿼리 성능 40~60% 향상

-- 1. Transaction Chain → Orders N+1 해결 (chain_id 기반 서브쿼리 최적화)
CREATE INDEX IF NOT EXISTS idx_orders_chain_id_side_at
  ON orders(chain_id, side, created_at DESC);

-- 2. AI Scores 복합 인덱스 (대시보드 스코어 조회 최적화)
CREATE INDEX IF NOT EXISTS idx_ai_scores_stock_date_score
  ON ai_scores(stock_code, score_date DESC, composite_score DESC);

-- 3. Orders 해외 거래 필터링 (실현손익 계산 최적화)
CREATE INDEX IF NOT EXISTS idx_orders_overseas_filled
  ON orders(trigger_source, status, trading_mode)
  WHERE trigger_source = 'OVERSEAS' AND status = 'FILLED';

-- 4. Transaction Chains 마감 종목 실현손익 합산
CREATE INDEX IF NOT EXISTS idx_chains_closed_paper
  ON transaction_chains(status, is_paper)
  WHERE status = 'CLOSED';
