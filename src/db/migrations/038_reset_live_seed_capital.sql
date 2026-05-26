-- 038: live seed_capital 리셋
-- 기존 037 마이그레이션 이전 코드에서 is_paper 필터 없이 setSeedCapital을 호출해
-- live 행의 seed_capital이 실제 계좌잔고(~120,000원)로 덮어써졌음.
-- 정상값(1천만원)으로 복원.

UPDATE portfolio_allocation_config
SET seed_capital = 10000000
WHERE is_paper = false
  AND (seed_capital IS NULL OR seed_capital < 1000000);
