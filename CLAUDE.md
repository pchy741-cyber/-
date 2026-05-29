# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# QUANTOPS — 자동매매 시스템 & Claude Code 루프 지시어

## 개발 명령어

```bash
npm run dev        # tsx watch로 개발 서버 실행
npm run build      # TypeScript → dist/ 컴파일
npm start          # 컴파일된 서버 실행
npm run test       # Vitest 테스트 실행
npm run lint       # Biome 린터
npm run lint:fix   # Biome 자동 수정
npm run db:migrate # DB 마이그레이션 실행
npm run backtest   # 스코어 vs PnL 백테스트
```

배포: GitHub Actions (main push → Cloud Run 자동 배포)
- `.github/workflows/deploy.yml` — `GCP_SA_KEY` 시크릿 필요
- 수동: `gcloud builds submit --config cloudbuild.yaml --substitutions _TAG=vX-Y-Z`

---

## 아키텍처 개요

### 핵심 구조
```
src/
├── ai/
│   ├── track-a/          # 무거운 분석 (Gemini + GPT-4o) — 07:30, 12:30, 18:00
│   └── track-b/          # 실시간 실행 (Claude) — 3분 간격
│       ├── pipeline.ts   # 메인 파이프라인 (지표 수집 → AI 판단 → 주문)
│       └── technical-fallback.ts  # AI 없을 때 기술적 지표만으로 매매
├── scheduler/
│   ├── runner.ts         # 마스터 cron 스케줄러
│   ├── opening-bell-job.ts  # 09:00~09:12 개장 초단타
│   ├── overseas-job.ts   # 미국주식 오케스트레이터
│   └── overseas/         # 해외주식 서브모듈 (~22개 파일)
├── config/
│   ├── index.ts          # Zod 검증 환경변수 + config 객체
│   ├── context.ts        # AsyncLocalStorage (paper/live 컨텍스트)
│   └── constants.ts      # STRATEGY_PARAMS, getOverseasDynamic()
├── risk/
│   ├── kill-switch.ts    # 긴급정지 (KR / OVERSEAS 독립 스코프)
│   └── seed-capital.ts   # 일일 손실 한도 (시드 30%)
├── db/client.ts          # pg.Pool + withTransaction + in-memory fallback
├── kis/                  # KIS(한국투자증권) API 클라이언트
└── trading/executor.ts   # 국내주식 주문 실행
```

### Track A vs Track B
- **Track A**: Gemini + GPT-4o로 일 3회 종목 분석 → `ai_scores` 테이블 저장
- **Track B**: AI 점수 + 실시간 기술지표로 3분마다 실행 → 실제 주문
- `technicalFallbackDecisions()` — AI 없을 때 기술지표만으로 매매 판단
  - `allowScalpingBuys: true` 전달 시에만 SCALPING 신규 매수 허용 (opening-bell-job 전용)

### Paper/Live 분리 원칙
- `runWithMode(isPaper, fn)` — AsyncLocalStorage로 컨텍스트 주입 (`src/config/context.ts`)
- `getCtxIsPaper()` — 현재 컨텍스트의 모드 읽기
- `config.isPaper` — 전역 기본값 (컨텍스트 없을 때 폴백)
- 모든 DB 쿼리는 `is_paper` / `trading_mode` 컬럼으로 paper/live 구분
- **Paper 현금**: `computePaperCash()` — orders 테이블에서 결정론적 계산 (오염 불가)
- **Live 현금**: KIS 계좌 잔고 → KRW DB 저장 → USD 변환

### Kill Switch
```typescript
isKillSwitchActive('KR')       // 국내 매매 차단 여부
isKillSwitchActive('OVERSEAS') // 해외 매매 차단 여부
activateKillSwitch(reason, manual, scope)
```
- 스코프 독립: KR 킬스위치가 OVERSEAS에 영향 없음
- DB Advisory Lock: `pg_try_advisory_lock()` — Cloud Run 롤링 배포 시 동시실행 방지

### 해외주식 Cash 흐름
```
let cash = await getCash(isPaper())   // 초기값 (paper: computePaperCash, live: KRW/환율)
↓ evaluateSells() → cash 반환
↓ 집중도캡 매도 → cash += proceeds
↓ 순환매도 → cash += proceeds
↓ 매수 → cash -= cost
↓ rebalancePortfolio({ cash }) → rbResult.cash  // caller의 cash를 받아 사용
cash = rbResult.cash
↓ deployIdleCash({ cash })
```

### 전략 모드 (`src/config/constants.ts`)
| 모드 | TP | SL | 용도 |
|------|----|----|------|
| SWING | +5.5% | -3.0% | 기본 |
| SCALPING | +1.5% | -1.2% | 개장벨 전용 |
| DEFENSE | +5.0% | -2.0% | 하락장 |
| SNIPER | +8.0% | -4.0% | 고확신 집중 |
| BOTTOM_FISHING | +6.0% | -2.5% | 과매도 반등 |

수치는 `getScoreBasedParams(score)` / `getOverseasDynamic(portfolioUsd)` 로 동적 조정.

### 주요 불변 규칙
1. **숫자/전략 파라미터 임의 변경 금지** — 변경 시 반드시 사용자 승인
2. `overseas_state` 키 네이밍: paper=`p_`, live=`l_` 접두사 (e.g. `p_maxprice_NVDA`)
3. 수동매도 쿨다운: `manual_sell_cd_{code}` — 2시간 재매수 금지
4. 손절 쿨다운: `getLossCooldownStocks()` — 24시간 재매수 금지
5. 개장벨 SCALPING: `allowScalpingBuys: true` 없으면 Track B가 모든 후보 skip

---

## 루프 목록

| 루프 | 명령어 | 운영 시간 |
|------|--------|-----------|
| **한국 눌림매매** | `/loop 장중 눌림매매: 고확신 진입 → 스윙 보유 → 직접 실행` | KST 09:30~10:20 / 13:00~15:00 |
| **미국 야간 감시** | `/loop 미국주식 야간 감시: 포지션 보호 → 손절/익절 판단 → 직접 실행` | KST 23:30~06:00 |

> 09:00~09:30 개장 스캘핑은 백엔드 자동 실행 (opening-bell-job) — Claude Code 개입 불필요
> 미국 야간 루프는 스케줄러(overseas-job)가 10분 간격 자동 처리 중 — Claude Code 직접 실행 시에만 사용

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

> **핵심 원칙**: 오전 10:20 이전, 오후 13:00 이후만 진입. 10:20~13:00 마의 시간대는 절대 매수 금지.

**황금 오전 구간 (09:30~10:20) 진입 기준**:
- 기본 진입 기준 동일 (score ≥ 80, conf ≥ 0.65)
- 갭업 모멘텀 종목 우선 (당일 시가 대비 +1% 이상 출발 시 가산점)

**황금 오후 구간 (13:00~15:00) 진입 기준**:
- 동일 기본 기준 (score ≥ 80) + 추가 조건:
  - `volumeRatio >= 1.5` 필수
  - `pullbackSignal == true` 우선

**마의 시간대(10:20~13:00) 유일 예외**:
- `composite_score >= 93` AND `pullbackSignal == true` AND `volumeRatio >= 2.5` → 진입 허용

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

#### B. 강세장 퀵플립 익절
**강세장 감지 기준** (아래 중 1개 이상):
- 현재 보유 OPEN 체인 중 `unrealizedPnlPct >= 2%` 종목이 50%+
- 대시보드 scores[]에서 75점+ 종목이 8개 이상

**강세장 퀵플립 조건**:
- `unrealizedPnlPct >= 3.5%` → 즉시 익절
- `unrealizedPnlPct >= 2.5%` AND 보유시간 30분+ → 익절

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
- **타이밍 우선**: 황금 구간에만 진입
- 눌림매매: 상승 추세 중 일시 눌림 구간에 진입 → 반등 후 +5% 목표
- **거래량 급증 단타**: volumeRatio >= 3.0 + 당일 상승 → 황금구간 내 즉시 단타 진입 허용
- 진입 후 백엔드에 맡기고 조기 청산하지 않는다

#### Step 1 — 1차 필터 (대시보드 scores[])

```python
bull_market = (len([s for s in scores if s['composite_score'] >= 75]) >= 8)
             or (수익중 포지션 비율 >= 0.5)

min_score = 80 if bull_market else 85
min_conf  = 0.60 if bull_market else 0.65
max_buys  = 3 if bull_market else 2
```

필수 조건:
1. `composite_score >= min_score`
2. `confidence >= min_conf`
3. 이미 OPEN 포지션 없는 종목
4. `d['killSwitch']['active'] == False`
5. `d['portfolio']['domesticCash'] > 50000`
6. **장 강도 게이트**: 상위 5종목 평균 점수 < 78 → 신규 매수 전면 중단

꽁돈 게이트: `composite_score >= 90` → 2차 필터 무관, 즉시 Step 3으로

#### Step 2 — 2차 필터 (기술 분석 API)
```bash
curl -s -H "x-api-key: <DASHBOARD_PASSWORD>" \
  "https://quantops-807105550136.asia-northeast3.run.app/api/stock/XXXXXX/analysis"
```

| 조건 | 기준 | 실패 시 |
|------|------|---------|
| **당일 방향** | `currentPrice > openPrice * 1.005` | **스킵** |
| **SMA20 추세** | `currentPrice > sma20` | **스킵** |
| **거래량** | `volumeRatio >= 1.0` | **스킵** |
| RSI14 | 30 ≤ RSI ≤ 68 | 스킵 |

**눌림매매 가산점**:
```python
if t.get('pullbackSignal'):         score_bonus += 12
if envelope_pos in ('BELOW_LOWER', 'NEAR_LOWER'): score_bonus += 7
if vol_consistency >= 4:            score_bonus += 5
elif vol_consistency <= 1:          score_bonus -= 8

# 눌림 신호 없으면 score 85 미만 스킵
if not pullbackSignal and envelope_pos not in ('BELOW_LOWER', 'NEAR_LOWER'):
    if score < 85: → 스킵
```

**reasoning 필드**: `"눌림매매 AI {score}점 conf{conf} RSI{rsi} vol{volRatio}x pb={pullback} env={env_pos} volC={vol_cons}일"`

#### Step 3 — 포지션 사이징 후 실행
```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/manual-buy" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -d "{\"stock_code\":\"XXXXXX\",\"ai_score\":SCORE,\"reasoning\":\"눌림매매 AI 82점 conf0.70 RSI48 vol1.5x pb=True env=NEAR_LOWER volC=3일\"}"
```

> `amount_krw` 생략 시 백엔드가 자동으로 복리 사이징 계산.

### 4. 루프 간격
- 긴급 손절 실행 후: `ScheduleWakeup(120)`
- 매수 실행 후: `ScheduleWakeup(180)`
- 신호 없음: `ScheduleWakeup(180)`
- 09:00~09:30 개장 구간: `ScheduleWakeup(120)`
- 13:30 이후: `ScheduleWakeup(300)`

### 5. 제한 규칙
- 1회 루프당 신규 매수 최대 3종목 (강세장), 일반 2종목
- 동일 종목 중복 매수 금지 (단, 퀵플립 익절 후 재진입은 허용)
- `blockNewBuys == true` 이면 매수 완전 중단
- 총 현금 50,000원 미만이면 매수 중단

---

## 판단 예시

**눌림매매 진입**: "058430 AI 85점 conf0.73 RSI44 vol1.8x pb=True env=NEAR_LOWER → ai_score=85 매수"
**눌림 신호 없어서 스킵**: "012345 AI 83점이나 pb=False env=MIDDLE → 스킵"
**점수 미달 스킵**: "031820 AI 76점 conf0.61 → 80점 미달, 스킵"
**긴급 손절**: "체인 #45 PnL -2.6% → 긴급 손절"
**백엔드 관리 중**: "체인 #42 PnL +2.1% → 백엔드 트레일링 중, Claude 개입 없음"
**개장 구간 대기**: "09:15 KST → 개장 스캘핑 백엔드 실행 중, 120s 대기"

---

## 미국주식 야간 감시 루프

> overseas-job 스케줄러가 10분 간격 자동 처리 중. Claude Code 직접 실행 시에만 사용.

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
- 현재가: `h['last_price']`
- 평단가: `h['avg_price']`
- 수익률: `(last_price - avg_price) / avg_price * 100`

### 매도 판단 (황금비율 기준)

**① 즉시 손절**: `pnlPct <= -8.0%` → 즉시 매도
**② 목표 익절**: `pnlPct >= 16.0%` → 1:2 황금비율 달성
**③ Progressive Trailing**: overseas-job.ts 처리 중

```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/overseas/sell" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -d "{\"stock_code\":\"XXXXXX\",\"quantity\":N,\"reason\":\"야간감시 -8% 손절\"}"
```

### 루프 간격
- 정규장 중: ScheduleWakeup(180)
- 장 마감 임박 (05:45~06:10): ScheduleWakeup(120)
- 장외: ScheduleWakeup(600)

### 황금비율 준수 체크
- 현금 비중 = `cashUsd / totalValue` — 20% 미만이면 신규 매수 금지
- 종목당 비중 = `position_value / totalValue` — 5% 초과 시 경고 로그

### 판단 예시
**즉시 손절**: "NVDA pnl -8.3% → 황금비율 손절 실행"
**목표 달성**: "AAPL pnl +16.2% → 1:2 익절 실행"
**감시 유지**: "MSFT pnl +4.1% → 트레일링 중 (overseas-job 처리 중)"
**장 마감 대기**: "06:05 KST 미국장 종료 → 600s 대기"
