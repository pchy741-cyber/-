-- 시장 참고 소스 (YouTube, 뉴스, 리서치 등 CEO 참고용)
CREATE TABLE IF NOT EXISTS market_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    url TEXT NOT NULL,
    source_type VARCHAR(20) NOT NULL DEFAULT 'article', -- youtube | article | research | news
    memo TEXT,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
