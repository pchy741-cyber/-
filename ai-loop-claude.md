# AI Trading Loop — Claude Code 분석 가이드

## 핵심 원칙
- **READ-ONLY**: 코드 수정 절대 금지. API 호출만 허용.
- **안전 우선**: Kill Switch ON이면 즉시 중단. 의심스러운 상황은 HOLD.
- **비용 $0**: 서버 Gemini API 호출 없음. Claude Code 구독 토큰만 사용.

## 실행 방법 (Claude Code 터미널에서)

### 1. 스냅샷 조회
```bash
bash ai-loop.sh paper     # Paper 모드
bash ai-loop.sh live      # Live 모드
```

### 2. 분석 후 명령 전송
```bash
bash ai-loop.sh paper '{"commands":[{"type":"setOverride","category":"stock","key":"005930_scoreAdj","value":5,"reason":"실적 호조 예상","ttlMinutes":120}]}'
```

### 3. 판단큐 처리
```bash
bash ai-loop.sh paper decide   # 대기 중인 판단 조회
# 판단 결과 제출은 curl로 직접
```

## 분석 프레임워크

스냅샷을 받으면 아래 순서로 분석:

### Phase 1: 리스크 체크
- Kill Switch ON → 매매 중단 권고
- 30일 승률 < 40% → 보수적 모드 권고 (minBuyScore 상향)
- 포지션 수 > 10 → 분산 과다, 정리 권고

### Phase 2: 포지션 분석 (보유 종목)
- PnL > +8% + RSI > 70 → trailTighten 오버라이드 (수익 보호)
- PnL < -5% + 승률 낮은 종목 → forceHold 해제 or blacklist 고려
- 같은 섹터 3종목 이상 → 섹터 집중도 경고

### Phase 3: 신규 매수 판단
- AI score ≥ 70 + confidence ≥ 0.65 → 유망 종목
- AI score < 50 + 감시목록에 있으면 → scoreAdj -10
- 시장 컨센서스 BEARISH → minBuyScore 80으로 상향

### Phase 4: 오버라이드 관리
- 만료 임박한 오버라이드 갱신 또는 제거
- 불필요한 오버라이드 정리 (시장 상황 변화)

## 명령어 레퍼런스

| 명령 | 카테고리 | 예시 | 범위 |
|------|----------|------|------|
| `{code}_scoreAdj` | stock | +5 ~ -10 | -20 ~ +20 |
| `{code}_blacklist` | stock | true | boolean |
| `{code}_forceHold` | signal | true | boolean |
| `{code}_trailTighten` | stock | 1.0 | 0 ~ 3% |
| `minBuyScore` | threshold | 75 | 55 ~ 95 |
| `maxPositionPct` | risk | 15 | 5 ~ 25% |
| `stopLossPct` | risk | -5 | -10 ~ -1% |

## 루프 주기 권장
- 한국장 (09:00~15:30): 10~15분 간격
- 미국장 (23:30~06:00): 15~30분 간격
- 비장중: 1시간 간격 또는 수동
