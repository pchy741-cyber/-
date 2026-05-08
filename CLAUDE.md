# QUANTOPS — Claude Code 스캘핑 루프 지시어

## 루프 시작 방법
```
/loop 장중 스캘핑: 실시간 차트 분석 → 매수/매도 판단 → 직접 실행
```

## 루프 실행 환경 변수 (터미널에서 먼저 설정)
```powershell
$env:QUANTOPS_URL = "https://quantops-807105550136.asia-northeast3.run.app"
$env:QUANTOPS_PW  = "<DASHBOARD_PASSWORD>"   # Cloud Run secret 값
$env:SCALP_AMOUNT = "1000000"                # 1회 매수금액 (원). 기본 100만원
```

---

## 루프 매 반복 행동 지침

### 0. 시장 시간 체크
- KST 09:05~15:20 (평일)만 실행. 그 외 시간대는 "시장 닫힘" 출력 후 ScheduleWakeup(600초) 후 종료.
- 현재 KST 시각: `(Get-Date).ToUniversalTime().AddHours(9)`

### 1. 데이터 수집 (Bash)
```bash
# 로그인 (세션 쿠키 획득)
curl -sc /tmp/qops.jar -sX POST "$QUANTOPS_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$QUANTOPS_PW\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('ok') else 'FAIL')"

# 대시보드 (포지션 + AI 스코어 + 감시종목)
curl -sb /tmp/qops.jar -s "$QUANTOPS_URL/api/dashboard" > /tmp/qops_dash.json
```

### 2. 분석 기준

#### 매수 후보 선정
- `scores[]` 에서 `composite_score >= 68` 종목 추출
- 이미 `chains[]` 에 OPEN 포지션 있는 종목 제외
- `killSwitch.isActive == true` 이면 매수 전면 중단

#### 매도 신호
- `chains[]` 에서 `unrealizedPnlPct >= 1.5` → 익절 매도 (`POST /sell/:chainId`)
- `chains[]` 에서 `unrealizedPnlPct <= -0.8` → 손절 매도

#### 스캘핑 매수 판단 (내 판단)
다음 조건 **2개 이상** 충족 시 매수:
1. AI 스코어 `composite_score >= 68`
2. 당일 등락률이 양전 (currentPrice > openPrice — 대시보드 chains의 가격 추이로 추론)
3. AI 스코어가 `confidence >= 0.7` 이상
4. 종목이 KOSPI 주요 섹터 (반도체/바이오/2차전지) 관련

#### 판단 후 매수 실행
```bash
curl -sX POST "$QUANTOPS_URL/api/manual-buy" \
  -H 'Content-Type: application/json' \
  -H "X-Api-Key: $QUANTOPS_PW" \
  -d "{\"stock_code\":\"005930\",\"amount_krw\":$SCALP_AMOUNT,\"reasoning\":\"AI 75점, confidence 0.8, 반도체 반등 모멘텀\"}"
```

#### 매도 실행
```bash
curl -sb /tmp/qops.jar -sX POST "$QUANTOPS_URL/api/sell/<CHAIN_ID>"
```

### 3. 루프 간격
- 분석 완료 후 `ScheduleWakeup(90)` — 90초 후 재실행 (KIS rate limit 고려)
- 매수/매도 실행 직후는 `ScheduleWakeup(120)` — 체결 반영 대기

### 4. 제한 규칙
- 1회 루프당 최대 매수 **2종목** 이하
- 동일 종목 중복 매수 금지 (chains 에 이미 있으면 스킵)
- `blockNewBuys == true` 이면 매수 완전 중단
- 총 투자 포지션 3개 초과 시 신규 매수 중단

---

## 판단 예시

**매수 OK**: "005930(삼성전자) — AI 72점 confidence 0.75, chains에 없음, killSwitch 꺼짐 → 100만원 스캘핑 매수"

**매수 SKIP**: "000660(SK하이닉스) — AI 65점이나 이미 OPEN 포지션 있음 → 스킵"

**매도 실행**: "체인 #42 — 현재 +1.7% 수익 → 익절 매도"
