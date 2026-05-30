-- 044: 월배당 투자 + 해외선물 기능 테이블
-- 두 기능 모두 OFF by default, 설정에서 켜야 사용 가능

-- ── 기능 플래그 ──
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT FALSE,
  config JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO feature_flags (key, enabled, config) VALUES
  ('dividend_investing', false, '{"description":"월배당 ETF 투자 (장기)"}'),
  ('overseas_futures', false, '{"description":"해외선물 마이크로 트레이딩 (극소액)","max_budget_krw":100000}')
ON CONFLICT (key) DO NOTHING;

-- ── 월배당 감시목록 ──
CREATE TABLE IF NOT EXISTS dividend_watchlist (
  id SERIAL PRIMARY KEY,
  stock_code TEXT NOT NULL,
  exchange TEXT DEFAULT 'NASDAQ',
  name TEXT,
  sector TEXT,
  dividend_yield NUMERIC,
  payment_frequency TEXT DEFAULT 'monthly',
  annual_dividend_per_share NUMERIC,
  expense_ratio NUMERIC,
  aum_billion NUMERIC,
  notes TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(stock_code, exchange)
);

-- 대표 월배당 ETF 초기 데이터
INSERT INTO dividend_watchlist (stock_code, exchange, name, sector, payment_frequency, notes) VALUES
  ('JEPI', 'NYSE', 'JPMorgan Equity Premium Income ETF', 'Equity Income', 'monthly', 'S&P500 커버드콜, 7-9% 배당'),
  ('JEPQ', 'NASDAQ', 'JPMorgan Nasdaq Equity Premium Income ETF', 'Tech Income', 'monthly', '나스닥 커버드콜, 9-11% 배당'),
  ('QYLD', 'NASDAQ', 'Global X NASDAQ 100 Covered Call ETF', 'Covered Call', 'monthly', '나스닥100 커버드콜, 11-12%'),
  ('SCHD', 'NYSE', 'Schwab U.S. Dividend Equity ETF', 'Dividend Growth', 'quarterly', '배당성장 우량주, 3-4%'),
  ('O', 'NYSE', 'Realty Income Corp', 'REIT', 'monthly', '리츠 월배당, 5-6%'),
  ('MAIN', 'NYSE', 'Main Street Capital', 'BDC', 'monthly', 'BDC 월배당, 6-7%'),
  ('STAG', 'NYSE', 'STAG Industrial', 'REIT', 'monthly', '산업용 리츠, 4-5%'),
  ('DIVO', 'NYSE', 'Amplify CWP Enhanced Dividend Income ETF', 'Dividend', 'monthly', '배당+커버드콜, 4-5%'),
  ('XYLD', 'NYSE', 'Global X S&P 500 Covered Call ETF', 'Covered Call', 'monthly', 'S&P500 커버드콜, 10-11%'),
  ('PFF', 'NASDAQ', 'iShares Preferred & Income Securities ETF', 'Preferred', 'monthly', '우선주 ETF, 6-7%')
ON CONFLICT (stock_code, exchange) DO NOTHING;

-- ── 배당금 수령 내역 ──
CREATE TABLE IF NOT EXISTS dividend_history (
  id SERIAL PRIMARY KEY,
  stock_code TEXT NOT NULL,
  exchange TEXT DEFAULT 'NASDAQ',
  quantity INTEGER NOT NULL DEFAULT 0,
  dividend_per_share NUMERIC,
  gross_amount_usd NUMERIC NOT NULL,
  tax_amount_usd NUMERIC DEFAULT 0,
  net_amount_usd NUMERIC NOT NULL,
  ex_date DATE,
  pay_date DATE,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 배당 보유종목 (매수한 배당주) ──
CREATE TABLE IF NOT EXISTS dividend_holdings (
  stock_code TEXT NOT NULL,
  exchange TEXT DEFAULT 'NASDAQ',
  quantity INTEGER NOT NULL DEFAULT 0,
  avg_price NUMERIC NOT NULL DEFAULT 0,
  total_dividends_received NUMERIC DEFAULT 0,
  bought_at TIMESTAMPTZ DEFAULT NOW(),
  is_paper BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (stock_code, exchange, is_paper)
);

-- ── 해외선물 포지션 ──
CREATE TABLE IF NOT EXISTS futures_positions (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  product TEXT NOT NULL,
  exchange TEXT DEFAULT 'CME',
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  quantity INTEGER NOT NULL DEFAULT 1,
  entry_price NUMERIC NOT NULL,
  current_price NUMERIC,
  margin_required_usd NUMERIC,
  pnl_usd NUMERIC DEFAULT 0,
  tp_price NUMERIC,
  sl_price NUMERIC,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  order_no TEXT,
  is_paper BOOLEAN DEFAULT TRUE
);

-- ── 해외선물 거래 로그 ──
CREATE TABLE IF NOT EXISTS futures_trades (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  product TEXT NOT NULL,
  exchange TEXT DEFAULT 'CME',
  side TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  price NUMERIC NOT NULL,
  pnl_usd NUMERIC,
  margin_usd NUMERIC,
  order_no TEXT,
  reason TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  is_paper BOOLEAN DEFAULT TRUE
);

-- ── 해외선물 예산 (완전 격리) ──
CREATE TABLE IF NOT EXISTS futures_budget (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  allocated_krw NUMERIC DEFAULT 0,
  used_margin_usd NUMERIC DEFAULT 0,
  max_budget_krw NUMERIC DEFAULT 100000,
  total_pnl_usd NUMERIC DEFAULT 0,
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO futures_budget (id, allocated_krw, max_budget_krw)
VALUES (1, 0, 100000)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_dividend_history_code ON dividend_history(stock_code);
CREATE INDEX IF NOT EXISTS idx_futures_positions_status ON futures_positions(status);
CREATE INDEX IF NOT EXISTS idx_futures_trades_symbol ON futures_trades(symbol);
