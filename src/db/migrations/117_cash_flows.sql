-- v25 P0-1: 입출금 추적 테이블 (TWR 수익률 산출 기반)
-- GIPS TWR: r_t = (V_t - V_{t-1} - F_t) / (V_{t-1} + F_t)

CREATE TABLE IF NOT EXISTS cash_flows (
  id BIGSERIAL PRIMARY KEY,
  flow_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  amount_krw NUMERIC NOT NULL,         -- 입금 +, 출금 - (해외는 당일환율 KRW 환산)
  currency TEXT NOT NULL DEFAULT 'KRW',
  amount_ccy NUMERIC,                  -- 원통화 금액 (해외 USD 등)
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'kis_detected' | 'fx_transfer'
  is_paper BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_flows_date
  ON cash_flows (((flow_at AT TIME ZONE 'Asia/Seoul')::date), is_paper);
