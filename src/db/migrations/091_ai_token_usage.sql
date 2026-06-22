-- AI 토큰 사용량 추적 테이블
CREATE TABLE IF NOT EXISTS ai_token_usage (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,          -- 'gemini' | 'gpt' | 'claude-api' | 'claude-cli' | 'groq'
  model         TEXT NOT NULL,          -- 'gemini-2.5-flash', 'gpt-4o-mini', 'claude-haiku-4-5', 'sonnet', 'llama-3.3-70b'
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
  call_count    INT NOT NULL DEFAULT 1,
  label         TEXT,                   -- 용도 ('scoring', 'news', 'self-learning', 'executor', etc.)
  is_paper      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atu_provider_date ON ai_token_usage (provider, created_at);
CREATE INDEX IF NOT EXISTS idx_atu_created ON ai_token_usage (created_at);

-- 일별 집계 뷰
CREATE OR REPLACE VIEW ai_token_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  provider,
  model,
  SUM(input_tokens)  AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cost_usd)      AS cost_usd,
  SUM(call_count)    AS calls
FROM ai_token_usage
GROUP BY 1, 2, 3;
