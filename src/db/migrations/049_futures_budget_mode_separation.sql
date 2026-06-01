-- 049: futures_budget paper/live 모드 분리
-- 기존 단일행 공유 → 모드별 독립 예산/PnL 관리
-- 크로스 오염 근본 해결

-- paper/live 분리 컬럼 추가
ALTER TABLE futures_budget ADD COLUMN IF NOT EXISTS allocated_krw_paper NUMERIC DEFAULT 0;
ALTER TABLE futures_budget ADD COLUMN IF NOT EXISTS allocated_krw_live NUMERIC DEFAULT 0;
ALTER TABLE futures_budget ADD COLUMN IF NOT EXISTS total_pnl_usd_paper NUMERIC DEFAULT 0;
ALTER TABLE futures_budget ADD COLUMN IF NOT EXISTS total_pnl_usd_live NUMERIC DEFAULT 0;
ALTER TABLE futures_budget ADD COLUMN IF NOT EXISTS used_margin_usd_paper NUMERIC DEFAULT 0;
ALTER TABLE futures_budget ADD COLUMN IF NOT EXISTS used_margin_usd_live NUMERIC DEFAULT 0;

-- 기존 데이터 → paper로 이관 (안전하게)
UPDATE futures_budget
SET allocated_krw_paper = COALESCE(allocated_krw, 0),
    total_pnl_usd_paper = COALESCE(total_pnl_usd, 0),
    used_margin_usd_paper = COALESCE(used_margin_usd, 0)
WHERE id = 1
  AND allocated_krw_paper = 0
  AND total_pnl_usd_paper = 0;

-- live는 0에서 시작 (오염된 금액 제거)
UPDATE futures_budget
SET allocated_krw_live = 0,
    total_pnl_usd_live = 0,
    used_margin_usd_live = 0
WHERE id = 1;
