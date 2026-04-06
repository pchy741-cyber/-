/**
 * KIS 모의투자 API 연결 테스트
 * 실행: npx tsx scripts/test-kis-connection.ts
 */
import { config } from '../src/config/index.js';

const BASE_URL = config.kis.baseUrl;

console.log('========================================');
console.log('KIS API 연결 테스트');
console.log('========================================');
console.log(`모드: ${config.tradingMode}`);
console.log(`URL: ${BASE_URL}`);
console.log(`APP_KEY: ${config.kis.appKey ? config.kis.appKey.slice(0, 8) + '...' : '❌ 없음'}`);
console.log(`APP_SECRET: ${config.kis.appSecret ? config.kis.appSecret.slice(0, 8) + '...' : '❌ 없음'}`);
console.log(`계좌번호: ${config.kis.accountNo}-${config.kis.accountProductCode}`);
console.log('========================================\n');

// Step 1: 토큰 발급 테스트
async function testToken(): Promise<string | null> {
  console.log('[1/3] 토큰 발급 테스트...');
  try {
    const res = await fetch(`${BASE_URL}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: config.kis.appKey,
        appsecret: config.kis.appSecret,
      }),
    });

    const data = await res.json();
    console.log(`  HTTP ${res.status}`);

    if (!res.ok) {
      console.log(`  ❌ 실패:`, JSON.stringify(data, null, 2));
      return null;
    }

    if (data.access_token) {
      console.log(`  ✅ 토큰 발급 성공`);
      console.log(`  만료: ${data.access_token_token_expired}`);
      return data.access_token;
    } else {
      console.log(`  ❌ 토큰 없음:`, JSON.stringify(data, null, 2));
      return null;
    }
  } catch (err) {
    console.log(`  ❌ 네트워크 에러:`, (err as Error).message);
    return null;
  }
}

// Step 2: 현재가 조회 테스트 (삼성전자 005930)
async function testPrice(token: string) {
  console.log('\n[2/3] 현재가 조회 테스트 (삼성전자 005930)...');
  try {
    const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`);
    url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
    url.searchParams.set('FID_INPUT_ISCD', '005930');

    const res = await fetch(url.toString(), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: config.kis.appKey,
        appsecret: config.kis.appSecret,
        tr_id: 'FHKST01010100',
      },
    });

    const data = await res.json();
    console.log(`  HTTP ${res.status}`);

    if (data.rt_cd === '0') {
      const o = data.output;
      console.log(`  ✅ 삼성전자 현재가: ${Number(o.stck_prpr).toLocaleString()}원`);
      console.log(`  전일대비: ${o.prdy_vrss}원 (${o.prdy_ctrt}%)`);
      console.log(`  거래량: ${Number(o.acml_vol).toLocaleString()}`);
    } else {
      console.log(`  ❌ 조회 실패:`, data.msg_cd, data.msg1);
      console.log(`  전체 응답:`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.log(`  ❌ 에러:`, (err as Error).message);
  }
}

// Step 3: 계좌 잔고 조회 테스트
async function testBalance(token: string) {
  console.log('\n[3/3] 계좌 잔고 조회 테스트...');
  const trId = config.isPaper ? 'VTTC8434R' : 'TTTC8434R';

  try {
    const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/trading/inquire-balance`);
    url.searchParams.set('CANO', config.kis.accountNo);
    url.searchParams.set('ACNT_PRDT_CD', config.kis.accountProductCode);
    url.searchParams.set('AFHR_FLPR_YN', 'N');
    url.searchParams.set('OFL_YN', '');
    url.searchParams.set('INQR_DVSN', '02');
    url.searchParams.set('UNPR_DVSN', '01');
    url.searchParams.set('FUND_STTL_ICLD_YN', 'N');
    url.searchParams.set('FNCG_AMT_AUTO_RDPT_YN', 'N');
    url.searchParams.set('PRCS_DVSN', '00');
    url.searchParams.set('CTX_AREA_FK100', '');
    url.searchParams.set('CTX_AREA_NK100', '');

    const res = await fetch(url.toString(), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: config.kis.appKey,
        appsecret: config.kis.appSecret,
        tr_id: trId,
      },
    });

    const data = await res.json();
    console.log(`  HTTP ${res.status}, tr_id: ${trId}`);

    if (data.rt_cd === '0') {
      const summary = Array.isArray(data.output2) ? data.output2[0] : data.output2;
      console.log(`  ✅ 잔고 조회 성공`);
      console.log(`  예수금: ${Number(summary?.dnca_tot_amt ?? 0).toLocaleString()}원`);
      console.log(`  주문가능: ${Number(summary?.ord_psbl_cash ?? 0).toLocaleString()}원`);
      console.log(`  보유종목 수: ${(data.output1 ?? []).filter((p: any) => Number(p.hldg_qty) > 0).length}개`);
    } else {
      console.log(`  ❌ 조회 실패:`, data.msg_cd, data.msg1);
      console.log(`  전체 응답:`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.log(`  ❌ 에러:`, (err as Error).message);
  }
}

// 실행
async function main() {
  const token = await testToken();
  if (!token) {
    console.log('\n⛔ 토큰 발급 실패 — API 키/시크릿 확인 필요');
    console.log('\n💡 체크리스트:');
    console.log('  1. KIS 개발자센터에서 모의투자용 앱 키를 별도로 발급받았는지?');
    console.log('     (실거래용 키와 모의투자용 키는 다름!)');
    console.log('  2. 모의투자 가입이 완료되었는지?');
    console.log('     → https://apiportal.koreainvestment.com 에서 모의투자 신청');
    console.log('  3. 계좌번호가 모의투자 계좌인지?');
    return;
  }

  await testPrice(token);
  await testBalance(token);

  console.log('\n========================================');
  console.log('테스트 완료!');
  console.log('========================================');
}

main().catch(console.error);
