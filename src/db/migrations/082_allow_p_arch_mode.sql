-- 082_allow_p_arch_mode.sql
-- CHECK 제약조건에 'p_arch' 추가 — Paper 아카이브 모드
-- state.ts에서 Paper 리필/시드전환 시 기존 주문을 'p_arch'로 아카이브하지만
-- 027_mode_constraints.sql의 CHECK가 paper/live만 허용하여 실패

DO $$
BEGIN
  -- 기존 CHECK 제거
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_trading_mode'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT chk_orders_trading_mode;
  END IF;

  -- 'p_arch' 포함하여 재생성
  ALTER TABLE orders ADD CONSTRAINT chk_orders_trading_mode
    CHECK (trading_mode IN ('paper', 'live', 'p_arch'));
END $$;
