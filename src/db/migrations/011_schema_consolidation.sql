-- ============================================================
-- 011: 스키마 통합 마이그레이션
-- 이전에 런타임 코드(overseas-job, defense-park, settings 등)에
-- 흩어져 있던 CREATE/ALTER TABLE을 여기에 집중 관리
-- ============================================================

-- ── 해외주식 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS overseas_holdings (
  stock_code  TEXT NOT NULL,
  exchange    TEXT NOT NULL DEFAULT 'NASDAQ',
  quantity    NUMERIC NOT NULL DEFAULT 0,
  avg_price   NUMERIC NOT NULL DEFAULT 0,
  last_price  NUMERIC NOT NULL DEFAULT 0,
  last_price_at TIMESTAMPTZ,
  bought_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (exchange, stock_code)
);

CREATE TABLE IF NOT EXISTS overseas_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overseas_prices (
  code       TEXT NOT NULL,
  exchange   TEXT NOT NULL,
  price      NUMERIC NOT NULL DEFAULT 0,
  change_pct NUMERIC NOT NULL DEFAULT 0,
  volume     NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (exchange, code)
);

-- overseas_holdings: PK 복합키 보장 (이미 되어있으면 무시)
DO $$
BEGIN
  ALTER TABLE overseas_holdings DROP CONSTRAINT IF EXISTS overseas_holdings_pkey;
  BEGIN
    ALTER TABLE overseas_holdings ADD PRIMARY KEY (exchange, stock_code);
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS last_price     NUMERIC   NOT NULL DEFAULT 0;
ALTER TABLE overseas_holdings ADD COLUMN IF NOT EXISTS last_price_at  TIMESTAMPTZ;

-- ── 방어 파킹 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS defense_park_state (
  id               SERIAL PRIMARY KEY,
  is_active        BOOLEAN NOT NULL DEFAULT FALSE,
  park_stock_code  VARCHAR(20) NOT NULL DEFAULT '069500',
  park_stock_name  VARCHAR(100) NOT NULL DEFAULT 'KODEX 200',
  entry_reason     TEXT,
  exit_reason      TEXT,
  entered_at       TIMESTAMPTZ,
  exited_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 웹 푸시 알림 구독 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         SERIAL PRIMARY KEY,
  endpoint   TEXT UNIQUE NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth  TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 황금비율 포트폴리오 배분 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolio_allocation_config (
  id                     SERIAL PRIMARY KEY,
  parking_pct            NUMERIC NOT NULL DEFAULT 30,
  dividend_pct           NUMERIC NOT NULL DEFAULT 30,
  stock_pct              NUMERIC NOT NULL DEFAULT 40,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  rebalance_threshold_pct NUMERIC NOT NULL DEFAULT 10,
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- 기본 행 자동 삽입 (없을 경우)
INSERT INTO portfolio_allocation_config (parking_pct, dividend_pct, stock_pct)
SELECT 30, 30, 40
WHERE NOT EXISTS (SELECT 1 FROM portfolio_allocation_config);

-- ── 수익 인출 ────────────────────────────────────────────────
-- (003_profit_withdraw.sql에서 생성되지만 컬럼 추가분 보장)

-- ── AI 스코어 정확도 ─────────────────────────────────────────
-- (010_score_accuracy.sql에서 생성되지만 main.ts 인라인 중복 제거 대상)
CREATE TABLE IF NOT EXISTS score_accuracy (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code       VARCHAR(20) NOT NULL,
  chain_id         UUID,
  entry_score      SMALLINT,
  entry_signal     VARCHAR(20),
  entry_confidence DECIMAL(4,3),
  realized_pnl_pct DECIMAL(8,4),
  outcome          VARCHAR(10) NOT NULL DEFAULT 'BREAK_EVEN',
  holding_days     SMALLINT,
  close_reason     TEXT,
  strategy_mode    VARCHAR(15),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_score_accuracy_stock    ON score_accuracy(stock_code);
CREATE INDEX IF NOT EXISTS idx_score_accuracy_recorded ON score_accuracy(recorded_at DESC);

-- ── transaction_chains 컬럼 추가 ─────────────────────────────
ALTER TABLE transaction_chains ADD COLUMN IF NOT EXISTS peak_price NUMERIC;

-- ── orders 컬럼 타입 확장 ────────────────────────────────────
ALTER TABLE orders ALTER COLUMN kis_order_no TYPE VARCHAR(100);

-- ── strategy_config 컬럼 추가 ────────────────────────────────
ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS notebooklm_prompt TEXT DEFAULT '';
ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS strategy_document  TEXT DEFAULT '';
ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS risk_prompt        TEXT DEFAULT '';

-- ── learned_insights 컬럼 추가 ───────────────────────────────
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS recommendation TEXT;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS param_change   JSONB;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS is_applied     BOOLEAN DEFAULT FALSE;
ALTER TABLE learned_insights ADD COLUMN IF NOT EXISTS applied_at     TIMESTAMPTZ;
