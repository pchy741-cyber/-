# QUANTOPS — Claude Code 루프 지시어

## 루프 목록

| 루프 | 명령어 | 운영 시간 |
|------|--------|-----------|
| **한국 눌림매매** | `/loop 장중 눌림매매: 고확신 진입 → 스윙 보유 → 직접 실행` | KST 09:30~10:20 / 13:00~15:00 |
| **미국 야간 감시** | `/loop 미국주식 야간 감시: 포지션 보호 → 손절/익절 판단 → 직접 실행` | KST 23:30~06:00 |

> 09:00~09:30 개장 스캘핑은 백엔드 자동 실행 (opening-bell-job) — Claude Code 개입 불필요
> 미국 야간 루프는 스케줄러(overseas-job)가 10분 간격 자동 처리 중 — Claude Code 직접 실행 시에만 사용

---

## 루프 시작 방법
```
/loop 장중 눌림매매: 고확신 진입 → 스윙 보유 → 직접 실행
```

## 루프 실행 환경 변수
```powershell
$env:QUANTOPS_URL = "https://quantops-807105550136.asia-northeast3.run.app"
$env:QUANTOPS_PW  = "<DASHBOARD_PASSWORD>"
```

---

## 루프 매 반복 행동 지침

### 0. 시장 시간 체크
KST = UTC+9. PowerShell: `(Get-Date).ToUniversalTime().AddHours(9).ToString("HH:mm")`

```
09:00 미만     → 장 전 대기          ScheduleWakeup(600)
09:00~09:30   → 백엔드 개장 자동구간  Claude 매수 금지, ScheduleWakeup(120)
09:30~10:20   → ★★ 황금 오전 구간    모멘텀 최고조 — 적극 진입, ScheduleWakeup(120)
10:20~13:00   → ☠️ 마의 시간대       잔손절 구간 — 신규 매수 금지, 손절 모니터만, ScheduleWakeup(300)
13:00~15:00   → ★ 황금 오후 구간     방향성 확인 후 종가 눌림 진입, ScheduleWakeup(180)
15:00~15:20   → 신규 매수 금지        기존 포지션 손절 모니터만, ScheduleWakeup(240)
15:20 이후    → 장 마감              ScheduleWakeup(600)
```

> **핵심 원칙**: 오전 10:20 이전, 오후 13:00 이후만 진입. 10:20~13:00 마의 시간대는 절대 매수 금지 — 이 시간대 억지 진입이 잔손절의 주원인.
> 참고: 누적 수익 17억 트레이더 "10:20 이후 시세가 꺾이면 비중 크게 낮추거나 매매 안 하는 것이 낫다"

**황금 오전 구간 (09:30~10:20) 진입 기준**:
- 기본 진입 기준 동일 (score ≥ 80, conf ≥ 0.65)
- 갭업 모멘텀 종목 우선 (당일 시가 대비 +1% 이상 출발 시 가산점)

**황금 오후 구간 (13:00~15:00) 진입 기준**:
- 동일 기본 기준 (score ≥ 80) + 추가 조건:
  - 거래대금 상위 섹터 확인 후 주도 종목만 선별
  - `volumeRatio >= 1.5` 필수 (오후 수급 집중 확인)
  - `pullbackSignal == true` 우선 (눌림 반등 타이밍)

**마의 시간대(10:20~13:00) 유일 예외**:
- `composite_score >= 93` AND `pullbackSignal == true` AND `volumeRatio >= 2.5` → 진입 허용 (초고확신만)

### 1. 데이터 수집
```bash
curl -s -H "x-api-key: <DASHBOARD_PASSWORD>" "https://quantops-807105550136.asia-northeast3.run.app/api/dashboard" -o "C:/Temp/qops_dash.json"
```

**실제 JSON 필드명**:
- 포지션: `d['chains']` (status != 'CLOSED')
- 현금: `d['portfolio']['domesticCash']`
- killSwitch: `d['killSwitch']` (dict, `.active` 키)
- PnL: `c['unrealizedPnlPct']`
- 체인 ID: `c['id']`
- trigger_source: `c['trigger_source']`

### 2. 포지션 관리 (매도 판단)

#### A. 긴급 손절 (CLAUDE 체인 전체)
- `unrealizedPnlPct <= -2.5%` → 즉시 매도 (백엔드 손절선 -4% 도달 전 선제 차단)

#### B. 강세장 퀵플립 익절 (장 좋을 때 적극 수익 확정)
**강세장 감지 기준** (아래 중 1개 이상):
- 현재 보유 OPEN 체인 중 `unrealizedPnlPct >= 2%` 종목이 50%+ (장 전반이 상승 중)
- 대시보드 scores[]에서 75점+ 종목이 8개 이상

**강세장 퀵플립 조건**:
- `unrealizedPnlPct >= 3.5%` → 즉시 익절 (수익 확정 후 재진입 기회 탐색)
- `unrealizedPnlPct >= 2.5%` AND 보유시간 30분+ → 익절 (장 후반 흐름 둔화 대비)

**퀵플립 후 재진입**: 익절 종목이라도 점수 기준 충족하면 즉시 Step 3으로 재매수 가능

그 외 수익/손실 관리는 백엔드에 맡긴다:
- **Track B** (3분 간격): TP +5.5% / SL -4% 자동 처리
- **holding-check** (10분 간격): 트레일링 스탑 + 보유일 초과 손절

매도 실행:
```bash
# 긴급 손절
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/sell/<CHAIN_ID>" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{"source":"CLAUDE","reason":"긴급손절 -2.5% 초과"}'

# 퀵플립 익절
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/sell/<CHAIN_ID>" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{"source":"CLAUDE","reason":"퀵플립 익절"}'
```

---

### 3. 신규 매수 — 눌림매매 + 스윙 전략

#### 전략 원칙
- **타이밍 우선**: 황금 구간(10:00~11:30, 13:30~14:20)에만 진입. 나머지 시간 신호 아무리 좋아도 기다린다.
- 눌림매매: 상승 추세 중 일시 눌림 구간에 진입 → 반등 후 +5% 목표
- **거래량 급증 단타**: 5분 거래량이 평균 3배+ 급증 + 당일 상승 중 → 황금구간 내 즉시 단타 진입 허용
- 진입 기준을 엄격히 유지해 승률을 높인다 (저확신 종목 절대 진입 금지)
- 진입 후 백엔드에 맡기고 조기 청산하지 않는다 (수익 킬러 제거)

**거래량 급증 단타 조건** (황금구간 내에서만):
```python
# 스코어 관계없이 별도 트랙 — volumeRatio가 핵심
if volumeRatio >= 3.0 and currentPrice > openPrice * 1.005:
    if pullbackSignal or envelope_pos in ('BELOW_LOWER', 'NEAR_LOWER'):
        amount = 500000  # 단타 — 표준 금액
        reason = f"거래량급증 단타 vol{volumeRatio}x pb={pullback} env={env_pos}"
        # 즉시 진입, 백엔드 TP/SL에 맡김
```

#### Step 1 — 1차 필터 (대시보드 scores[])

**강세장 vs 일반 기준**:
```python
# 강세장 감지: 75점+ 종목 8개+ OR 보유 포지션 50%+ 수익중
bull_market = (len([s for s in scores if s['composite_score'] >= 75]) >= 8)
             or (수익중 포지션 비율 >= 0.5)

min_score = 75 if bull_market else 80   # 강세장: 75점 이상
min_conf  = 0.60 if bull_market else 0.65
max_buys  = 3 if bull_market else 2     # 강세장: 3종목까지
```

필수 조건:
1. `composite_score >= min_score`
2. `confidence >= min_conf`
3. 이미 OPEN 포지션 없는 종목
4. `d['killSwitch']['active'] == False`
5. `d['portfolio']['domesticCash'] > 50000`

꽁돈 게이트: `composite_score >= 85` → 2차 필터 무관, 즉시 Step 3으로 (복리 자동계산)

#### Step 2 — 2차 필터 (기술 분석 API)
1차 통과 후보 최대 5종목에 대해 개별 기술분석 호출:
```bash
curl -s -H "x-api-key: <DASHBOARD_PASSWORD>" \
  "https://quantops-807105550136.asia-northeast3.run.app/api/stock/XXXXXX/analysis"
```

응답에서 `technicals` 필드 확인:
| 조건 | 기준 | 실패 시 |
|------|------|---------|
| **당일 방향** | `currentPrice > openPrice * 1.005` (당일 +0.5% 이상) | **스킵** |
| **SMA20 추세** | `currentPrice > sma20` (20일선 위) | **스킵** |
| **거래량** | `volumeRatio >= 1.0` (평균 이상 거래) | **스킵** |
| RSI14 | 30 ≤ RSI ≤ 68 | 스킵 |
| overallSignal | STRONG_SELL이 아니면 OK | STRONG_SELL만 스킵 |

**눌림매매 가산점**:
```python
t = technicals
score_bonus = 0

# 핵심: 눌림 신호 (5MA 이탈 후 복귀 + 거래량)
if t.get('pullbackSignal'):
    score_bonus += 12   # 가장 강한 재진입 시그널

# 엔벨로프 하단 (SMA20 -5% 이하 → 과매도 반등 구간)
envelope_pos = t.get('envelope', {}).get('position', '')
if envelope_pos in ('BELOW_LOWER', 'NEAR_LOWER'):
    score_bonus += 7

# 거래대금 연속성 (주도주 확인)
vol_consistency = t.get('volumeConsistency', 0)
if vol_consistency >= 4:
    score_bonus += 5
elif vol_consistency <= 1:
    score_bonus -= 8    # 단발 이슈 제거

# 눌림매매 신호 없으면 score 85 미만 종목 스킵 (일반 모멘텀은 85+ 만)
if not t.get('pullbackSignal') and envelope_pos not in ('BELOW_LOWER', 'NEAR_LOWER'):
    if score < 85:
        → 스킵 (눌림 신호 없으면 더 높은 확신 필요)
```

reasoning에 `pb={pullback} env={envelope_pos} volC={vol_consistency}일` 포함

> `sma20` 없는 경우(신규 상장 등): 당일 방향 필터만으로 판단

**reasoning 필드**:
`"눌림매매 AI {score}점 conf{conf} RSI{rsi} vol{volRatio}x pb={pullback} env={env_pos} volC={vol_cons}일"`

#### Step 3 — 포지션 사이징 후 실행

**복리 동적 사이징 (백엔드 자동 계산)**:
- `ai_score` 전달 → 백엔드가 `총자본 × 1.5% / |SL%|` 공식으로 `amount_krw` 자동 결정
- 계좌가 클수록 베팅도 자동으로 커짐 (복리 효과)
- `ai_score`별 손익비: 80점→TP6%/SL2.5%(2.4:1), 90점→TP8%/SL2%(4:1)

- 점수 내림차순, **최대 max_buys종목** (강세장: 3, 일반: 2)

```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/manual-buy" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -d "{\"stock_code\":\"XXXXXX\",\"ai_score\":SCORE,\"reasoning\":\"눌림매매 AI 82점 conf0.70 RSI48 vol1.5x pb=True env=NEAR_LOWER volC=3일\"}"
```

> `amount_krw` 생략 시 백엔드가 자동으로 복리 사이징 계산 (직접 지정도 가능).

### 4. 루프 간격
- 긴급 손절 실행 후: `ScheduleWakeup(120)`
- 매수 실행 후: `ScheduleWakeup(180)` — 진입 후 백엔드에 맡기고 3분 대기
- 신호 없음: `ScheduleWakeup(180)` — 3분 간격 (Track B와 동기화)
- 09:00~09:30 개장 구간: `ScheduleWakeup(120)`
- 13:30 이후: `ScheduleWakeup(300)` — 모니터만

### 5. 제한 규칙
- 1회 루프당 신규 매수 최대 3종목 (강세장), 일반 2종목
- 동일 종목 중복 매수 금지 (단, 퀵플립 익절 후 재진입은 허용)
- `blockNewBuys == true` 이면 매수 완전 중단
- 총 현금 50,000원 미만이면 매수 중단

---

## 판단 예시

**눌림매매 진입 (고확신)**: "058430 AI 85점 conf0.73 RSI44 vol1.8x pb=True env=NEAR_LOWER → ai_score=85 매수 (백엔드 복리 사이징)"

**눌림 신호 없어서 스킵**: "012345 AI 83점이나 pb=False env=MIDDLE → 눌림 신호 없음, 스킵"

**점수 미달 스킵**: "031820 AI 76점 conf0.61 → 80점 미달, 스킵"

**거래량 미달 스킵**: "068270 AI 82점이나 vol=0.7x → 거래량 1.0x 미달, 스킵"

**긴급 손절**: "체인 #45 PnL -2.6% → 긴급 손절 (-2.5% 한도 초과)"

**백엔드 관리 중**: "체인 #42 PnL +2.1% → 백엔드 트레일링 중, Claude 개입 없음"

**개장 구간 대기**: "09:15 KST → 개장 스캘핑 백엔드 실행 중, 120s 대기"

---

## 미국주식 야간 감시 루프

> **참고**: overseas-job 스케줄러가 10분 간격 자동 처리 중. 이 루프는 Claude Code를 야간에 직접 돌릴 때만 사용.

```
/loop 미국주식 야간 감시: 포지션 보호 → 손절/익절 판단 → 직접 실행
```

### 시장 시간 체크 (KST 기준)
- **23:10 미만 OR 06:10 이상** → 미국장 마감, ScheduleWakeup(600)
- **23:10~23:30** → 프리마켓 대기, ScheduleWakeup(300)
- **23:30~06:00** → 정규장 → 활성 감시

### 데이터 수집
```bash
curl -s -H "x-api-key: <DASHBOARD_PASSWORD>" \
  "https://quantops-807105550136.asia-northeast3.run.app/api/overseas/dashboard" \
  -o "C:/Temp/qops_us.json"
```

필드:
- 포지션: `d['holdings']` (quantity > 0)
- 현재가: `h['last_price']` (장중 업데이트)
- 평단가: `h['avg_price']`
- 수익률: `(last_price - avg_price) / avg_price * 100`

### 매도 판단 (황금비율 기준)

**① 즉시 손절**
- `pnlPct <= -8.0%` → 즉시 매도 (황금비율 8% 손절)

**② 진행 중 급락 (-5% 이내 단타 급락)**
- `pnlPct <= -5.0%` AND 당일 하락 → 경고 로그, 다음 틱에서 재확인

**③ 목표 익절**
- `pnlPct >= 16.0%` → 1:2 황금비율 달성, 즉시 익절

**④ Progressive Trailing (고점 추적)**
- overseas-job.ts가 처리 중 — 여기선 8% 초과 손실만 체크

매도 실행:
```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/overseas/sell" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -d "{\"stock_code\":\"XXXXXX\",\"quantity\":N,\"reason\":\"야간감시 -8% 손절\"}"
```

### 루프 간격
- 정규장 중: ScheduleWakeup(180) — 3분
- 장 마감 임박 (05:45~06:10): ScheduleWakeup(120)
- 장외: ScheduleWakeup(600)

### 황금비율 준수 체크
- 현금 비중 = `cashUsd / (totalValue)` — 20% 미만이면 신규 매수 금지
- 종목당 비중 = `position_value / totalValue` — 5% 초과 시 경고 로그

### 판단 예시
**즉시 손절**: "NVDA pnl -8.3% → 황금비율 손절 실행"
**목표 달성**: "AAPL pnl +16.2% → 1:2 익절 실행"
**감시 유지**: "MSFT pnl +4.1% → 트레일링 중 (overseas-job 처리 중)"
**장 마감 대기**: "06:05 KST 미국장 종료 → 600s 대기"
