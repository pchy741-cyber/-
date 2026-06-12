-- 076: 해외 주문 paper/live 크로스 오염 정리
-- 원인: baseIsPaper 버그로 paper 루프/수동매수가 trading_mode='live'로 기록됨
-- 기준: kis_order_no가 숫자로 시작하는 것만 진짜 KIS 실전 주문

-- 1) OVERSEAS 주문 중 가짜 KIS 주문번호(MANUAL_*, VSP*, CLN* 등) → paper로 전환
UPDATE orders
SET trading_mode = 'paper'
WHERE trigger_source = 'OVERSEAS'
  AND trading_mode = 'live'
  AND (
    kis_order_no IS NULL
    OR kis_order_no = ''
    OR kis_order_no !~ '^[0-9]'
  );

-- 2) overseas_holdings: is_paper 확인 (현재 live=0종목이면 문제 없지만 안전장치)
-- RTX 1주는 진짜 KIS 매수이므로 live 유지
-- 나머지 is_paper=false인데 KIS에 없는 종목 → paper로 전환
-- (RTX는 방금 실제 매수됐으므로 제외)
UPDATE overseas_holdings
SET is_paper = true
WHERE is_paper = false
  AND stock_code NOT IN (
    SELECT DISTINCT stock_code FROM orders
    WHERE trigger_source = 'OVERSEAS'
      AND trading_mode = 'live'
      AND kis_order_no ~ '^[0-9]'
      AND side = 'BUY'
      AND created_at > NOW() - INTERVAL '7 days'
  );
