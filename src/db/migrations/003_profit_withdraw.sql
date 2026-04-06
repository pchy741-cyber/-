-- 수익 인출 설정 (CEO가 설정하는 자동 수익 확보 룰)
CREATE TABLE IF NOT EXISTS profit_withdraw_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    target_profit_pct DECIMAL(5,2) NOT NULL DEFAULT 10.0,   -- 목표 수익률 (%) 도달 시 트리거
    withdraw_ratio_pct DECIMAL(5,2) NOT NULL DEFAULT 50.0,  -- 수익분 중 인출할 비율 (%)
    min_withdraw_amount INTEGER NOT NULL DEFAULT 100000,     -- 최소 인출 금액 (원)
    check_frequency VARCHAR(10) NOT NULL DEFAULT 'daily',   -- daily | weekly
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 수익 인출 내역
CREATE TABLE IF NOT EXISTS profit_withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    amount INTEGER NOT NULL,                  -- 확보(인출 예약) 금액
    profit_pct_at_trigger DECIMAL(5,2),       -- 트리거 시점 수익률
    total_value_at_trigger INTEGER,           -- 트리거 시점 총 자산
    status VARCHAR(20) NOT NULL DEFAULT 'reserved',  -- reserved | withdrawn | cancelled
    memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 기본 설정 1행 삽입
INSERT INTO profit_withdraw_config (is_active, target_profit_pct, withdraw_ratio_pct, min_withdraw_amount, check_frequency)
VALUES (false, 10.0, 50.0, 100000, 'daily')
ON CONFLICT DO NOTHING;
