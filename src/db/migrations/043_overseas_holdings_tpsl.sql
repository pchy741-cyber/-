-- 043_overseas_holdings_tpsl.sql
-- 동적 TP/SL을 매수 시점에 overseas_holdings에 직접 저장
-- → overseas_state 캐시 조회 불필요, 서버 재시작/새로고침에도 유지
-- → UI에서 클릭으로 수동 조절 가능

ALTER TABLE overseas_holdings
  ADD COLUMN IF NOT EXISTS tp_pct NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sl_pct NUMERIC DEFAULT NULL;

COMMENT ON COLUMN overseas_holdings.tp_pct IS '목표 수익률 % (매수 시 동적 계산, 사용자 수동 조절 가능)';
COMMENT ON COLUMN overseas_holdings.sl_pct IS '손절 수익률 % (음수, 매수 시 동적 계산, 사용자 수동 조절 가능)';
