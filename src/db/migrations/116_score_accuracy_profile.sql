-- v23-audit: PAPER_SHADOW 프로파일 구분
-- Paper 모드는 Live와 다른 파라미터(threshold -30, 투자율 97% 등)로 운영
-- → Paper 데이터는 Live 검증에 부적합. 'EXPLORE' 태깅하여 교정에서 제외.

-- 1) trading_profile 컬럼 추가
ALTER TABLE score_accuracy
  ADD COLUMN IF NOT EXISTS trading_profile VARCHAR(10) DEFAULT 'LIVE';

-- 2) 기존 paper 데이터 전부 EXPLORE 태깅 (어느 프로파일이었는지 구분 불가 → 보수적)
UPDATE score_accuracy
SET trading_profile = 'EXPLORE'
WHERE is_paper = true AND trading_profile = 'LIVE';

-- 3) Live 데이터는 'LIVE' 유지 (DEFAULT)
-- 향후 PAPER_SHADOW 모드 추가 시 'SHADOW' 태깅
