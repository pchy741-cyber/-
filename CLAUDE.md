# QUANTOPS — Claude Code 스캘핑 루프 지시어

## 루프 시작 방법
```
/loop 장중 스캘핑: 실시간 차트 분석 → 매수/매도 판단 → 직접 실행
```

## 루프 실행 환경 변수
```powershell
$env:QUANTOPS_URL = "https://quantops-807105550136.asia-northeast3.run.app"
$env:QUANTOPS_PW  = "<DASHBOARD_PASSWORD>"
$env:SCALP_AMOUNT = "1000000"
```

---

## 루프 매 반복 행동 지침

### 0. 시장 시간 체크
KST = UTC+9. PowerShell: `(Get-Date).ToUniversalTime().AddHours(9).ToString("HH:mm")`

- **09:05 미만** → 장 전 대기, ScheduleWakeup(300)
- **09:05~09:15** → 장 초반 변동구간 → 매수 금지 (매도는 가능), ScheduleWakeup(120)
- **09:15~14:00** → 정상 매매 구간
- **14:00~15:20** → 신규 매수 금지, 기존 포지션 정리만 (마감 임박 시간대 완전 제외)
- **15:20 이후** → 장 마감, ScheduleWakeup(600)

### 1. 데이터 수집
```bash
curl -s -H "x-api-key: <DASHBOARD_PASSWORD>" "https://quantops-807105550136.asia-northeast3.run.app/api/dashboard" -o "C:/Temp/qops_dash.json"
```

**실제 JSON 필드명**:
- 포지션: `d['chains']` (status != 'CLOSED')
- 현금: `d['portfolio']['domesticCash']`
- killSwitch: `d['killSwitch']` (dict, `.active` 키)
- PnL: `c['unrealizedPnlPct']`
- 고점(트레일링용): `c['peak_price_since_open']`
- 체인 ID: `c['id']`
- trigger_source: `c['trigger_source']`

### 2. 매도 판단 (CLAUDE 체인만 관리, SWING 건드리지 않음)

#### 우선순위 순서로 평가:

**① 즉시 손절** (보유시간 무관)
- `unrealizedPnlPct <= -1.0%` → 즉시 매도 (수수료 감안 최대 손실 제한)

**② 트레일링 스탑** (고점 추적)
- `peak_price_since_open` 이 있는 경우:
  ```python
  avg = float(c['avg_buy_price'])
  peak = float(c['peak_price_since_open'])
  cur  = float(c['currentPrice'])
  peak_pnl_pct = (peak - avg) / avg * 100
  cur_pnl_pct  = (cur  - avg) / avg * 100
  # 고점 +0.3% 이상 찍은 뒤 0.25% 하락 시 트레일링 익절
  if peak_pnl_pct >= 0.3 and (peak_pnl_pct - cur_pnl_pct) >= 0.25:
      → 트레일링 매도
  ```

**③ 익절**
- `unrealizedPnlPct >= 1.0%` → 즉시 익절 (수수료 제해도 +0.79% 순이익)
- `unrealizedPnlPct >= 0.5%` AND `hold_min >= 5` → 5분 보유 후 빠른 익절 (+0.29% 순이익)

**④ 시간 손절** (5분+ 보유 후)
- `hold_min >= 5 and unrealizedPnlPct <= -0.8%` → 방향 안맞으면 빨리 끊기

**⑤ 강제 청산**
- `hold_min >= 30 and unrealizedPnlPct < 0%` → 30분 보유 후 손실이면 청산

보유시간 계산:
```python
from datetime import datetime, timezone
opened = datetime.fromisoformat(str(c['opened_at']).replace('Z','+00:00'))
hold_min = (datetime.now(timezone.utc) - opened).total_seconds() / 60
```

매도 실행:
```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/sell/<CHAIN_ID>" \
  -H "x-api-key: <DASHBOARD_PASSWORD>"
```

### 3. 피라미딩 — 불타기 (수익 중인 포지션 추가)

**매수보다 먼저 실행.** 기존 CLAUDE 체인 중 조건 충족 시 추가 매수.

조건:
```python
for c in claude_chains:
    avg  = float(c['avg_buy_price'])
    cur  = float(c['currentPrice'])
    pnl  = float(c['unrealizedPnlPct'])
    opened = datetime.fromisoformat(str(c['opened_at']).replace('Z','+00:00'))
    hold_min = (datetime.now(timezone.utc) - opened).total_seconds() / 60

    # 불타기 창: 보유 5~7분 (90초 루프로 최대 1~2회만 해당)
    # 고점 충분히 찍고 → 방향 확인 후 추가 진입
    if 5 <= hold_min < 7 and pnl >= 0.3 and cur > avg:
        → 30만원 추가 매수 (불타기)
```

실행:
```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/manual-buy" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -d "{\"stock_code\":\"XXXXXX\",\"amount_krw\":300000,\"reasoning\":\"불타기 hold{hold}분 PnL+{pnl}%\"}"
```

제한: 현금 300,000원 미만 시 불타기 스킵

---

### 4. 신규 매수 [모의투자 실험모드 — 데이터 최대 수집]

#### Step 1 — 1차 필터 (대시보드 scores[])

**시간대별 기준** (황금시간대일수록 낮은 진입 문턱):
```python
hhmm = int(time_str.replace(':', ''))  # 예: "09:45" → 945
if 915 <= hhmm < 1030:      # 황금시간대 — 방향성 가장 강함
    min_score, min_conf = 55, 0.50
elif 1300 <= hhmm < 1400:   # 오후 집중시간대
    min_score, min_conf = 58, 0.53
else:                        # 그 외 (10:30~13:00)
    min_score, min_conf = 65, 0.58
```

필수 조건:
1. `composite_score >= min_score` (시간대별)
2. `confidence >= min_conf` (시간대별)
3. 이미 OPEN 포지션 없는 종목 (불타기와 별개)
4. `d['killSwitch']['active'] == False`
5. `d['portfolio']['domesticCash'] > 300000`

꽁돈 게이트: `composite_score >= 88` → 2차 필터 무관, 100만원 즉시 매수

#### Step 2 — 2차 필터 (기술 분석 API)
1차 통과 후보 최대 5종목에 대해 개별 기술분석 호출:
```bash
curl -s -H "x-api-key: <DASHBOARD_PASSWORD>" \
  "https://quantops-807105550136.asia-northeast3.run.app/api/stock/XXXXXX/analysis"
```

응답에서 `technicals` 필드 확인:
| 조건 | 기준 | 실패 시 |
|------|------|---------|
| **당일 방향** | `currentPrice > openPrice * 1.003` (당일 +0.3% 이상) | **스킵 — 하락 종목 절대 매수 금지** |
| RSI14 | 15 ≤ RSI ≤ 78 | 스킵 |
| volumeRatio | >= 0.7 | 스킵 |
| overallSignal | STRONG_SELL이 아니면 OK | STRONG_SELL만 스킵 |
| MACD | 필터 없음, 로그만 | 스킵 안함 |

> `currentPrice`, `openPrice` 는 analysis 응답의 `price` 필드에서 확인
> 없으면 dashboard `chains` 의 해당 종목 값 사용

**reasoning 필드에 반드시 아래 정보 모두 포함** (데이터 분석용):
`"AI {score}점 conf{conf} RSI{rsi} vol{volRatio}x MACD{macd} sig{signal} dayChange+{pct}%"`

#### Step 3 — Kelly 비례 베팅 후 실행

**신호 강도별 투자금** (Kelly 원칙: 확신이 클수록 더 투자):
```python
if score >= 88 or conf >= 0.80:
    amount = 700000   # 강한 신호 — 크게 베팅
elif score >= 70 or conf >= 0.68:
    amount = 500000   # 보통 신호
else:                 # score 55~69 (황금시간대 실험)
    amount = 300000   # 약한 신호 — 소액 실험
```

- 점수 내림차순, 최대 3종목

```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/manual-buy" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -d "{\"stock_code\":\"XXXXXX\",\"amount_krw\":AMOUNT,\"reasoning\":\"AI 74점 conf0.62 RSI52 vol1.8x MACDneutral sigNEUTRAL 스캘핑실험\"}"
```

### 5. 루프 간격
- 매도 실행 후: `ScheduleWakeup(120)` — 빠른 재진입 실험
- 매수/불타기 실행 후: `ScheduleWakeup(120)`
- 신호 없음: `ScheduleWakeup(90)` — 1.5분 재스캔 (더 촘촘히)
- 09:05~09:15 초반: `ScheduleWakeup(120)`

### 6. 제한 규칙
- 1회 루프당 신규 매수 최대 3종목
- 신규 진입: 동일 종목 중복 매수 금지 (불타기와 별도)
- `blockNewBuys == true` 이면 매수/불타기 완전 중단
- 총 현금 200,000원 미만이면 매수 중단 (안전마진)

---

## 판단 예시

**강한 신호 큰 베팅 (09:20 황금시간)**: "020000 AI 83점 conf0.78 RSI47 vol2.1x 당일+1.2% → 70만원 매수"

**약한 신호 소액 실험 (황금시간)**: "031820 AI 57점 conf0.52 RSI54 vol0.9x 당일+0.4% → 30만원 실험"

**중간시간 높은 기준**: "058430 AI 63점이나 10:45 중간시간대 기준 65점 미달 → 스킵"

**불타기 성공**: "체인 #41 hold 5.5분 PnL +0.35% 상승중 → 30만원 불타기 추가"

**불타기 SKIP (창 벗어남)**: "체인 #42 hold 8분 → 불타기 창(5~7분) 종료, 스킵"

**매수 SKIP (당일 하락)**: "031820 AI 71점이나 당일 -0.5% 하락 중 → 스킵"

**빠른 익절**: "체인 #42 hold 6분 PnL +0.55% → 5분+ 빠른 익절"

**트레일링**: "체인 #43 고점+0.4%에서 현재+0.12% → 고점-0.28% 하락, 트레일링 매도"

**즉시 손절**: "체인 #44 PnL -1.05% → 즉시 손절"
