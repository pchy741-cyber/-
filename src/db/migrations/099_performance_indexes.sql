-- 099: 성능 인덱스 추가 (v10.10.5c QA 전수조사)
-- system_log: 8+ 라우트에서 ORDER BY timestamp DESC 사용, 인덱스 없음
-- orders: 해외 수익 통계 쿼리 최적화 (profit-stats, builder realized PnL)

-- system_log: 타임스탬프 기준 조회 (dashboard, qa-watchdog, daily-report 등)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_system_log_ts
  ON system_log(timestamp DESC);

-- system_log: 컴포넌트별 필터 + 시간순 (system-log.ts, strategy mode history)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_system_log_component_ts
  ON system_log(component, timestamp DESC);

-- orders: 해외 SELL 주문 PnL 집계 (profit-stats.ts, builder.ts realized PnL)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_overseas_sell_dated
  ON orders(is_paper, created_at DESC)
  WHERE trigger_source = 'OVERSEAS' AND status = 'FILLED' AND side = 'SELL';

-- portfolio_snapshots: total_value > 0 필터 포함 (builder.ts 전일 스냅샷 조회)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_active
  ON portfolio_snapshots(is_paper, snapshot_at DESC)
  WHERE total_value > 0;
