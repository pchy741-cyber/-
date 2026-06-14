-- 038: live seed_capital 리셋 (레거시)
-- 이 마이그레이션은 1회 실행됨. 이후 seed_capital은 KIS API 순자산에서 자동 동기화.
-- 이전: 코드에서 setSeedCapital 잘못 호출 → 실잔고로 덮어쓰기 버그 수정용이었음.

UPDATE portfolio_allocation_config
SET seed_capital = GREATEST(seed_capital, 1000000)
WHERE is_paper = false
  AND (seed_capital IS NULL OR seed_capital < 1000000);
