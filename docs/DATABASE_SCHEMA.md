# Database Master Schema — ai-auto-bot (QuantOps)

> Updated: 2026-07-01 | PostgreSQL 45 tables | 107 migrations
> 전수조사 기반 DDL↔Zod↔Repo↔Frontend 정합성 검증 완료

---

## Core Trading Tables

### `transaction_chains` — 매매 체인 (매수→물타기→매도 그룹)
| Column | Type | Default | Migration | Note |
|--------|------|---------|-----------|------|
| id | UUID | PK gen_random_uuid() | 001 | |
| stock_code | VARCHAR(10) | FK watchlist | 001→019 widened | |
| stock_name | VARCHAR(100) | NULL | 104 | 워치리스트 JOIN 없이 캐시 |
| status | VARCHAR(20) | 'OPEN' | 001 | CHECK: OPEN/AVERAGING/PROFIT_TAKING/CLOSED |
| strategy_mode | VARCHAR(15) | 'SWING' | 001 | SWING/DEFENSE/SCALPING/DIVIDEND/SNIPER/BOTTOM_FISHING/EOD_BETTING/BREAKOUT |
| avg_buy_price | DECIMAL(12,2) | NULL | 001 | 수수료 포함 평균단가 |
| total_quantity | INTEGER | 0 | 001 | |
| total_invested | DECIMAL(15,2) | 0 | 001 | |
| realized_pnl | DECIMAL(15,2) | 0 | 001 | |
| target_profit_pct | DECIMAL(5,2) | NULL | 001 | |
| stop_loss_pct | DECIMAL(5,2) | NULL | 001 | |
| max_averaging_count | INTEGER | 3 | 001 | |
| current_averaging_count | INTEGER | 0 | 001 | |
| peak_price_since_open | DECIMAL(12,2) | NULL | 001 | 트레일링 스탑 최고가 |
| peak_price | NUMERIC | NULL | 011 | 트레일링 스탑용 |
| escape_target_price | NUMERIC(18,4) | NULL | 007 | 탈출 모드 목표가 |
| is_paper | BOOLEAN NOT NULL | true | 020 | paper/live 분리 |
| pnl_pct | DECIMAL(8,4) | NULL | 081 | 실현 손익률 |
| sell_reason | VARCHAR(50) | NULL | 081 | 매도 사유 코드 |
| opened_at | TIMESTAMPTZ | NOW() | 001 | |
| closed_at | TIMESTAMPTZ | NULL | 001 | |
| close_reason | TEXT | NULL | 001 | |

**UNIQUE**: `(stock_code, is_paper) WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')`
**CHECK (098)**: `status IN ('OPEN','AVERAGING','PROFIT_TAKING','CLOSED')`

### `orders` — 개별 주문 기록
| Column | Type | Default | Migration | Note |
|--------|------|---------|-----------|------|
| id | UUID | PK | 001 | |
| chain_id | UUID | FK chains | 001 | NULL for overseas |
| stock_code | VARCHAR(10) | | 001→019 widened | |
| side | VARCHAR(4) | | 001 | CHECK: BUY/SELL |
| order_type | VARCHAR(10) | | 001 | MARKET/LIMIT |
| quantity | INTEGER | | 001 | |
| price | DECIMAL(12,2) | NULL | 001 | |
| kis_order_no | VARCHAR(100) | NULL | 001→011 widened | |
| kis_status | VARCHAR(20) | NULL | 001 | |
| filled_quantity | INTEGER | 0 | 001 | |
| filled_price | DECIMAL(12,2) | NULL | 001 | |
| status | VARCHAR(20) | 'PENDING' | 001 | CHECK: PENDING/PARTIAL/FILLED/CANCELLED/REJECTED/EXPIRED |
| trading_mode | VARCHAR(10) | | 001 | CHECK: paper/live/p_arch |
| trigger_source | VARCHAR(20) | NULL | 001 | TRACK_B/OVERSEAS/EXTERNAL |
| ai_reasoning | TEXT | NULL | 001 | |
| avg_buy_price | NUMERIC | NULL | 029 | 해외 매도용 평균단가 |
| is_paper | BOOLEAN | GENERATED | 088 | `GENERATED ALWAYS AS (trading_mode IN ('paper','p_arch')) STORED` |
| created_at | TIMESTAMPTZ | NOW() | 001 | |
| updated_at | TIMESTAMPTZ | NOW() | 001 | |

### `overseas_holdings` — 해외주식 보유
| Column | Type | Default | Migration | Note |
|--------|------|---------|-----------|------|
| stock_code | TEXT | | 011 | |
| exchange | TEXT | 'NASDAQ' | 011 | |
| is_paper | BOOLEAN NOT NULL | false | 026 | |
| quantity | NUMERIC | 0 | 011 | |
| avg_price | NUMERIC | 0 | 011 | |
| last_price | NUMERIC | 0 | 011 | |
| last_price_at | TIMESTAMPTZ | NULL | 011 | |
| bought_at | TIMESTAMPTZ | NOW() | 011 | |
| scalp_tp | NUMERIC | NULL | 018 | 스캘핑 TP |
| scalp_sl | NUMERIC | NULL | 018 | 스캘핑 SL |
| is_scalp | BOOLEAN | false | 018 | |
| tp_pct | NUMERIC | NULL | 043 | 동적 목표수익률 % |
| sl_pct | NUMERIC | NULL | 043 | 동적 손절률 % |
| strategy_bucket | TEXT | 'SWING' | 050 | SWING/CORE/TACTICAL |
| averaging_count | INTEGER NOT NULL | 0 | 102 | 물타기 횟수 (max 2) |
| initial_avg_price | NUMERIC | 0 | 102 | 최초 매수 평균가 |
| max_price | NUMERIC | NULL | 103 | 보유 기간 최고가 |

**PK**: `(exchange, stock_code, is_paper)` (035/036)

### `overseas_state` — 해외매매 상태 K/V
| Column | Type | Default | Migration | Note |
|--------|------|---------|-----------|------|
| key | TEXT | PK | 011 | cash, cash_paper, maxprice_*, dip_buy_* |
| value | TEXT | | 011 | |
| updated_at | TIMESTAMPTZ | NOW() | 046 | trigger auto-update |

---

## Portfolio & Risk

### `portfolio_snapshots` — 포트폴리오 스냅샷
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | UUID | PK | 001 |
| snapshot_at | TIMESTAMPTZ | NOW() | 001 |
| total_value | DECIMAL(15,2) | NULL | 001 |
| cash_balance | DECIMAL(15,2) | NULL | 001 |
| invested_value | DECIMAL(15,2) | NULL | 001 |
| unrealized_pnl | DECIMAL(15,2) | NULL | 001 |
| daily_pnl | DECIMAL(15,2) | NULL | 001 |
| daily_pnl_pct | DECIMAL(5,2) | NULL | 001 |
| positions | JSONB | NULL | 001 |
| is_paper | BOOLEAN NOT NULL | false | 022 |

### `score_accuracy` — AI 예측 정확도
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | UUID | PK | 011 |
| stock_code | VARCHAR(20) | | 011 |
| chain_id | UUID | FK chains | 011 |
| entry_score | SMALLINT | NULL | 011 |
| entry_signal | VARCHAR(20) | NULL | 011 |
| entry_confidence | DECIMAL(4,3) | NULL | 011 |
| realized_pnl_pct | DECIMAL(8,4) | NULL | 011 |
| outcome | VARCHAR(10) | 'BREAK_EVEN' | 011 |
| holding_days | SMALLINT | NULL | 011 |
| close_reason | TEXT | NULL | 011 |
| strategy_mode | VARCHAR(15) | NULL | 011 |
| is_paper | BOOLEAN NOT NULL | false | 026 |
| order_id | UUID | NULL | 039 |
| market | VARCHAR(2) | 'KR' | 039 |
| entry_fingerprint | TEXT | NULL | 053 |
| recorded_at | TIMESTAMPTZ | NOW() | 011 |

### `portfolio_allocation_config` — 자산배분 + 리스크 설정
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | SERIAL | PK | 011 |
| parking_pct | NUMERIC | 30 | 011 |
| dividend_pct | NUMERIC | 30 | 011 |
| stock_pct | NUMERIC | 40 | 011 |
| is_active | BOOLEAN | true | 011 |
| rebalance_threshold_pct | NUMERIC | 10 | 011 |
| kr_pct | NUMERIC | 70 | 014 |
| us_pct | NUMERIC | 30 | 014 |
| sector_semiconductor | NUMERIC | 30 | 014 |
| sector_bio | NUMERIC | 20 | 014 |
| sector_defense | NUMERIC | 25 | 014 |
| sector_finance | NUMERIC | 20 | 014 |
| sector_etc | NUMERIC | 30 | 014 |
| trailing_stop_pct | NUMERIC | 5 | 014 |
| trading_mode_override | VARCHAR(10) | NULL | 018 |
| seed_capital | NUMERIC | 0 | 034 |
| is_paper | BOOLEAN NOT NULL | false | 037 |
| position_cap_pct | NUMERIC(5,2) | 25 | 066 |
| max_invested_pct | NUMERIC(5,2) | 88 | 066 |
| cash_reserve_pct | NUMERIC(5,2) | 20 | 066 |
| max_positions | INT | 8 | 066 |
| max_daily_trades | INT | 3 | 066 |
| updated_at | TIMESTAMPTZ | NOW() | 011 |

---

## AI & Strategy

### `ai_scores` — Track A AI 점수
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | UUID | PK | 001 |
| stock_code | VARCHAR(10) | FK watchlist | 001→019 widened |
| score_date | DATE | | 001 |
| gemini_summary | JSONB | NULL | 001 |
| composite_score | DECIMAL(5,2) | NULL | 001 |
| fundamental_score | DECIMAL(5,2) | NULL | 001 |
| technical_score | DECIMAL(5,2) | NULL | 001 |
| sentiment_score | DECIMAL(5,2) | NULL | 001 |
| confidence | DECIMAL(3,2) | NULL | 001 |
| reasoning | TEXT | NULL | 001 |
| signal | VARCHAR(15) | NULL | 001 |
| target_price | INTEGER | NULL | 001 |
| stop_loss_price | INTEGER | NULL | 001 |
| created_at | TIMESTAMPTZ | NOW() | 001 |

**UNIQUE**: `(stock_code, score_date)`

### `watchlist` — 감시 종목
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | UUID | PK | 001 |
| stock_code | VARCHAR(10) | UNIQUE | 001 |
| stock_name | VARCHAR(100) | | 001 |
| market | VARCHAR(10) | 'KOSPI' | 001 |
| currency | VARCHAR(3) | 'KRW' | 001 |
| is_active | BOOLEAN | true | 001 |
| added_at | TIMESTAMPTZ | NOW() | 001 |
| notes | TEXT | NULL | 001 |
| source | VARCHAR(30) NOT NULL | 'MANUAL' | 009 |
| long_term_hold | BOOLEAN NOT NULL | false | 100 |

### `strategy_config` — CEO 전략 설정
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | UUID | PK | 001 |
| mode | VARCHAR(15) | 'SWING' | 001 |
| is_active | BOOLEAN | true | 001 |
| gemini_prompt | TEXT | | 001 |
| gpt_prompt | TEXT | | 001 |
| claude_prompt | TEXT | | 001 |
| buy_threshold | INTEGER | 75 | 001 |
| stop_loss_pct | DECIMAL(5,2) | -5.0 | 001 |
| take_profit_pct | DECIMAL(5,2) | 8.0 | 001 |
| notebooklm_prompt | TEXT | '' | 011 |
| strategy_document | TEXT | '' | 011 |
| risk_prompt | TEXT | '' | 011 |
| is_paper | BOOLEAN NOT NULL | false | 037 |
| use_dynamic_tpsl | BOOLEAN NOT NULL | false | 041 |
| ai_scoring_mode | VARCHAR(20) NOT NULL | 'fallback' | 062 |
| ensemble_config | JSONB NOT NULL | (default weights) | 062 |
| updated_at | TIMESTAMPTZ | NOW() | 001 |

---

## System & Config

### `system_state` — 시스템 상태 K/V
| Column | Type | Migration |
|--------|------|-----------|
| key | TEXT PK | 013 |
| value | TEXT | 013 |
| updated_at | TIMESTAMPTZ | 013 |

### `system_config` — 시스템 설정 K/V
| Column | Type | Migration |
|--------|------|-----------|
| key | TEXT PK | 014 |
| value | TEXT | 014 |
| updated_at | TIMESTAMPTZ | 014 |

### `feature_flags` — 기능 플래그
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| key | TEXT PK | | 044 |
| enabled | BOOLEAN | false | 044 |
| config | JSONB | '{}' | 044 |
| updated_at | TIMESTAMPTZ | NOW() | 044 |

### `ai_overrides` — AI 파라미터 오버라이드
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | SERIAL PK | | 055 |
| category | TEXT | | 055 |
| key | TEXT | | 055 |
| value | JSONB | | 055 |
| reason | TEXT | NULL | 055 |
| is_paper | BOOLEAN NOT NULL | true | 055 |
| expires_at | TIMESTAMPTZ | NULL | 055 |
| created_at | TIMESTAMPTZ | NOW() | 055 |
| updated_at | TIMESTAMPTZ | NOW() | 055 |

**UNIQUE**: `(key, is_paper)` (065)

### `ai_token_usage` — AI 토큰 비용 추적
| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| id | BIGSERIAL PK | | 091 |
| provider | TEXT | | 091 |
| model | TEXT | | 091 |
| input_tokens | INT | 0 | 091 |
| output_tokens | INT | 0 | 091 |
| cost_usd | NUMERIC(10,6) | 0 | 091 |
| call_count | INT | 1 | 091 |
| label | TEXT | NULL | 091 |
| is_paper | BOOLEAN NOT NULL | false | 091 |
| created_at | TIMESTAMPTZ | NOW() | 091 |

**VIEW**: `ai_token_daily` (provider/model별 일별 집계)

---

## Strategy Lab

### `strategy_graduations` — 전략 졸업 심사
Migration 061 | status: PENDING/AUTO_APPLIED/APPROVED/REJECTED/EXPIRED

### `strategy_insights` — 전략 조건별 인사이트
Migration 061+089 | UNIQUE(strategy_mode, condition_key)

### `strategy_splits` — A/B 전략 분할 테스트
Migration 089

### `ceo_overrides` — CEO 오버라이드 이력
Migration 089

### `score_tier_params` — 점수 구간별 배분 파라미터
Migration 012+105 | UNIQUE(tier_min, tier_max, market)

---

## Dividend

### `dividend_watchlist` — 배당 종목 리스트
Migration 044 | UNIQUE(stock_code, exchange)

### `dividend_history` — 배당 이력
Migration 044+092 | is_paper, currency 추가

### `dividend_holdings` — 배당 보유 현황
Migration 044 | PK(stock_code, exchange, is_paper)

---

## Scanning & Logging

### `scan_sessions` — Track B 스캔 세션
Migration 067 | macro_regime, crash_signal_level

### `scan_stock_decisions` — Track B 종목별 결정
Migration 067 | FK scan_sessions(id)

### `loop_sessions` — 루프 모드 세션
Migration 047+063+072

### `loop_ticks` — 루프 틱 기록
Migration 047 | FK loop_sessions(id)

### `shadow_trades` — OOS 가상 매매
Migration 071

### `capture_snapshots` — 진단 캡처
Migration 073

### `ai_scores_history` — AI 점수 시계열
Migration 075

### `ai_command_log` — AI 커맨드 감사
Migration 055

### `system_log` — 시스템 로그
Migration 001

### `risk_events` — 리스크 이벤트
Migration 001

### `qa_reports` — QA 보고서
Migration 093

### `dart_research_cache` — DART 리서치 캐시
Migration 107 | PK(stock_code, year, quarter)

---

## Other Tables

### `defense_park_state` — 방어 파킹 상태
Migration 011+079+096 | is_paper 추가

### `learned_insights` — 자기학습 인사이트
Migration 001+005+008+011+037+040+085

### `push_subscriptions` — 웹 푸시 구독
Migration 011+014

### `webauthn_credentials` — WebAuthn 인증
Migration 052

### `pending_decisions` — 대기 중 의사결정
Migration 056

### `trading_references` — 매매 참고자료
Migration 057

### `failure_patterns` — 실패 패턴 분석
Migration 074

### `broker_research_notes` — 증권사 리서치
Migration 086

### `overseas_prices` — 해외가격 캐시
Migration 011

### `schema_migrations` — 마이그레이션 추적
System table

---

## DROPPED Tables

| Table | Migration | Reason |
|-------|-----------|--------|
| futures_positions | 080 | 선물 기능 제거 |
| futures_trades | 080 | 선물 기능 제거 |
| futures_budget | 080 | 선물 기능 제거 |
| profit_withdraw_config | 095 | 코드 참조 0 |

---

## In-Memory Stores (서버 재시작 시 소실)

| Store | Location | TTL | Mode분리 |
|-------|----------|-----|---------|
| Dashboard cache | dashboard-cache.ts | 30s~3min | ✅ |
| Overseas scores | overseas-scores.ts | 30min | ✅ |
| Price cache | memory.ts | 15s | ❌ |
| Redis AI scores | redis.ts | 3h | ❌ ⚠️ |
| Buy intents | buy-intent.ts | - | ✅ |
| Sell cooldown | sell-cooldown.ts | - | ✅ |
| Ghost debounce | fill-reconciler.ts | - | N/A |
| Greedy streak | external-signals.ts | - | ❌ |
| Pipeline locks | lock.ts | - | N/A |
| AllocRisk cache | alloc-risk-cache.ts | 5min | ✅ |

---

## ⚠️ 전수조사 불일치 보고서 (2026-07-01)

### CRITICAL — 런타임 SQL 에러 발생 가능

| # | 파일 | 이슈 | 영향 |
|---|------|------|------|
| C1 | `sell-signals.ts:239` | `UPDATE transaction_chains SET updated_at = NOW()` — **`updated_at` 컬럼이 transaction_chains에 없음** (orders에만 있음) | SQL 에러 → 손절 실패 가능 |
| C2 | `partial-tp.ts:89,101` | `SELECT/UPDATE transaction_chains.metadata` — **`metadata JSONB` 컬럼 DDL 없음** (어떤 migration에도 ADD COLUMN 안 됨) | 분할익절 SQL 에러 |
| C3 | `migration 070` | `COALESCE(notes, '') || ...` on transaction_chains — **`notes` 컬럼 DDL 없음** | 마이그레이션 실행 시 에러 (이미 적용됐으면 무시) |

### HIGH — 타입/CHECK 불일치

| # | 위치 | 이슈 | 영향 |
|---|------|------|------|
| H1 | `models.ts:OrderSchema` | Zod `status`: `FAILED` 포함 → DDL CHECK 098: `REJECTED/EXPIRED` 있고 `FAILED` 없음 | `FAILED` INSERT 시 CHECK 위반 에러 |
| H2 | `models.ts:TransactionChainSchema` | `escape_target_price` 필드 누락 — DDL에 있고 코드에서 사용하지만 Zod 미정의 | 타입 안전성 없음, `as any` 우회 필요 |
| H3 | `DATABASE_SCHEMA.md` (이전) | strategy_mode 값이 `SWING/MOMENTUM/SCALP` — 실제는 SWING/DEFENSE/SCALPING/DIVIDEND/SNIPER/BOTTOM_FISHING/EOD_BETTING/BREAKOUT | 문서 오류 (수정 완료) |
| H4 | `DATABASE_SCHEMA.md` (이전) | stock_code `VARCHAR(6)` 표기 — 실제 migration 019에서 `VARCHAR(10)` 확장 | 문서 오류 (수정 완료) |

### MEDIUM — 코드 불일치

| # | 위치 | 이슈 | 위험 |
|---|------|------|------|
| M1 | `chains.ts:CHAIN_ALLOWED_COLS` | `escape_target_price` 누락 — `updateChain()` 호출 시 silent drop | raw SQL 우회 중이라 현재 안전 |
| M2 | `chains.ts:CHAIN_ALLOWED_COLS` | `stock_name` 누락 — migration 104에서 추가했지만 updateChain 불가 | raw SQL 우회 중이라 현재 안전 |
| M3 | `chains.ts:createChain` | `peak_price`, `peak_price_since_open`, `pnl_pct`, `sell_reason` INSERT 불가 | 신규 체인에는 불필요하지만 TypeScript 타입이 허용하는 점 모호 |
| M4 | `scan-logger.ts:ScanSessionInput` | `adamKhooBullish`, `adamKhooBelowMa200` 수집하지만 DB에 저장 안 함 | 데드 필드 |

### LOW — Frontend 타입 불일치

| # | 위치 | 이슈 |
|---|------|------|
| L1 | `frontend/types/trading.ts:Trade` | `status`에 `PARTIAL` 없음 (DDL/Zod에는 있음) |
| L2 | `frontend/types/overseas.ts:UsHolding` | `trail_pct`, `trail_active`, `trail_stop_pct`, `max_pnl_pct`, `partial_tp_stage`, `next_partial_tp_pct`, `sector` — DDL에 없는 필드들 (API 계산값이면 OK) |
| L3 | `frontend/types/dashboard.ts:WatchlistItem` | `last_sell_at`, `last_sell_pct`, `last_sell_price` — DDL에 없음 (API 계산값) |
| L4 | `frontend/types/trading.ts:Trade` | `realized_pnl_pct`, `realized_pnl_usd` — orders DDL에 없음 (API JOIN 계산값) |
