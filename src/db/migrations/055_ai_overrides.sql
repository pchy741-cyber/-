-- AI Loop: 외부 AI(Claude Code/Cursor) → 서버 파라미터 오버라이드 테이블
-- 구독형 AI의 Opus급 추론으로 API 토큰 비용 없이 매매 조절

CREATE TABLE IF NOT EXISTS ai_overrides (
  id            SERIAL PRIMARY KEY,
  category      TEXT NOT NULL,          -- 'stock' | 'risk' | 'threshold' | 'signal'
  key           TEXT NOT NULL UNIQUE,   -- e.g. '005930_scoreAdj', 'minBuyScore', 'NVDA_forceHold'
  value         JSONB NOT NULL,         -- 유연한 값 저장
  reason        TEXT,                   -- AI가 남긴 근거
  is_paper      BOOLEAN NOT NULL DEFAULT true,  -- paper/live 모드 분리
  expires_at    TIMESTAMPTZ,            -- TTL 자동 만료 (NULL = 영구)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_overrides_category ON ai_overrides(category);
CREATE INDEX IF NOT EXISTS idx_ai_overrides_mode ON ai_overrides(is_paper);
CREATE INDEX IF NOT EXISTS idx_ai_overrides_expires ON ai_overrides(expires_at) WHERE expires_at IS NOT NULL;

-- AI 명령 이력 (감사 로그)
CREATE TABLE IF NOT EXISTS ai_command_log (
  id            SERIAL PRIMARY KEY,
  command_type  TEXT NOT NULL,          -- 'setOverride' | 'removeOverride' | 'forceAction'
  payload       JSONB NOT NULL,         -- 전체 명령 JSON
  result        TEXT DEFAULT 'OK',      -- 'OK' | 'REJECTED' | 'ERROR'
  reject_reason TEXT,                   -- 거부 사유
  is_paper      BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_command_log_time ON ai_command_log(created_at DESC);
