-- 041_dynamic_tpsl.sql
-- strategy_config에 use_dynamic_tpsl 플래그 추가
-- OFF(기본): 기존 고정 take_profit_pct/stop_loss_pct 사용
-- ON: score + RSI/거래량/눌림 기반 자동 계산, 고정값 무시

ALTER TABLE strategy_config
  ADD COLUMN IF NOT EXISTS use_dynamic_tpsl BOOLEAN NOT NULL DEFAULT false;
