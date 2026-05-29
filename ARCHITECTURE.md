# QUANTOPS 아키텍처 & 유지보수 가이드

## 모듈 구조

```
src/
├── core/          ★ 신규 — paper/live 단일 출처
│   ├── index.ts   배럴 export
│   └── mode.ts    isPaperCtx(), runWithMode(), baseIsPaper
│
├── config/
│   ├── index.ts   환경변수 + config 객체 (Zod 검증)
│   ├── constants.ts STRATEGY_PARAMS, MARKET, 함수형 동적 계산
│   └── context.ts  AsyncLocalStorage — paper/live 런타임 컨텍스트
│
├── ai/
│   ├── track-a/   Gemini+GPT-4o 일 3회 종목 분석 → ai_scores 저장
│   └── track-b/   Claude 3분 간격 실행 → 실제 주문
│       ├── pipeline.ts      메인 파이프라인
│       ├── decision-flow.ts 결정 처리 단계 (1~9)
│       ├── cash-manager.ts  유휴현금 대형주 파킹
│       ├── technical-fallback.ts AI 없을 때 기술지표만으로 매매
│       └── trading-rules.ts MEGA_CAP_PRIORITY_CODES, PRIORITY_SECTOR_CODES
│
├── risk/          ★ index.ts로 통합 접근
│   ├── index.ts   배럴 — 외부에서 이 파일만 import
│   ├── risk-engine.ts 주문 전 검증 (포지션 한도, 일일 손실)
│   ├── kill-switch.ts 긴급정지 (KR/OVERSEAS 독립)
│   ├── paper-balance.ts Paper 현금 결정론적 계산
│   ├── paper.ts   Paper 주문 실행 어댑터
│   ├── seed-capital.ts 시드 자본 & 일일 손실 한도
│   └── trade-gate.ts 기술적 검수 + 쿨다운
│
├── scheduler/
│   ├── runner.ts          마스터 cron (16개 자동화 모듈)
│   ├── overseas-job.ts    미국주식 오케스트레이터 (~1000줄)
│   ├── overseas/          해외주식 서브모듈 (~22개 파일)
│   │   ├── types.ts       해외 전용 타입
│   │   ├── state.ts       overseas_state DB 접근 (p_/l_ 접두사 필수!)
│   │   ├── watchlist.ts   GLOBAL_WATCHLIST
│   │   ├── sell-logic.ts  매도 판단
│   │   ├── rebalancer.ts  리밸런싱
│   │   └── ...
│   ├── holding-check-job.ts 10분 간격 트레일링 + 조기익절
│   └── after-hours-job.ts  15:42/52 줍줍 스캔
│
├── api/
│   ├── routes/
│   │   ├── settings.ts    /api/kill-switch, /api/strategy, /api/overseas-holdings-fix ...
│   │   ├── dashboard/     /api/dashboard, /api/sell/*, /api/manual-buy ...
│   │   ├── overseas.ts    /api/overseas/dashboard, /api/overseas/scores ...
│   │   └── dashboard-analysis.ts /api/analysis/*, /api/sync-positions ...
│   └── main.ts → rootApp.route('/api', app) ← 모든 API는 /api/ 하위
│
├── trading/
│   ├── executor.ts    국내주식 주문 실행 (KIS API)
│   └── chain.ts       체인 생성/관리 (transaction_chains)
│
├── db/
│   ├── client.ts      pg.Pool + withTransaction + getActiveStrategy
│   ├── models.ts      Zod 스키마 — TradeDecision, TransactionChain ...
│   └── migrations/    SQL 파일 (041개, 순번 엄수)
│
└── kis/               KIS API 클라이언트 (국내/해외 분리)
```

---

## 오염 방지 규칙 (필수)

### 1. Paper/Live 분리
```typescript
// ✅ 올바른 방법 — AsyncLocalStorage 컨텍스트 우선
import { isPaperCtx } from './core/index.js';
const isPaper = isPaperCtx();

// ❌ 금지 — 전역값 직접 참조 (runWithMode 내부에서 컨텍스트 무시)
import { config } from './config/index.js';
const isPaper = config.isPaper; // main.ts, runner.ts 외 사용 금지
```

### 2. overseas_state 키 네이밍
```typescript
// ✅ 항상 is_paper에 따라 접두사 구분
const key = isPaper ? `p_maxprice_${code}` : `l_maxprice_${code}`;

// ❌ 접두사 없이 저장하면 paper/live 공유 → 오염
const key = `maxprice_${code}`;
```

### 3. DB 쿼리 is_paper 필터
```typescript
// ✅ 항상 is_paper 조건 포함
SELECT * FROM transaction_chains WHERE is_paper = $1 AND status = 'OPEN'

// ❌ 필터 없으면 paper+live 혼합 조회
SELECT * FROM transaction_chains WHERE status = 'OPEN'
```

### 4. API 라우트 경로
```
모든 API: /api/{route}
  /api/dashboard          → dashboard/builder.ts
  /api/sell/:id           → dashboard/sell-routes.ts
  /api/manual-buy         → dashboard/sell-routes.ts
  /api/strategy           → settings.ts
  /api/kill-switch        → settings.ts
  /api/overseas-holdings-fix → settings.ts  ← NOT /api/settings/...
  /api/overseas/dashboard → overseas.ts
  /api/sync-positions     → dashboard-analysis.ts
```

---

## 핵심 데이터 흐름

### 국내주식 매매
```
Track A (07:30/12:30/18:00)
  Gemini → 종목 분석
  GPT-4o → 점수 산출 (0~100)
  → ai_scores 테이블 저장

Track B (3분 간격)
  pipeline.ts
    ↓ AI 점수 조회 + 기술지표
    ↓ decision-flow.ts (9단계 필터)
    ↓ executor.ts → KIS API 주문
    ↓ chain.ts → transaction_chains 기록
```

### 해외주식 매매
```
overseas-job.ts (10분 간격, 23:30~06:30 KST)
  ↓ GLOBAL_WATCHLIST 기술지표 계산
  ↓ AI analyzer.ts 분석 (confidence + signal)
  ↓ sell-logic.ts → 매도 판단
  ↓ rebalancer.ts → 리밸런싱 추천
  ↓ buy 로직 → KIS 해외 주문
  ↓ state.ts → overseas_holdings / overseas_state 기록
```

### 현금 흐름 (해외)
```
let cash = getCash(isPaper)         // Paper: orders 테이블 계산, Live: KIS API
↓ evaluateSells() → cash 반환
↓ rebalancePortfolio({ cash })
↓ deployIdleCash({ cash })
```

---

## 자주 하는 실수

| 실수 | 올바른 방법 |
|------|------------|
| `config.isPaper` 직접 | `isPaperCtx()` 사용 |
| `/api/settings/xxx` | `/api/xxx` (settings 접두사 없음) |
| overseas_state 키 미접두사 | `p_` / `l_` 접두사 필수 |
| `as any` 남발 | db/models.ts에 Zod 타입 추가 |
| 큰 파일에 새 함수 추가 | 1000줄 초과 파일은 서브모듈로 분리 |

---

## 파일 크기 가이드라인
- 200줄 이하: 이상적
- 200~500줄: 허용
- 500~800줄: 리뷰 필요
- 800줄+: 분할 검토 (현재 예외: overseas-job.ts, self-learning.ts는 단계적 분할 예정)
