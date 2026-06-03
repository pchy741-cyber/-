-- 053: score_accuracy에 진입 조건 핑거프린트 추가
-- 기술지표 조합별 승률 피드백 루프의 핵심 데이터

ALTER TABLE score_accuracy ADD COLUMN IF NOT EXISTS entry_fingerprint TEXT;

-- 핑거프린트 기반 패턴 조회용 인덱스
CREATE INDEX IF NOT EXISTS idx_score_accuracy_fingerprint
  ON score_accuracy(entry_fingerprint)
  WHERE entry_fingerprint IS NOT NULL;

-- 유사 패턴 매칭용 (rsiZone|%|trendState|%) LIKE 쿼리 지원
CREATE INDEX IF NOT EXISTS idx_score_accuracy_fingerprint_text
  ON score_accuracy USING btree (entry_fingerprint text_pattern_ops)
  WHERE entry_fingerprint IS NOT NULL;
