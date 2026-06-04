-- 057: 트레이딩 레퍼런스 — 커뮤니티/인플루언서 인사이트 → 단기 매매 반영
CREATE TABLE IF NOT EXISTS trading_references (
  id              SERIAL PRIMARY KEY,
  content         TEXT NOT NULL,                    -- 사용자 입력 텍스트
  image_base64    TEXT,                             -- 이미지 (선택)
  mime_type       TEXT,                             -- image/png 등
  analysis        JSONB,                            -- AI 분석 결과
  stock_codes     TEXT[] DEFAULT '{}',              -- 추출된 종목코드
  sentiment       TEXT DEFAULT 'NEUTRAL',           -- BULLISH / BEARISH / NEUTRAL
  confidence      INTEGER DEFAULT 50,               -- 0-100
  overrides_applied TEXT[] DEFAULT '{}',            -- 생성된 override key 목록
  is_active       BOOLEAN DEFAULT true,
  is_paper        BOOLEAN DEFAULT true,
  ttl_hours       INTEGER DEFAULT 24,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trading_refs_active ON trading_references (is_active, expires_at);
