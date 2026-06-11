-- 데이터 마스터: Track B 파이프라인 실행 이력 + 종목별 판단 로그
-- 목적: 레짐 감지 정확도 검증, 알고리즘 개선 데이터 수집, 스킵 원인 분석

CREATE TABLE IF NOT EXISTS scan_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  scanned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_paper           BOOLEAN NOT NULL DEFAULT FALSE,
  effective_mode     TEXT NOT NULL,
  kospi_penalty      SMALLINT NOT NULL DEFAULT 0,
  kospi_boost        BOOLEAN NOT NULL DEFAULT FALSE,
  block_new_buys     BOOLEAN NOT NULL DEFAULT FALSE,
  flash_crash        BOOLEAN NOT NULL DEFAULT FALSE,
  daily_pnl_pct      NUMERIC(6,3),
  total_assets       BIGINT,
  orderable_cash     BIGINT,
  scores_count       SMALLINT,
  decisions_count    SMALLINT,
  buys_count         SMALLINT,
  sells_count        SMALLINT,
  elapsed_ms         INT,
  macro_regime       TEXT,
  crash_signal_level TEXT NOT NULL DEFAULT 'NONE'
);

CREATE TABLE IF NOT EXISTS scan_stock_decisions (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         BIGINT NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  stock_code         TEXT NOT NULL,
  ai_score_raw       NUMERIC(5,1),
  ai_score_adjusted  NUMERIC(5,1),
  confidence         NUMERIC(4,3),
  regime             TEXT,
  regime_confidence  NUMERIC(4,3),
  adx                NUMERIC(5,1),
  autocorrelation    NUMERIC(5,3),
  buy_threshold_adj  SMALLINT NOT NULL DEFAULT 0,
  action             TEXT NOT NULL,
  skip_reason        TEXT,
  quantity           INT,
  is_paper           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_sessions_time   ON scan_sessions(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_sessions_paper  ON scan_sessions(is_paper, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_stock_session   ON scan_stock_decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_scan_stock_code_time ON scan_stock_decisions(stock_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_stock_regime    ON scan_stock_decisions(regime, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_stock_paper     ON scan_stock_decisions(is_paper, action, created_at DESC);

COMMENT ON TABLE scan_sessions IS 'Track B 파이프라인 실행 세션 로그';
COMMENT ON TABLE scan_stock_decisions IS 'Track B 종목별 AI 판단 + 레짐 감지 결과 (알고리즘 개선용)';
