# Database Master Schema — ai-auto-bot (QuantOps)

> Auto-generated: 2026-06-20 | PostgreSQL 44 tables | 91 migrations

## Core Trading Tables

### `transaction_chains` — 매매 체인 (매수→물타기→매도 그룹)
| Column | Type | Default | Note |
|--------|------|---------|------|
| id | UUID | PK gen_random_uuid() | |
| stock_code | VARCHAR(6) | FK watchlist | |
| status | VARCHAR(20) | 'OPEN' | OPEN/AVERAGING/PROFIT_TAKING/CLOSED |
| strategy_mode | VARCHAR(15) | 'SWING' | SWING/MOMENTUM/SCALP |
| avg_buy_price | DECIMAL(12,2) | 0 | 수수료 포함 평균단가 |
| total_quantity | INTEGER | 0 | |
| total_invested | DECIMAL(15,2) | 0 | |
| realized_pnl | DECIMAL(15,2) | 0 | |
| target_profit_pct | DECIMAL(5,2) | 4.0 | |
| stop_loss_pct | DECIMAL(5,2) | -3.0 | |
| max_averaging_count | INTEGER | 3 | |
| current_averaging_count | INTEGER | 0 | |
| peak_price | NUMERIC | | 트레일링 스탑용 |
| escape_target_price | NUMERIC(18,4) | NULL | |
| is_paper | BOOLEAN | true | |
| pnl_pct | DECIMAL(8,4) | | |
| sell_reason | VARCHAR(50) | | |
| opened_at | TIMESTAMPTZ | NOW() | |
| closed_at | TIMESTAMPTZ | | |
| close_reason | TEXT | | |

**UNIQUE**: (stock_code, is_paper) WHERE status IN ('OPEN','AVERAGING','PROFIT_TAKING')

### `orders` — 개별 주문 기록
| Column | Type | Default | Note |
|--------|------|---------|------|
| id | UUID | PK | |
| chain_id | UUID | FK chains | NULL for overseas |
| stock_code | VARCHAR(6) | | |
| side | VARCHAR(4) | | BUY/SELL |
| order_type | VARCHAR(10) | | MARKET/LIMIT |
| quantity | INTEGER | | |
| price | DECIMAL(12,2) | | |
| kis_order_no | VARCHAR(100) | | |
| kis_status | VARCHAR(20) | | FILLED/UNCONFIRMED/... |
| filled_quantity | INTEGER | 0 | |
| filled_price | DECIMAL(12,2) | | |
| status | VARCHAR(20) | 'PENDING' | PENDING/FILLED/PARTIAL/FAILED/CANCELLED |
| trading_mode | VARCHAR(10) | | paper/live/p_arch |
| trigger_source | VARCHAR(20) | | TRACK_B/OVERSEAS/EXTERNAL |
| ai_reasoning | TEXT | | |
| avg_buy_price | NUMERIC | | |
| is_paper | BOOLEAN | GENERATED | (trading_mode IN ('paper','p_arch')) |
| created_at | TIMESTAMPTZ | NOW() | |

### `overseas_holdings` — 해외주식 보유
| Column | Type | Default | Note |
|--------|------|---------|------|
| stock_code | TEXT | | |
| exchange | TEXT | 'NASDAQ' | |
| quantity | NUMERIC | 0 | |
| avg_price | NUMERIC | 0 | |
| last_price | NUMERIC | 0 | |
| is_paper | BOOLEAN | true | |
| tp_pct / sl_pct | NUMERIC | NULL | 동적 TP/SL |
| strategy_bucket | TEXT | 'SWING' | |

**PK**: (exchange, stock_code, is_paper)

### `overseas_state` — 해외매매 상태 K/V
| Column | Type | Note |
|--------|------|------|
| key | TEXT | PK — cash, cash_paper, maxprice_*, dip_buy_* |
| value | TEXT | |
| updated_at | TIMESTAMPTZ | trigger auto-update |

## Portfolio & Risk

### `portfolio_snapshots` — 포트폴리오 스냅샷
| Column | Type | Note |
|--------|------|------|
| total_value | DECIMAL(15,2) | |
| cash_balance | DECIMAL(15,2) | |
| unrealized_pnl | DECIMAL(15,2) | 미실현 손익 |
| daily_pnl | DECIMAL(15,2) | |
| daily_pnl_pct | DECIMAL(5,2) | |
| positions | JSONB | |
| is_paper | BOOLEAN | |
| snapshot_at | TIMESTAMPTZ | |

### `score_accuracy` — AI 예측 정확도
| Column | Type | Note |
|--------|------|------|
| entry_score | SMALLINT | 매수 시 AI 점수 |
| realized_pnl_pct | DECIMAL(8,4) | |
| outcome | VARCHAR(10) | WIN/LOSS/BREAK_EVEN |
| holding_days | SMALLINT | |
| market | VARCHAR(2) | KR/US |
| is_paper | BOOLEAN | |

## AI & Strategy

### `ai_scores` — Track A AI 점수
| Column | Type | Note |
|--------|------|------|
| stock_code | VARCHAR(6) | |
| score_date | DATE | |
| composite_score | DECIMAL(5,2) | 종합 점수 0~99 |
| fundamental/technical/sentiment_score | DECIMAL(5,2) | |
| confidence | DECIMAL(3,2) | |
| signal | VARCHAR(15) | BUY/SELL/HOLD |
| target_price | INTEGER | |
| stop_loss_price | INTEGER | |

**UNIQUE**: (stock_code, score_date)

### `watchlist` — 감시 종목
| Column | Type | Note |
|--------|------|------|
| stock_code | VARCHAR(10) | UNIQUE |
| stock_name | VARCHAR(100) | |
| market | VARCHAR(10) | KOSPI/KOSDAQ |
| source | VARCHAR(30) | MANUAL/KIS_SYNC/AUTO |
| is_active | BOOLEAN | |

### `strategy_config` — 전략 설정
| Column | Type | Note |
|--------|------|------|
| mode | VARCHAR(15) | SWING/MOMENTUM/SCALP |
| buy_threshold | INTEGER | 75 |
| stop_loss_pct | DECIMAL(5,2) | -5.0 |
| take_profit_pct | DECIMAL(5,2) | 8.0 |
| ai_scoring_mode | VARCHAR(20) | fallback/ensemble |
| is_paper | BOOLEAN | |

### `portfolio_allocation_config` — 자산배분 설정
| Column | Type | Note |
|--------|------|------|
| kr_pct / us_pct | NUMERIC | 국내/해외 비율 |
| position_cap_pct | NUMERIC(5,2) | 25 — 종목당 최대 |
| max_invested_pct | NUMERIC(5,2) | 88 — 최대 투자비율 |
| cash_reserve_pct | NUMERIC(5,2) | 20 — 현금 보존 |
| max_positions | INT | 8 |
| max_daily_trades | INT | 3 |
| is_paper | BOOLEAN | |

## System & Config

### `system_state` — 시스템 상태 K/V
PK: key TEXT | value TEXT — Kill switch, 프로세스 플래그

### `feature_flags` — 기능 플래그
PK: key TEXT | enabled BOOLEAN | config JSONB

### `ai_overrides` — AI 파라미터 오버라이드
UNIQUE: (key, is_paper) | expires_at TIMESTAMPTZ

### `ai_token_usage` — AI 토큰 비용 추적
provider/model/input_tokens/output_tokens/cost_usd/label/is_paper

## Logging & Analytics

| Table | Purpose |
|-------|---------|
| `system_log` | AI 결정 감사 추적 |
| `risk_events` | 킬스위치/한도 위반 이벤트 |
| `scan_sessions` | Track B 파이프라인 실행 로그 |
| `scan_stock_decisions` | Track B 종목별 AI 결정 |
| `loop_sessions` / `loop_ticks` | 루프 모드 세션 추적 |
| `ai_scores_history` | AI 점수 시계열 |
| `ai_command_log` | AI 커맨드 감사 로그 |
| `capture_snapshots` | 진단 캡처 (Copilot 점수) |
| `shadow_trades` | OOS 검증용 가상 매매 |

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
