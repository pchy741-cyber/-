-- Migration 024: 체인 is_paper 교정 (실전 모드 강제는 제거됨)
-- KIS 실주문번호가 있는 체인은 실전으로 교정 (paper 모드로 잘못 태깅된 체인 복구)
--
-- ⚠️ [1] 삭제됨: trading_mode_override = 'live' 강제 설정은
-- 재배포 시 의도치 않은 실전 전환 사고를 유발할 수 있어 제거
-- 거래 모드는 대시보드 UI 또는 settings API로만 전환해야 합니다

-- [2] kis_order_no가 있는 체인 → 실전 체인 (가장 신뢰할 수 있는 기준)
-- VTS(모의투자)는 실제 KIS 주문번호를 발급하지 않음
UPDATE transaction_chains
SET is_paper = false
WHERE is_paper = true
  AND EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = transaction_chains.id
      AND kis_order_no IS NOT NULL
      AND kis_order_no != ''
  );

-- [3] kis_order_no 없고 paper 주문만 있는 OPEN 체인 → 연습 체인 유지 (is_paper=true 유지)
-- 이미 기본값이므로 별도 UPDATE 불필요

-- [4] 현재 OPEN 상태 체인 중 실전 주문(trading_mode='live')이 있으나
-- kis_order_no가 없는 경우도 실전으로 교정 (2차 안전망)
UPDATE transaction_chains
SET is_paper = false
WHERE is_paper = true
  AND status != 'CLOSED'
  AND EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = transaction_chains.id
      AND trading_mode = 'live'
  );
