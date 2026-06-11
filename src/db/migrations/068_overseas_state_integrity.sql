-- 데이터 마스터 정합성 검수: overseas_state 현금 키 무결성 보장
-- 목적: overseas_state.cash(live) / overseas_state.cash_paper(paper) 누락 시 0으로 초기화
--       builder.ts safeOverseasCashKrw 계산의 NaN 방지

-- overseas_state 테이블이 없으면 생성 (최초 배포 환경 대비)
CREATE TABLE IF NOT EXISTS overseas_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '0'
);

-- live 현금 키 초기화 (없을 때만)
INSERT INTO overseas_state (key, value)
VALUES ('cash', '0')
ON CONFLICT (key) DO NOTHING;

-- paper 현금 키 초기화 (없을 때만)
INSERT INTO overseas_state (key, value)
VALUES ('cash_paper', '0')
ON CONFLICT (key) DO NOTHING;

-- 비정상 값(빈 문자열, 'null', 'NaN') → '0' 으로 정규화
UPDATE overseas_state
SET value = '0'
WHERE key IN ('cash', 'cash_paper')
  AND (value = '' OR value = 'null' OR value = 'NaN' OR value IS NULL);
