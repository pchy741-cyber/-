-- 015: score_accuracy 중복 방지 — chain_id 유니크 인덱스
-- 체인 종료 재호출/재시작 시 동일 체인이 중복 기록되는 것을 막음
-- NULL chain_id는 PostgreSQL UNIQUE 규칙상 허용 (NULL != NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uix_score_accuracy_chain_id ON score_accuracy(chain_id);
