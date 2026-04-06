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

  // 2. 초기 전략 설정 (SWING 모드)
  await client.query(`UPDATE strategy_config SET is_active = false WHERE is_active = true`);
  await client.query(
    `INSERT INTO strategy_config (mode, is_active, gemini_prompt, gpt_prompt, claude_prompt, buy_threshold, stop_loss_pct, take_profit_pct)
     VALUES ($1, true, $2, $3, $4, $5, $6, $7)`,
    [
      'SWING',
      // Gemini 프롬프트 (Step 1: 정보 수집)
      `입력된 소스들을 교차 검증하여 아래 양식의 보고서로 가공해.
1. [메가 트렌드]: 현재 시장의 주도 테마 1줄 요약
2. [팩트 체크]: 감정적 발언은 배제하고 객관적 수치(목표가, 영업이익률)만 추출
3. [호재/악재]: 종목별 노이즈 제거한 명확한 호재/악재 불릿 포인트
4. [데이터 신뢰도]: 교차 검증된 내용일수록 High/Med/Low 등급 부여
5. [수급 동향]: 외국인/기관 매매 동향 3일 기준 정리`,
      // GPT 프롬프트 (Step 2: 스코어링)
      `제미나이 보고서 기반으로 각 종목을 0~100점으로 평가해.
1. 외국인/기관 수급이 3일 연속 순매수면 +15점 가산
2. 최근 가격이 3% 이상 하락했지만 보고서상 악재 없으면 '눌림목'으로 +10점
3. 52주 신고가 근처(5% 이내)면 모멘텀 +10점
4. 부채비율 200% 이상이면 -20점 감점
5. PER 업종평균 대비 30% 이상 고평가면 -15점
6. 점수 75점 이상만 매수 후보로 분류`,
      // Claude 프롬프트 (Step 3: 매매 실행)
      `GPT 점수가 75점 이상이면 매수 주문을 넣어.
1. 예산은 무조건 3번에 나눠서 1차, 2차, 3차로 분할 매수
2. 1차 매수 후 -3% 하락 시 2차 물타기, 또 -3% 하락 시 3차
3. 전체 수익 +8% 도달 시 50% 익절 (절반 수익 확정)
4. -5% 손실 또는 3일 경과 시 전량 손절
5. 같은 종목 중복 매수 금지 (이미 포지션 있으면 스킵)
6. 일일 최대 손실 한도 초과 시 당일 매매 중단`,
      75,   // buy_threshold
      -5.0, // stop_loss_pct
      8.0,  // take_profit_pct
    ]
  );
  console.log('✅ SWING 전략 설정 완료');

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
