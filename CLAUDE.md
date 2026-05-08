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
- **09:15~14:50** → 정상 매매 구간
- **14:50~15:20** → 마감 30분 → 신규 매수 금지, 기존 포지션 정리만
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
- `unrealizedPnlPct <= -3.0%` → 즉시 매도 (실험: 좀 더 기다려봄)

**② 트레일링 스탑** (고점 추적)
- `peak_price_since_open` 이 있는 경우:
  ```python
  avg = float(c['avg_buy_price'])
  peak = float(c['peak_price_since_open'])
  cur  = float(c['currentPrice'])
  peak_pnl_pct = (peak - avg) / avg * 100
  cur_pnl_pct  = (cur  - avg) / avg * 100
  # 고점 PnL 대비 0.6% 이상 하락 시 트레일링 손절 (실험: 타이트하게)
  if peak_pnl_pct >= 0.5 and (peak_pnl_pct - cur_pnl_pct) >= 0.6:
      → 트레일링 매도
  ```

**③ 익절 — 단계별 실험**
- `unrealizedPnlPct >= 2.0%` → 1차 익절
- `unrealizedPnlPct >= 1.2%` AND `hold_min >= 5` → 5분 보유 후 1.2% 익절

**④ 시간 손절** (7분+ 보유 후 — 실험: 더 빨리)
- `hold_min >= 7 and unrealizedPnlPct <= -1.5%` → 손절

**⑤ 강제 청산** (장기 보유 단축)
- `hold_min >= 60 and unrealizedPnlPct < 0%` → 60분 보유 후 손실이면 청산

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

### 3. 매수 판단 [모의투자 실험모드 — 데이터 최대 수집]

#### Step 1 — 1차 필터 (대시보드 scores[])
필수 조건:
1. `composite_score >= 60` (실험: 넓게 잡아 더 많은 진입 시도)
2. `confidence >= 0.55` (실험: confidence 하한 완화)
3. 이미 OPEN 포지션 없는 종목
4. `d['killSwitch']['active'] == False`
5. `d['portfolio']['domesticCash'] > 300000`

꽁돈 게이트: `composite_score >= 88` → 2차 필터 무관하고 즉시 매수

#### Step 2 — 2차 필터 (기술 분석 API — 로그용, 극단만 제외)
1차 통과 후보 최대 5종목에 대해 개별 기술분석 호출:
```bash
curl -s -H "x-api-key: <DASHBOARD_PASSWORD>" \
  "https://quantops-807105550136.asia-northeast3.run.app/api/stock/XXXXXX/analysis"
```

응답에서 `technicals` 필드 확인:
| 조건 | 기준 | 실패 시 |
|------|------|---------|
| RSI14 | 15 ≤ RSI ≤ 78 | 스킵 (극단 과매수/과매도만 제외) |
| volumeRatio | >= 0.7 | 스킵 (거의 거래없는 종목만 제외) |
| overallSignal | STRONG_SELL이 아니면 OK | STRONG_SELL만 스킵 |
| MACD | 필터 없음, 로그만 | 스킵 안함 |

**reasoning 필드에 반드시 아래 정보 모두 포함** (데이터 분석용):
`"AI {score}점 conf{conf} RSI{rsi} vol{volRatio}x MACD{macd} sig{signal} hold{targetMin}분목표"`

#### Step 3 — 매수 실행
- 점수 내림차순, 최대 3종목
- 1종목당 500,000원 (소액 분산, 더 많은 종목 실험)

```bash
curl -s -X POST "https://quantops-807105550136.asia-northeast3.run.app/api/manual-buy" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <DASHBOARD_PASSWORD>" \
  -d "{\"stock_code\":\"XXXXXX\",\"amount_krw\":500000,\"reasoning\":\"AI 74점 conf0.62 RSI52 vol1.8x MACDneutral sigNEUTRAL 스캘핑실험\"}"
```

### 4. 루프 간격
- 매도 실행 후: `ScheduleWakeup(120)` — 빠른 재진입 실험
- 매수 실행 후: `ScheduleWakeup(120)`
- 신호 없음: `ScheduleWakeup(90)` — 1.5분 재스캔 (더 촘촘히)
- 09:05~09:15 초반: `ScheduleWakeup(120)`

### 5. 제한 규칙
- 1회 루프당 최대 매수 3종목
- 동일 종목 중복 매수 금지
- `blockNewBuys == true` 이면 매수 완전 중단
- 총 현금 200,000원 미만이면 매수 중단 (안전마진)

---

## 판단 예시

**매수 OK**: "020000 AI 74점 conf 0.75, RSI=52, vol=1.8x, MACD양전 → 100만원 매수"

**매수 SKIP (RSI)**: "058430 AI 74점이나 RSI=72 과매수 → 스킵"

**매수 SKIP (거래량)**: "044820 AI 72점이나 volumeRatio=0.9 → 스킵"

**익절**: "체인 #42 PnL +1.6% → 익절"

**트레일링**: "체인 #43 고점 +2.1%에서 현재 +1.2% → 고점-0.9% 하락, 트레일링 매도"

**90분 청산**: "체인 #44 보유 92분, PnL -0.3% → 90분 손실 강제 청산"
