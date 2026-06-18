# QUANTOPS Track B — 수치 스냅샷 (v11, 2026-06-18)

## 1. 전략 파라미터

| 모드 | threshold | TP | SL | splitCount | maxDaily |
|------|-----------|----|----|------------|----------|
| SWING | 83 | 7.0% | 2.5% | 1 | 2 |
| DEFENSE | 75 | 5.0% | 2.0% | 4 | – |
| SCALPING | 70 | 1.5% | 1.2% | 1 | – |
| SNIPER | 85 | 8.0% | 2.0% | 1 | – |
| BREAKOUT | 70 | 6.0% | 2.5% | 1 | – |
| BOTTOM_FISHING | 72 | 6.0% | 2.5% | 1 | – |

왕복 수수료+세금: **0.21%** / 슬리피지 포함 **0.26%**

---

## 2. 손익분기 WR

```
p × (TP − 0.26) = (1−p) × (SL + 0.26)
SWING  (7.0/2.5):  p = 29.1%   실전WR 30% → 흑자 +0.9%
SNIPER (8.0/2.0):  p = 25.4%   R:R = 4:1
SCALP  (1.5/1.2):  p = 45.6%   자동 비활성화 (WR 25.7%)
```

---

## 3. Kelly Criterion

```
f* = (b×WR − (1−WR)) / b      b = TP/SL
SWING: f* = (2.8×0.30 − 0.70) / 2.8 = +5.0%  ← 양수(흑자 구간)
Fallback: 과거10건 WR < 22% → f*=0, 최소비중 고정
```

**연속손실 배율**: 1패×0.9 / 2패×0.7 / 3패×0.5 / 4패×0.35

---

## 4. 포지션 사이징

```
base = Kelly × macroSizingMult × (score/100) × consecutiveMult
Hard Cap: 25% / 종목
macroSizingMult: RISK_OFF=0.7 / 하락장=0.6 / 조정=0.8 / 정상=1.0
```

---

## 5. 트레일링 스탑

```
활성: peak ≥ +1.5%
peak ≥ 9%  → drop 1.2%
peak ≥ 6%  → drop 1.8%
peak ≥ 4%  → drop 2.2%
peak ≥ 2%  → drop 2.6%
peak < 2%  → drop 3.0%
```
> ⚠️ 외부AI 피드백: 1.2% 하한 타이트 → 1.5% 상향 검토 필요

---

## 6. 시간대 필터 (v11)

```
09:00~10:00  → 전 전략 허용 (황금 윈도우)
10:00~11:30  → SNIPER 전용
11:30~13:00  → 전면 차단
13:00~14:00  → SNIPER 전용
14:00+       → 전면 차단
```
Paper 모드: 전 시간대 면제 (`!ctxIsPaper &&` 접두사)

---

## 7. SNIPER 자동전환 조건

```typescript
dbMode === 'SWING'
  && highScoreCount >= 1   // v11: 2→1
  && !autoShouldDefense
  && dailyPnlPct > -1.0
```

---

## 8. KOSPI 레짐 감산

| 레짐 | score 감산 | sizingMult |
|------|-----------|------------|
| RISK_OFF | -15 | 0.7 |
| BEAR | -10 | 0.6 |
| CORRECTION | -5 | 0.8 |
| NORMAL | 0 | 1.0 |

---

## 9. 일일 리스크 한도

```
일일 손실 한도: 시드의 2.5%
단일 종목 최대 손실: 25% cap × 10% 손절 = 2.5% (정합)
Kill Switch: 3연패 OR 일손실 2.5% 초과 시 자동 발동
```

---

## 10. Paper vs Live

| 항목 | Paper | Live |
|------|-------|------|
| confidence 기준 | 0.3 | 0.6 |
| 시간대 제한 | 없음 | 전체 적용 |
| 일손실 차단 | 없음 | 2.5% |
| 목적 | 데이터 축적 | 원금 보호 |
