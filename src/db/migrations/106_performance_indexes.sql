-- 106: 성능 최적화 인덱스 (전수조사 결과)

-- 1. score_accuracy: market='US' + is_paper + 시간 범위 (마이크로 피드백, 캘리브레이션)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_score_accuracy_market_paper_date
  ON score_accuracy (market, is_paper, recorded_at DESC);

-- 2. strategy_config: 활성 전략 조회 (매 3분 overseas 사이클마다 호출, 인덱스 완전 누락)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_strategy_config_active
  ON strategy_config (is_active, is_paper, updated_at DESC)
  WHERE is_active = TRUE;

-- 3. orders: overseas BUY 체결 조회 (executor.ts holding days 계산)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_overseas_buy_filled
  ON orders (stock_code, created_at DESC)
  WHERE trigger_source = 'OVERSEAS' AND side = 'BUY' AND status = 'FILLED';

-- 4. overseas_holdings: stock_code + is_paper 복합 (quantity>0 활성 보유)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_overseas_holdings_code_paper
  ON overseas_holdings (stock_code, is_paper)
  WHERE quantity > 0;

-- 5. learned_insights: 대시보드 정렬 최적화 (is_manual DESC, confidence DESC)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_insights_paper_manual_confidence
  ON learned_insights (is_paper, is_manual DESC, confidence DESC)
  WHERE is_dismissed IS NOT TRUE;

-- 6. score_tier_params: market 필터 (KR/US 분리 조회)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_score_tier_params_market
  ON score_tier_params (market, tier_min);

-- 7. 중복 인덱스 정리
DROP INDEX IF EXISTS idx_chains_mode;
DROP INDEX IF EXISTS idx_snapshots_mode;
