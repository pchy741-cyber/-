-- 042: score_accuracy에 is_paper 컬럼 추가
-- overseas/executor.ts가 INSERT 시 is_paper를 사용하지만 스키마에 없어 쿼리 실패
-- 기존 KR 기록은 is_paper=false(live)로 유지

ALTER TABLE score_accuracy
  ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;
