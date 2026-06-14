-- 033_fix_overseas_data_integrity.sql
-- 해외주식 paper/live 데이터 오염 수정
-- 원인: overseas-job.ts와 overseas.ts에서 is_paper=false 하드코딩 + cash 키 혼용
-- 결과: paper 모드 해외 현금이 live 'cash' 키에 기록, paper 보유종목이 is_paper=false로 저장

-- ══════════════════════════════════════════
-- STEP 1: 진단 로그 (실행 전 상태 기록)
-- ══════════════════════════════════════════

-- 진단용 temp 테이블 (마이그레이션 후 자동 삭제됨)
DO $$
DECLARE
  v_cash_val TEXT;
  v_cash_paper_val TEXT;
  v_live_overseas_buys INT;
  v_live_holdings INT;
  v_paper_holdings INT;
BEGIN
  -- 현재 overseas_state 값
  SELECT value INTO v_cash_val FROM overseas_state WHERE key = 'cash';
  SELECT value INTO v_cash_paper_val FROM overseas_state WHERE key = 'cash_paper';
  -- live 해외 매수 이력 수
  SELECT COUNT(*) INTO v_live_overseas_buys FROM orders WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED';
  -- 보유종목 수
  SELECT COUNT(*) INTO v_live_holdings FROM overseas_holdings WHERE is_paper = false AND quantity > 0;
  SELECT COUNT(*) INTO v_paper_holdings FROM overseas_holdings WHERE is_paper = true AND quantity > 0;

  RAISE NOTICE '[진단] cash=%, cash_paper=%, live매수=%, live보유=%, paper보유=%',
    COALESCE(v_cash_val, 'NULL'), COALESCE(v_cash_paper_val, 'NULL'),
    v_live_overseas_buys, v_live_holdings, v_paper_holdings;
END $$;

-- ══════════════════════════════════════════
-- STEP 2: overseas_state cash 키 오염 수정
-- 조건: live 해외매수 이력이 없는데 cash 키에 값이 있으면 → paper 현금이 오염된 것
-- ══════════════════════════════════════════

-- 2a. cash_paper 키가 없으면 cash 값을 cash_paper로 이동
INSERT INTO overseas_state (key, value)
SELECT 'cash_paper', os.value
FROM overseas_state os
WHERE os.key = 'cash'
  AND NOT EXISTS (SELECT 1 FROM overseas_state WHERE key = 'cash_paper')
  AND NOT EXISTS (SELECT 1 FROM orders WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED')
ON CONFLICT (key) DO NOTHING;

-- 2b. cash_paper 키가 이미 있으면 cash 값과 비교하여 더 합리적인 값 사용
-- (orders 기반 계산: seed - BUY + SELL)
-- 이 경우 cash_paper가 이미 정확하므로 cash만 0으로 리셋

-- 2c. live 해외매수 이력 없으면 cash를 0으로 리셋 (실전에 해외투자 안 했으므로)
UPDATE overseas_state SET value = '0'
WHERE key = 'cash'
  AND NOT EXISTS (SELECT 1 FROM orders WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED');

-- ══════════════════════════════════════════
-- STEP 3: overseas_holdings is_paper 교정
-- 조건: live 보유종목이 있는데 live 매수 이력이 없으면 → paper 종목이 잘못 기록된 것
-- ══════════════════════════════════════════

-- 3a. live 매수 이력 없는 종목을 paper로 교정
-- (unique constraint (exchange, stock_code, is_paper) 충돌 가능 → paper에 이미 있으면 live를 삭제)
-- 먼저 paper에 이미 동일 종목이 있는 경우: live의 수량을 paper에 합산
UPDATE overseas_holdings oh_paper
SET quantity = oh_paper.quantity + oh_live.quantity,
    avg_price = CASE
      WHEN (oh_paper.quantity + oh_live.quantity) > 0
      THEN (oh_paper.avg_price * oh_paper.quantity + oh_live.avg_price * oh_live.quantity) / (oh_paper.quantity + oh_live.quantity)
      ELSE oh_paper.avg_price
    END
FROM overseas_holdings oh_live
WHERE oh_paper.exchange = oh_live.exchange
  AND oh_paper.stock_code = oh_live.stock_code
  AND oh_paper.is_paper = true
  AND oh_live.is_paper = false
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED'
      AND stock_code = oh_live.stock_code
  );

-- 합산 완료된 live 레코드 삭제 (paper에 이미 존재했던 경우)
DELETE FROM overseas_holdings oh_live
WHERE oh_live.is_paper = false
  AND EXISTS (
    SELECT 1 FROM overseas_holdings oh_paper
    WHERE oh_paper.exchange = oh_live.exchange
      AND oh_paper.stock_code = oh_live.stock_code
      AND oh_paper.is_paper = true
  )
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED'
      AND stock_code = oh_live.stock_code
  );

-- paper에 없었던 경우: is_paper를 true로 교정
UPDATE overseas_holdings
SET is_paper = true
WHERE is_paper = false
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'live' AND side = 'BUY' AND status = 'FILLED'
      AND stock_code = overseas_holdings.stock_code
  );

-- ══════════════════════════════════════════
-- STEP 4: orders 테이블 trading_mode 교정 (해외)
-- 서버가 paper 모드인데 해외 주문이 live로 기록된 케이스
-- 판단: KIS 실주문번호 패턴이 아닌(VSP, CLN, POS 등 가짜번호) live 주문 → paper로 교정
-- ══════════════════════════════════════════

UPDATE orders
SET trading_mode = 'paper'
WHERE trigger_source = 'OVERSEAS'
  AND trading_mode = 'live'
  AND (kis_order_no LIKE 'VSP%' OR kis_order_no LIKE 'CLN%' OR kis_order_no LIKE 'POS%' OR kis_order_no LIKE 'PAPER%');

-- ══════════════════════════════════════════
-- STEP 5: cash_paper 값 재계산 (orders 기반, 레거시)
-- 현재는 computePaperCash()가 PAPER_OVERSEAS_SEED_KRW 환산으로 동적 계산
-- ══════════════════════════════════════════

DO $$
DECLARE
  v_buy_total NUMERIC := 0;
  v_sell_total NUMERIC := 0;
  v_expected_cash NUMERIC;
  v_current_cash TEXT;
  v_holding_cost NUMERIC := 0;
BEGIN
  -- paper 해외 매수 합산
  SELECT COALESCE(SUM(COALESCE(filled_price, price) * quantity), 0)
  INTO v_buy_total
  FROM orders WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'paper' AND side = 'BUY' AND status = 'FILLED';

  -- paper 해외 매도 합산
  SELECT COALESCE(SUM(COALESCE(filled_price, price) * quantity), 0)
  INTO v_sell_total
  FROM orders WHERE trigger_source = 'OVERSEAS' AND trading_mode = 'paper' AND side = 'SELL' AND status = 'FILLED';

  -- 기대 현금: 레거시 시드 - 매수총액 + 매도총액 (이 마이그레이션은 1회 실행됨)
  v_expected_cash := 10000 - v_buy_total + v_sell_total;

  -- 현재 cash_paper 값
  SELECT value INTO v_current_cash FROM overseas_state WHERE key = 'cash_paper';

  -- 현재 보유종목 원가
  SELECT COALESCE(SUM(avg_price * quantity), 0) INTO v_holding_cost
  FROM overseas_holdings WHERE is_paper = true AND quantity > 0;

  RAISE NOTICE '[cash_paper 검증] 매수합=$%, 매도합=$%, 기대현금=$%, 현재DB=%, 보유원가=$%, 기대총자산=$%',
    v_buy_total, v_sell_total, v_expected_cash, COALESCE(v_current_cash, 'NULL'), v_holding_cost, v_expected_cash + v_holding_cost;

  -- cash_paper 값이 크게 다르면(10% 이상) 주문 기반으로 재설정
  -- (미세한 차이는 fillPrice 차이 등으로 정상)
  IF v_current_cash IS NULL OR ABS(v_expected_cash - CAST(v_current_cash AS NUMERIC)) > v_expected_cash * 0.1 THEN
    INSERT INTO overseas_state (key, value) VALUES ('cash_paper', v_expected_cash::TEXT)
    ON CONFLICT (key) DO UPDATE SET value = v_expected_cash::TEXT;
    RAISE NOTICE '[cash_paper 교정] % → %', COALESCE(v_current_cash, 'NULL'), v_expected_cash;
  ELSE
    RAISE NOTICE '[cash_paper 정상] 현재값 유지 (차이 허용범위 이내)';
  END IF;
END $$;

-- ══════════════════════════════════════════
-- STEP 6: 사후 검증
-- ══════════════════════════════════════════

DO $$
DECLARE
  v_cash TEXT;
  v_cash_paper TEXT;
  v_live_h INT;
  v_paper_h INT;
BEGIN
  SELECT value INTO v_cash FROM overseas_state WHERE key = 'cash';
  SELECT value INTO v_cash_paper FROM overseas_state WHERE key = 'cash_paper';
  SELECT COUNT(*) INTO v_live_h FROM overseas_holdings WHERE is_paper = false AND quantity > 0;
  SELECT COUNT(*) INTO v_paper_h FROM overseas_holdings WHERE is_paper = true AND quantity > 0;

  RAISE NOTICE '[수정후] cash=%, cash_paper=%, live보유=%, paper보유=%',
    COALESCE(v_cash, 'NULL'), COALESCE(v_cash_paper, 'NULL'), v_live_h, v_paper_h;
END $$;
