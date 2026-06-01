-- 050: 동일 종목 중복 OPEN 체인 방지 유니크 인덱스
-- 문제: transaction_chains에 (stock_code, is_paper) OPEN 유니크 제약 없어
--       findOpenChain 체크 → createChain 사이 타임윈도우에서 중복 INSERT 가능
-- 해결: 부분 유니크 인덱스 — OPEN/AVERAGING/PROFIT_TAKING 상태에서만 종목+모드 유일 보장

-- 기존 중복 체인 확인 (있으면 오래된 것 자동 CLOSED 처리)
UPDATE transaction_chains
SET status = 'CLOSED',
    close_reason = 'dedup-migration-050: 중복 OPEN 체인 정리',
    closed_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY stock_code, is_paper
             ORDER BY opened_at DESC  -- 가장 최근 것만 유지
           ) AS rn
    FROM transaction_chains
    WHERE status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING')
  ) ranked
  WHERE rn > 1
);

-- 부분 유니크 인덱스: OPEN 상태 종목+모드 조합은 1개만 허용
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_open_chain_per_stock
  ON transaction_chains(stock_code, is_paper)
  WHERE status IN ('OPEN', 'AVERAGING', 'PROFIT_TAKING');
