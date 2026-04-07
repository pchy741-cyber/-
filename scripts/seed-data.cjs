const { Client } = require('pg');

const client = new Client({
  host: '34.64.217.165',
  port: 5432,
  database: 'quantops',
  user: 'postgres',
  password: 'Quantops2026!Secure',
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  console.log('Connected!');

  // 1. 감시 목록 — 실적 탄탄한 대형주 위주
  const watchlist = [
    ['005930', '삼성전자', 'KOSPI'],
    ['000660', 'SK하이닉스', 'KOSPI'],
    ['373220', 'LG에너지솔루션', 'KOSPI'],
    ['005380', '현대자동차', 'KOSPI'],
    ['009540', 'HD한국조선해양', 'KOSPI'],
    ['035420', 'NAVER', 'KOSPI'],
    ['035720', '카카오', 'KOSPI'],
    ['006400', '삼성SDI', 'KOSPI'],
    ['051910', 'LG화학', 'KOSPI'],
    ['003670', '포스코퓨처엠', 'KOSPI'],
  ];

  for (const [code, name, market] of watchlist) {
    await client.query(
      `INSERT INTO watchlist (stock_code, stock_name, market, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (stock_code) DO UPDATE SET stock_name = $2, market = $3, is_active = true`,
      [code, name, market]
    );
  }
  console.log(`✅ 감시 목록 ${watchlist.length}개 종목 추가`);

  // 2. 초기 전략 설정 (SCALPING 모드 — 단타 풀투자)
  await client.query(`ALTER TABLE strategy_config ADD COLUMN IF NOT EXISTS notebooklm_prompt TEXT DEFAULT ''`).catch(() => {});
  await client.query(`UPDATE strategy_config SET is_active = false WHERE is_active = true`);
  await client.query(
    `INSERT INTO strategy_config (mode, is_active, notebooklm_prompt, gemini_prompt, gpt_prompt, claude_prompt, buy_threshold, stop_loss_pct, take_profit_pct)
     VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8)`,
    [
      'SCALPING',
      // NotebookLM 프롬프트 (Step 1: 소스 수집 — 사용자가 직접 붙여넣기)
      '',
      // Gemini 프롬프트 (Step 2: 팩트 기반 분석 리포트)
      `## Gemini 분석 리포트 생성 (팩트 기반 가공)

### 역할
NotebookLM 소스 + 실시간 시장 데이터를 교차 검증하여 객관적 분석 리포트를 생성한다.

### 출력 양식 (종목별 반복)
1. [종목명/코드] — 한 줄 요약
2. [수급 현황]
   - 외국인 3일 누적 순매수/순매도 금액
   - 기관 3일 누적 순매수/순매도 금액
   - 프로그램 매매 동향
3. [기술적 위치]
   - 현재가 vs 5일/20일/60일 이동평균선 괴리율
   - RSI(14), MACD 시그널, 볼린저밴드 위치
   - 당일 거래량 vs 20일 평균 거래량 비율
4. [펀더멘탈 체크]
   - 최근 분기 영업이익 YoY 변화율
   - PER/PBR 업종 평균 대비 위치
   - 부채비율, 유동비율
5. [이벤트/카탈리스트]
   - 실적 발표일, 배당 기준일 등 예정 이벤트
   - 뉴스/공시 중 주가 영향 가능한 팩트만 추출 (감정적 의견 배제)
6. [데이터 신뢰도]: High(교차검증 완료) / Med(단일소스) / Low(미확인)

### 제외 규칙
- 시가총액 3,000억 미만 소형주: 분석 제외
- 관리종목, 투자주의, 거래정지 종목: 즉시 제외
- 최근 5일 내 상한가/하한가 기록 종목: 제외 (변동성 과다)`,

      // GPT 프롬프트 (Step 3: 0~100점 스코어링)
      `## GPT 스코어링 엔진 (종목별 0~100점)

### 역할
Gemini 분석 리포트를 입력받아 각 종목에 대해 정량적 점수를 산출한다.

### 기본 점수 체계 (Base: 50점)

#### 수급 점수 (최대 ±25점)
- 외국인+기관 동시 3일 연속 순매수: +20점
- 외국인 또는 기관 단독 3일 순매수: +12점
- 외국인+기관 동시 순매도: -20점
- 프로그램 매수 동반 시: 추가 +5점

#### 기술적 점수 (최대 ±20점)
- 20일선 위에서 눌림목 (현재가가 20일선 대비 -1%~+3%): +15점
- RSI 30 이하 과매도 + 거래량 증가: +10점
- RSI 70 이상 과매수: -10점
- MACD 골든크로스 3일 이내: +8점
- 볼린저밴드 하단 이탈 후 복귀: +7점
- 거래량 20일 평균 200% 이상 급증 (호재 없이): -15점 (작전주 의심)

#### 펀더멘탈 점수 (최대 ±15점)
- 영업이익 QoQ +10% 이상 성장: +10점
- 영업이익 적자전환: -15점
- PER 업종평균 대비 30% 이상 고평가: -10점
- 부채비율 200% 초과: -10점

#### 이벤트 보정 (±10점)
- 실적 발표 3일 이내: -5점 (불확실성)
- 자사주 매입 공시: +8점
- 유상증자/CB 발행 공시: -10점

### 출력 형식
| 종목코드 | 종목명 | 총점 | 수급 | 기술 | 펀더 | 이벤트 | 판정 |
판정: 90+ → STRONG_BUY, 75~89 → BUY, 60~74 → WATCH, 60 미만 → SKIP`,

      // Claude 프롬프트 (Step 4: 매매 실행 판단)
      `## Claude 매매 실행 엔진

### 역할
GPT 스코어 + 실시간 호가/시세 데이터를 종합하여 BUY/SELL/HOLD 최종 결정 및 주문 수량을 계산한다.

### 매수 규칙
1. GPT 점수 ≥ buy_threshold인 종목만 매수 대상
2. STRONG_BUY(90+): 가용 현금의 40%까지 단일 종목 투입 가능
3. BUY(75~89): 가용 현금의 20%까지 단일 종목 투입
4. 동일 종목 기존 포지션 보유 시: 신규 매수 금지 (물타기 조건 충족 시에만 추가 매수)
5. 매수 호가 스프레드가 0.5% 이상이면 매수 보류 (유동성 부족)
6. 장 시작 15분(09:00~09:15) 신규 매수 금지 (변동성 과다)

### 매도 규칙
1. 손절: 평균 매수가 대비 stop_loss_pct 도달 시 전량 시장가 매도 (예외 없음)
2. 익절: 평균 매수가 대비 take_profit_pct 도달 시 보유량의 50% 매도, 나머지는 트레일링 스탑(고점 대비 -2%)
3. 시간 손절: 매수 후 3거래일 경과 시 수익/손실 무관하게 전량 매도
4. 긴급 매도: 종목 거래정지 예고, 대규모 블록딜 공시 시 즉시 매도

### SCALPING 모드 특수 규칙
- 90점 이상 즉시 풀매수 (분할 매수 없음)
- 목표 수익 +3% 도달 시 전량 즉시 익절
- 당일 15:20까지 미청산 포지션 전량 시장가 매도 (당일 청산 원칙)
- -2% 손절 엄격 적용 (스윙 대비 타이트)

### 리스크 관리
- 일일 최대 손실 -3% 도달 시 당일 신규 매수 전면 중단
- 동시 보유 종목 수 최대 3개
- 총 투자금 대비 단일 종목 비중 50% 초과 금지
- 킬스위치 발동 시 모든 매매 즉시 중단

### 주문 실행
- 매수: 현재가 지정가 주문 (시장가 사용 금지)
- 매도(손절): 시장가 주문 (신속 체결 우선)
- 매도(익절): 지정가 주문
- 미체결 주문 30분 경과 시 자동 취소 후 재평가`,

      60,   // buy_threshold (적극적)
      -2.0, // stop_loss_pct (단타 타이트)
      3.0,  // take_profit_pct (빠른 익절)
    ]
  );
  console.log('✅ SCALPING 전략 설정 완료');

  // 3. 초기 포트폴리오 스냅샷 (모의투자 1,000만원)
  await client.query(
    `INSERT INTO portfolio_snapshots (total_value, cash_balance, invested_value, unrealized_pnl, daily_pnl, daily_pnl_pct, positions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [10000000, 10000000, 0, 0, 0, 0, JSON.stringify([])]
  );
  console.log('✅ 초기 포트폴리오 스냅샷 생성 (1,000만원)');

  // 확인
  const { rows: wl } = await client.query('SELECT stock_code, stock_name FROM watchlist WHERE is_active = true');
  console.log('\n📋 감시 목록:');
  wl.forEach(r => console.log(`  - ${r.stock_name} (${r.stock_code})`));

  const { rows: sc } = await client.query('SELECT mode, buy_threshold, stop_loss_pct, take_profit_pct FROM strategy_config WHERE is_active = true');
  console.log('\n⚙️ 전략 설정:', sc[0]);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
