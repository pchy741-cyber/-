-- 하락장 방어 파킹 상태 테이블
-- 시장 하락세 감지 시 전종목 청산 후 안전자산(KODEX 200)에 파킹
CREATE TABLE IF NOT EXISTS defense_park_state (
    id SERIAL PRIMARY KEY,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    park_stock_code VARCHAR(20) NOT NULL DEFAULT '069500',  -- KODEX 200
    park_stock_name VARCHAR(100) NOT NULL DEFAULT 'KODEX 200',
    entry_reason TEXT,
    exit_reason TEXT,
    entered_at TIMESTAMPTZ,
    exited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 한 번에 하나만 활성화
CREATE UNIQUE INDEX IF NOT EXISTS idx_defense_park_active
    ON defense_park_state(is_active) WHERE is_active = TRUE;
