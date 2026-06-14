-- Paper 포트폴리오 초기화 (레거시 — 이미 실행 완료)
-- 현재 시드: PAPER_INITIAL_CAPITAL(국내) + PAPER_OVERSEAS_SEED_KRW(해외) 각 env 또는 기본값 사용
-- 기존 paper 주문 내역이 이전 시드 기준으로 누적돼 있어 현금 계산 정합성 확보 목적

-- 1. Paper 해외 포지션 초기화
DELETE FROM overseas_holdings WHERE is_paper = true;

-- 2. Paper 해외 현금 초기화 (cash_paper 를 0으로 — state.ts가 다음 틱에 seedUsd로 재계산)
UPDATE overseas_state
SET value = '0'
WHERE key = 'cash_paper';

-- 3. Paper 국내 주문 내역 초기화 (FIFO 원장 기준 리셋)
--    주의: trading_mode='paper' 인 orders만 삭제 (live 주문 보존)
DELETE FROM orders
WHERE trading_mode = 'paper';

-- 4. Paper 국내 포지션 초기화 (혹시 남아 있을 경우)
DELETE FROM positions
WHERE trading_mode = 'paper';

-- 결과: 다음 실행 시 paper 시드 = env 기반 동적 값 사용
