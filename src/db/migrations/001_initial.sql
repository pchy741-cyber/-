-- ============================================
-- QUANTOPS 초기 DB 스키마
-- Supabase (PostgreSQL) 용
-- ============================================

-- 1. 감시 목록 (CEO가 관리하는 종목 리스트)
CREATE TABLE IF NOT EXISTS watchlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code VARCHAR(10) NOT NULL UNIQUE,  -- 국내 6자리, 미국 AAPL 등
    stock_name VARCHAR(100) NOT NULL,
    market VARCHAR(10) NOT NULL DEFAULT 'KOSPI', -- KOSPI | KOSDAQ | NYSE | NASDAQ
    currency VARCHAR(3) NOT NULL DEFAULT 'KRW',  -- KRW | USD
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT
);

-- 2. AI 스코어 (Track A 산출물, Track B가 참조)
CREATE TABLE IF NOT EXISTS ai_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code VARCHAR(6) NOT NULL REFERENCES watchlist(stock_code),
    score_date DATE NOT NULL,

    -- Gemini 정제 결과
    gemini_summary JSONB,

    -- GPT-4o 스코어링 결과
    composite_score DECIMAL(5,2),
    fundamental_score DECIMAL(5,2),
    technical_score DECIMAL(5,2),
    sentiment_score DECIMAL(5,2),
    confidence DECIMAL(3,2),
    reasoning TEXT,

    -- 시그널
    signal VARCHAR(15),
    target_price INTEGER,
    stop_loss_price INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(stock_code, score_date)
);

-- 3. 트랜잭션 체인 (1차매수 → 물타기 → 익절을 하나로 묶음)
CREATE TABLE IF NOT EXISTS transaction_chains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code VARCHAR(6) NOT NULL REFERENCES watchlist(stock_code),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',

    -- 전략 모드
    strategy_mode VARCHAR(15) NOT NULL DEFAULT 'SWING',

    -- 집계 데이터
    avg_buy_price DECIMAL(12,2),
    total_quantity INTEGER DEFAULT 0,
    total_invested DECIMAL(15,2) DEFAULT 0,
    realized_pnl DECIMAL(15,2) DEFAULT 0,

    -- 전략 파라미터
    target_profit_pct DECIMAL(5,2),
    stop_loss_pct DECIMAL(5,2),
    max_averaging_count INTEGER DEFAULT 3,
    current_averaging_count INTEGER DEFAULT 0,
    peak_price_since_open DECIMAL(12,2),    -- 트레일링 스톱용: 보유 기간 중 최고가

    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    close_reason TEXT
);

-- 4. 주문 (개별 KIS 주문 기록)
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id UUID REFERENCES transaction_chains(id),
    stock_code VARCHAR(6) NOT NULL,

    -- 주문 상세
    side VARCHAR(4) NOT NULL,
    order_type VARCHAR(10) NOT NULL,
    quantity INTEGER NOT NULL,
    price DECIMAL(12,2),

    -- KIS 응답
    kis_order_no VARCHAR(20),
    kis_status VARCHAR(20),
    filled_quantity INTEGER DEFAULT 0,
    filled_price DECIMAL(12,2),

    -- 메타
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    trading_mode VARCHAR(10) NOT NULL,
    trigger_source VARCHAR(20),
    ai_reasoning TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. 포트폴리오 스냅샷
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_value DECIMAL(15,2),
    cash_balance DECIMAL(15,2),
    invested_value DECIMAL(15,2),
    unrealized_pnl DECIMAL(15,2),
    daily_pnl DECIMAL(15,2),
    daily_pnl_pct DECIMAL(5,2),
    positions JSONB
);

-- 6. 시스템 로그 (AI 의사결정 감사 추적)
CREATE TABLE IF NOT EXISTS system_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level VARCHAR(10) NOT NULL,
    component VARCHAR(30) NOT NULL,
    message TEXT NOT NULL,
    details JSONB
);

-- 7. 리스크 이벤트 (Kill Switch, 한도 초과 등)
CREATE TABLE IF NOT EXISTS risk_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(30) NOT NULL,
    severity VARCHAR(10) NOT NULL,
    details JSONB,
    action_taken TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. CEO 전략 설정 (대시보드에서 입력하는 프롬프트/모드)
CREATE TABLE IF NOT EXISTS strategy_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mode VARCHAR(15) NOT NULL DEFAULT 'SWING',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- 3단계 프롬프트
    gemini_prompt TEXT NOT NULL,
    gpt_prompt TEXT NOT NULL,
    claude_prompt TEXT NOT NULL,

    -- 리스크 오버라이드 (하드 리밋은 .env가 최종 방어선)
    buy_threshold INTEGER DEFAULT 75,
    stop_loss_pct DECIMAL(5,2) DEFAULT -5.0,
    take_profit_pct DECIMAL(5,2) DEFAULT 8.0,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. 자기학습 인사이트 (과거 매매 패턴 학습 결과)
CREATE TABLE IF NOT EXISTS learned_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(20) NOT NULL,       -- WIN_PATTERN | LOSS_PATTERN | TIMING | SIZING
    insight TEXT NOT NULL,
    confidence DECIMAL(3,2) NOT NULL,
    sample_count INTEGER NOT NULL,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details JSONB
);

-- ── 인덱스 ──
CREATE INDEX IF NOT EXISTS idx_ai_scores_lookup ON ai_scores(stock_code, score_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_chain ON orders(chain_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chains_status ON transaction_chains(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON portfolio_snapshots(snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_log_time ON system_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_log_component ON system_log(component, timestamp DESC);

-- ── 3개월 데이터 아카이빙용 파티셔닝 (선택) ──
-- 추후 pg_cron 또는 Cloud Scheduler로 오래된 로그 이동
