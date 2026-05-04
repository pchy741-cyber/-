-- ============================================================
-- 014: 스키마 충돌 해결 + 누락 테이블 추가
--
-- 문제:
--  - portfolio_allocation_config: migration 011이 parking_pct/stock_pct 컬럼으로
--    생성했지만 settings.ts는 kr_pct/us_pct/sector_* 컬럼을 사용 → 컬럼 없음 오류
--  - push_subscriptions: migration 011이 last_used/user_agent 없이 생성
--  - system_config: web-push.ts VAPID 키 저장용으로 사용하지만 마이그레이션 없음
--  - overseas_state: schema_holdings_v2 플래그 누락 시 overseas-job.ts가 중복 실행
--
-- 해결: 모든 DDL을 마이그레이션으로 집중 관리 (런타임 inline CREATE TABLE 제거 전제)
-- ============================================================

-- ── portfolio_allocation_config: 실제 사용 컬럼 추가 ───────────────────────
-- migration 011은 parking_pct/dividend_pct/stock_pct 만 생성 (track-b pipeline 용)
-- settings.ts는 kr_pct/us_pct/sector_* 사용 → ADD COLUMN IF NOT EXISTS로 보완
ALTER TABLE portfolio_allocation_config
  ADD COLUMN IF NOT EXISTS kr_pct               NUMERIC NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS us_pct               NUMERIC NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS sector_semiconductor NUMERIC NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS sector_bio           NUMERIC NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS sector_defense       NUMERIC NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS sector_finance       NUMERIC NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS sector_etc           NUMERIC NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS trailing_stop_pct    NUMERIC NOT NULL DEFAULT 5;

-- 기본 행이 없으면 삽입 (전체 컬럼 기본값 포함)
INSERT INTO portfolio_allocation_config
  (parking_pct, dividend_pct, stock_pct,
   kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc, trailing_stop_pct)
SELECT 30, 30, 40,
       70, 30, 30, 20, 25, 20, 30, 5
WHERE NOT EXISTS (SELECT 1 FROM portfolio_allocation_config);

-- ── push_subscriptions: 누락 컬럼 추가 ────────────────────────────────────
-- migration 011에서 last_used, user_agent 없이 생성됨
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS last_used   TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS user_agent  TEXT;

-- ── system_config: VAPID 키 + 기타 시스템 설정 저장용 ──────────────────────
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── overseas_state: 이미 마이그레이션 011에서 PK 변환 완료 처리 ──────────────
-- overseas-job.ts의 ensureOverseasTable()이 재실행되지 않도록 플래그 선설정
INSERT INTO overseas_state (key, value)
VALUES ('schema_holdings_v2', '1')
ON CONFLICT (key) DO NOTHING;
