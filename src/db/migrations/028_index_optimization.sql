-- 028_index_optimization.sql
-- 쿼리 패턴 기반 인덱스 최적화
-- 실제 코드 89개 쿼리 분석 → 누락/중복 인덱스 정리

-- ============================================================
-- Phase 1: 중복 인덱스 제거
-- ============================================================

-- idx_orders_status (001) 와 idx_orders_status_created (004) 완전 중복
-- 둘 다 (status, created_at DESC) 동일 구성
DROP INDEX IF EXISTS idx_orders_status;

-- idx_orders_chain (chain_id) → idx_orders_chain_side (chain_id, side, created_at) 로 대체
DROP INDEX IF EXISTS idx_orders_chain;

-- ============================================================
-- Phase 2: 고영향 인덱스 (10+ 쿼리 영향)
-- ============================================================

-- CLOSED 체인 시간범위 조회 — 분석/리포트/게이트/저널/사이저 등
-- 패턴: WHERE status='CLOSED' AND is_paper=$1 AND closed_at >= $2
CREATE INDEX IF NOT EXISTS idx_chains_closed_range
  ON transaction_chains (is_paper, closed_at DESC)
  WHERE status = 'CLOSED';

-- chain별 주문 조회 (side 포함) — 물타기/익절/저널 서브쿼리
-- 패턴: WHERE chain_id=$1 AND side='SELL' ORDER BY created_at DESC
-- 기존 idx_orders_chain (chain_id만) 대체
CREATE INDEX IF NOT EXISTS idx_orders_chain_side
  ON orders (chain_id, side, created_at DESC);

-- ============================================================
-- Phase 3: 해외매매 최적화 (5+ 쿼리)
-- ============================================================

-- 해외 매도 실적 조회 — 저널/승률/성과분석
-- 패턴: WHERE side='SELL' AND status='FILLED' AND trigger_source='OVERSEAS'
CREATE INDEX IF NOT EXISTS idx_orders_overseas_sell_filled
  ON orders (stock_code, created_at DESC)
  WHERE side = 'SELL' AND status = 'FILLED' AND trigger_source = 'OVERSEAS';

-- ============================================================
-- Phase 4: AI 스코어 역조회
-- ============================================================

-- 체인 종료 시 진입 당시 스코어 연결
-- 패턴: WHERE stock_code=$1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_ai_scores_stock_created
  ON ai_scores (stock_code, created_at DESC);

-- ============================================================
-- Phase 5: 종목별 최근 CLOSED 체인 (대시보드 매도수익률)
-- ============================================================

-- 패턴: WHERE status='CLOSED' AND stock_code=ANY($1) ORDER BY closed_at DESC
CREATE INDEX IF NOT EXISTS idx_chains_stock_closed
  ON transaction_chains (stock_code, closed_at DESC)
  WHERE status = 'CLOSED';
