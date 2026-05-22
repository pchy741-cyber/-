-- Migration 024: 실전 모드 강제 설정 + 체인 is_paper 교정
-- 서버 부팅 시 항상 실전 모드로 시작하도록 DB 강제 설정,
-- KIS 실주문번호가 있는 체인은 실전으로 교정 (paper 모드로 잘못 태깅된 체인 복구)

-- [1] portfolio_allocation_config 전체를 실전 모드로 강제 설정
-- 부팅 시 ORDER BY id DESC LIMIT 1 로 읽으므로 모든 행을 live로 통일
UPDATE portfolio_allocation_config
SET trading_mode_override = 'live';

-- 행이 없으면 live 기본값으로 삽입
INSERT INTO portfolio_allocation_config (trading_mode_override)
SELECT 'live'
WHERE NOT EXISTS (SELECT 1 FROM portfolio_allocation_config);

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
