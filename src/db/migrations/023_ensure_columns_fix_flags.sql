-- Migration 023: 누락 컬럼 보장 + is_paper 교정 재실행
-- 이전 마이그레이션 롤백으로 적용이 누락됐을 수 있는 컬럼을 안전하게 보장하고,
-- 실전(live) 주문이 연결된 체인의 is_paper 플래그를 교정한다.

-- [1] portfolio_allocation_config: trading_mode_override 컬럼 보장
ALTER TABLE portfolio_allocation_config ADD COLUMN IF NOT EXISTS trading_mode_override VARCHAR(10);

-- [2] transaction_chains: is_paper 컬럼 보장
ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT true;

-- [3] portfolio_snapshots: is_paper 컬럼 보장
ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;

-- [4] 인덱스 보장
CREATE INDEX IF NOT EXISTS idx_chains_mode ON transaction_chains(is_paper, status);
CREATE INDEX IF NOT EXISTS idx_snapshots_mode ON portfolio_snapshots(is_paper, snapshot_at);

-- [5] 실전 주문이 있는 체인 → is_paper=false 교정
-- (서버가 paper 모드일 때 생성됐더라도 live 주문이 FILLED이면 실전 체인)
UPDATE transaction_chains tc
SET is_paper = false
WHERE tc.is_paper = true
  AND EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = tc.id AND trading_mode = 'live' AND status = 'FILLED'
  );

-- [6] 모의 주문만 있는 체인 → is_paper=true 교정
UPDATE transaction_chains tc
SET is_paper = true
WHERE tc.is_paper = false
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = tc.id AND trading_mode = 'live' AND status = 'FILLED'
  )
  AND EXISTS (
    SELECT 1 FROM orders
    WHERE chain_id = tc.id AND trading_mode = 'paper' AND status = 'FILLED'
  );
