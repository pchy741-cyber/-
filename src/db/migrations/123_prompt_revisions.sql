-- T8: 프롬프트 정합성 관리 — 지시탭(전략/리스크/분석/매매) 변경 감사·승인 큐
-- 모든 지시탭 변경은 이 테이블을 경유한다 (직접 UPDATE 금지 — 감사 추적이 목적).
-- old_text/new_text 전문을 보존하여 승인·반려 후에도 변경 이력 추적 가능.
CREATE TABLE IF NOT EXISTS prompt_revisions (
  id          BIGSERIAL PRIMARY KEY,
  tab         TEXT NOT NULL CHECK (tab IN ('strategy','risk','analysis','trading')),
  old_text    TEXT,
  new_text    TEXT NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  proposed_by TEXT NOT NULL DEFAULT 't8',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_prompt_revisions_status ON prompt_revisions (status, created_at);

-- 탭당 PENDING 1건만 허용 (제안 스팸 방지 — DB 레벨 안전장치, 라우트에서도 409 선검사)
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_revisions_pending_tab
  ON prompt_revisions (tab) WHERE status = 'PENDING';
