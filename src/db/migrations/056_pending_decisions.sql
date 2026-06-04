-- 판단 큐: 서버가 자동 감지한 "AI 판단이 필요한 상황"
-- 규칙 엔진으로는 판단 불가 → Claude Code(Opus급)가 처리

CREATE TABLE IF NOT EXISTS pending_decisions (
  id            SERIAL PRIMARY KEY,
  situation     TEXT NOT NULL,          -- 상황 요약 (1줄)
  category      TEXT NOT NULL,          -- 'profit_lock' | 'loss_cut' | 'event' | 'anomaly' | 'rebalance'
  stock_code    TEXT,                   -- 관련 종목 (NULL이면 시장 전체)
  context       JSONB NOT NULL,         -- AI가 판단에 필요한 전체 데이터
  urgency       INT NOT NULL DEFAULT 2, -- 1=긴급(장중), 2=보통, 3=참고
  is_paper      BOOLEAN NOT NULL DEFAULT true,
  status        TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING' | 'DECIDED' | 'EXPIRED' | 'AUTO_RESOLVED'
  decision      JSONB,                  -- Claude Code가 내린 결정
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '8 hours'
);

CREATE INDEX IF NOT EXISTS idx_pending_decisions_status ON pending_decisions(status, is_paper);
CREATE INDEX IF NOT EXISTS idx_pending_decisions_urgency ON pending_decisions(urgency, created_at DESC);
