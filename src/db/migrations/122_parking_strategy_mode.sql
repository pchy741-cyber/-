-- v27: PARKING 전략 모드 추가
-- transaction_chains, strategy_config 등에서 strategy_mode = 'PARKING' 허용

-- 기존 CHECK 제약조건에 PARKING 추가 (109에서 생성된 제약조건 업데이트)
-- NOTE: PostgreSQL은 ALTER CONSTRAINT 미지원이므로 DROP + ADD

-- transaction_chains
ALTER TABLE transaction_chains DROP CONSTRAINT IF EXISTS chk_chains_strategy_mode;
ALTER TABLE transaction_chains ADD CONSTRAINT chk_chains_strategy_mode
  CHECK (strategy_mode IN ('SWING','DEFENSE','SCALPING','DIVIDEND','SNIPER','BOTTOM_FISHING','EOD_BETTING','BREAKOUT','PARKING','PULLBACK'));

-- strategy_config
ALTER TABLE strategy_config DROP CONSTRAINT IF EXISTS chk_config_mode;
ALTER TABLE strategy_config ADD CONSTRAINT chk_config_mode
  CHECK (mode IN ('SWING','DEFENSE','SCALPING','DIVIDEND','SNIPER','BOTTOM_FISHING','EOD_BETTING','BREAKOUT','PARKING','PULLBACK'));

-- score_accuracy
ALTER TABLE score_accuracy DROP CONSTRAINT IF EXISTS chk_sa_strategy_mode;
