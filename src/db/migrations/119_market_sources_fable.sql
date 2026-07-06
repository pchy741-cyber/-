-- v27: Fable 스케줄 카드 지원 — body(텍스트 본문), source(출처 구분), expires_at(TTL)
ALTER TABLE market_sources ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE market_sources ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual';
ALTER TABLE market_sources ADD COLUMN IF NOT EXISTS expires_at DATE;
