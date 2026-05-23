-- 027_mode_constraints.sql
-- DB 레벨 모드 안전장치: CHECK 제약조건 + 인덱스
-- 연습/실전 데이터 오염을 DB 수준에서 원천 차단

-- ============================================================
-- Phase 1: 데이터 정합성 선 정리 (CHECK 추가 전 잘못된 값 제거)
-- ============================================================

-- trading_mode에 NULL 또는 잘못된 값이 있으면 체인 기준으로 교정
UPDATE orders o SET trading_mode = CASE WHEN tc.is_paper THEN 'paper' ELSE 'live' END
FROM transaction_chains tc
WHERE o.chain_id = tc.id
  AND o.trading_mode NOT IN ('paper', 'live');

-- chain_id 없는 주문 (해외 등) 중 잘못된 값은 'paper' 안전 기본값
UPDATE orders SET trading_mode = 'paper'
WHERE trading_mode NOT IN ('paper', 'live')
  AND chain_id IS NULL;

-- ============================================================
-- Phase 2: CHECK 제약조건 (잘못된 값 INSERT 원천 차단)
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_trading_mode'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT chk_orders_trading_mode
      CHECK (trading_mode IN ('paper', 'live'));
  END IF;
END $$;

-- ============================================================
-- Phase 3: 모드 필터 성능 인덱스
-- ============================================================

-- orders: trading_mode + status 복합 인덱스 (가장 빈번한 쿼리 패턴)
CREATE INDEX IF NOT EXISTS idx_orders_trading_mode
  ON orders(trading_mode, status, created_at DESC);

-- orders: 해외 PENDING 조회 최적화
CREATE INDEX IF NOT EXISTS idx_orders_overseas_pending
  ON orders(trigger_source, trading_mode, status)
  WHERE trigger_source = 'OVERSEAS' AND status = 'PENDING';
