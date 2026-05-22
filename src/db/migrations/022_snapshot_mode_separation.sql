-- Migration 022: portfolio_snapshots에 is_paper 컬럼 추가
-- paper/live 스냅샷 혼용으로 MDD가 잘못 계산되던 버그 수정
-- 증상: 연습모드 32만원 손실이 "고점 대비 -98.5%"로 오인 → Kill Switch 오발동

ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;

-- 기존 스냅샷은 모두 live로 처리 (paper 기능이 나중에 추가됐으므로)
-- 새 스냅샷부터 config.isPaper 값을 정확히 기록

CREATE INDEX IF NOT EXISTS idx_snapshots_mode ON portfolio_snapshots(is_paper, snapshot_at);
