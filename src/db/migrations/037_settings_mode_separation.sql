-- 037: Paper/Live 설정 완전 분리
-- strategy_config, portfolio_allocation_config, learned_insights에 is_paper 컬럼 추가
-- 기존 행은 모두 live(is_paper=false)로 유지, paper 복사본 생성

ALTER TABLE strategy_config
  ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE portfolio_allocation_config
  ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE learned_insights
  ADD COLUMN IF NOT EXISTS is_paper BOOLEAN NOT NULL DEFAULT false;

-- 활성 live 전략을 paper 전략으로 복사 (paper 행이 없는 경우에만)
WITH live_strategy AS (
  SELECT * FROM strategy_config
  WHERE is_active = true AND is_paper = false
  ORDER BY updated_at DESC LIMIT 1
)
INSERT INTO strategy_config
  (mode, is_active, notebooklm_prompt, gemini_prompt, gpt_prompt, claude_prompt,
   buy_threshold, stop_loss_pct, take_profit_pct, strategy_document, risk_prompt, is_paper)
SELECT mode, is_active, notebooklm_prompt, gemini_prompt, gpt_prompt, claude_prompt,
       buy_threshold, stop_loss_pct, take_profit_pct, strategy_document, risk_prompt, true
FROM live_strategy
WHERE NOT EXISTS (SELECT 1 FROM strategy_config WHERE is_paper = true AND is_active = true);

-- live portfolio_allocation_config를 paper로 복사 (paper 행이 없는 경우에만)
WITH live_alloc AS (
  SELECT * FROM portfolio_allocation_config
  WHERE is_paper = false
  ORDER BY id DESC LIMIT 1
)
INSERT INTO portfolio_allocation_config
  (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc,
   trailing_stop_pct, is_paper)
SELECT kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense, sector_finance, sector_etc,
       trailing_stop_pct, true
FROM live_alloc
WHERE NOT EXISTS (SELECT 1 FROM portfolio_allocation_config WHERE is_paper = true);
