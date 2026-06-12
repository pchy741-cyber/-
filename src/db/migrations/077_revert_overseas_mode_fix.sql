-- 077: 076 롤백 — MANUAL_* 주문은 kis-sync가 KIS 실계좌 동기화로 생성한 실전 내역
-- MANUAL_*는 KIS 보유량↔DB 차이 조정용 → 실전(live) 내역이 맞음
-- 단, USP*/VSP* 주문은 진짜 paper 루프 주문이므로 paper 유지

-- MANUAL_* 주문 → live로 복원
UPDATE orders
SET trading_mode = 'live'
WHERE trigger_source = 'OVERSEAS'
  AND trading_mode = 'paper'
  AND kis_order_no LIKE 'MANUAL_%';

-- USP*/VSP*/CLN* 주문은 paper 유지 (이미 맞음)
-- 추가: 빈 주문번호도 paper 유지 (안전)
