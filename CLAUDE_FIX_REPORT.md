# CLAUDE FIX REPORT

이 문서는 현재 코드베이스의 충돌/교차오염 이슈를 빠르게 수정하기 위한 작업 지시서이며,
동시에 "절대 수익(항상 수익)" 구조 가능성에 대한 현실적인 피드백을 포함한다.

---

## 1) 지금 당장 고쳐야 할 이슈 (우선순위 순)

### P0. paper/live 주문 중복키 교차오염
- 파일: `src/trading/executor.ts`
- 문제: 분당 중복 주문 키가 `stock+action+minute`만 포함하고 모드가 없다.
- 영향: `runDomesticDual()`에서 paper 주문이 live 주문을 같은 분에 막을 수 있다.
- 수정 지시:
  - `_minuteKey()`에 모드 접두(`paper`/`live`)를 포함.
  - `_recentOrderKeys` 정리 로직도 모드 포함 키 기준으로 동작.
- 검증:
  - 같은 분에 같은 종목 BUY를 paper/live 연속 실행해도 서로 차단되지 않아야 한다.

### P1. Track-B 재스캔 타이머 단일 전역
- 파일: `src/scheduler/track-b-job.ts`
- 문제: `pendingRescanTimer`가 하나라서 paper 예약을 live가 취소할 수 있다.
- 수정 지시:
  - `Map<'paper'|'live', Timeout>` 형태로 분리.
  - 예약/취소/해제 전부 현재 컨텍스트 모드 기준으로 처리.
- 검증:
  - paper에서 매도 후 재스캔 예약 + live 매도 동시 발생 시 각자 재스캔이 살아 있어야 한다.

### P1. overseas-job 실행락 공용 상태
- 파일: `src/scheduler/overseas/session.ts`, `src/scheduler/overseas-job.ts`
- 문제: `overseasState.isRunning`이 단일 boolean.
- 영향: 모드별 실행이 서로 스킵될 수 있다.
- 수정 지시:
  - `isRunning`을 모드별 상태(`Map<Mode, boolean>`)로 분리.
  - 타임아웃 해제/finally 해제도 모드별로 분리.
- 검증:
  - paper/live 연속 실행 시 서로 독립적으로 lock/unlock 되어야 한다.

### P2. BigQuery 실패-성공 로그 모순
- 파일: `src/automation/bigquery-pipeline.ts`, `src/main.ts`
- 문제: 내부에서 에러를 삼키는데 호출부는 `.then(성공로그)`를 찍는다.
- 수정 지시:
  - `initBigQuery(): Promise<boolean>`로 변경하거나 실패 시 throw.
  - 부팅 로그를 반환값 기준으로 분기.
- 검증:
  - 인증 실패 시 "비활성" 로그만, 성공 시 "연결" 로그만 남아야 한다.

### P2. Windows 빌드 스크립트 실패
- 파일: `package.json`
- 문제: `rm -rf dist` 사용으로 PowerShell에서 빌드 실패.
- 수정 지시:
  - `rimraf dist` 또는 Node 내장 삭제 방식으로 교체.
- 검증:
  - Windows PowerShell에서 `npm run build`가 정상 종료.

### P3. 무결성 스크립트 DB 접속 하드코딩
- 파일: `check-integrity.mjs`
- 문제: `127.0.0.1:5434` 고정으로 운영/개발 환경 공용 점검이 어렵다.
- 수정 지시:
  - `DATABASE_URL` 또는 `DB_*` 환경변수 우선 사용.
  - 필요시 `--host --port --db` CLI 인자 지원.
- 검증:
  - 로컬/Cloud SQL 환경 모두에서 같은 스크립트로 점검 가능.

---

## 2) 검증 로그 요약 (근거)

- `node check-integrity.mjs` 실패: `ECONNREFUSED 127.0.0.1:5434`
- `npm run lint`: 대량 오류(400+), 진단 상한 초과
- `npm run test`: `1 failed / 25 passed`
  - 실패 케이스: 상승장 시뮬레이션에서 `totalReturnPct = -1.63%` (기대: `> 0`)
- `npm run build`: Windows에서 `rm` 명령 미지원으로 실패

---

## 3) "절대 수익 구조" 가능성 피드백

## 결론 (짧게)
- 현재 구조는 **절대 수익(항상 수익)** 을 보장하는 구조가 아니다.
- 다만, 구조를 개선하면 **손실 꼬리 리스크를 줄이고 양(+)의 기대값**에 가까워질 수는 있다.

## 왜 절대 수익이 불가능한가
- 시장은 비정상 구간(갭다운, 유동성 급감, 체결 공백, 뉴스 쇼크)이 반복된다.
- 실행계층(슬리피지/미체결/지연) 때문에 백테스트와 실거래 수익률은 다르게 나온다.
- 현재도 상승장 시뮬레이션 실패가 존재하므로 "항상 이긴다"는 가정은 성립하지 않는다.

## 현재 구조의 장점 (이미 좋은 점)
- paper/live 분리 의도가 명확하고 AsyncLocalStorage 기반 컨텍스트가 있다.
- Kill Switch, 포지션/손실 제한, 모드 전환 등 리스크 가드가 다층이다.
- 해외/국내를 분리하고, 여러 자동화 파이프라인을 운용 중이다.

## 절대수익 대신 "고확률 생존+우상향"으로 바꾸는 핵심

### 1) 승률보다 기대값 관리
- 목표 지표를 `승률`이 아니라 `기대값`, `Profit Factor`, `MDD`, `Tail Loss`로 이동.
- 전략별로 "수익이 나는 시장 레짐"을 분리하고, 아닌 구간은 아예 거래 중단.

### 2) 손실 상한 하드 차단
- 일손실, 주손실, 월손실 3단계 하드 스탑.
- 연속 손실 N회 시 자동 사이즈 축소(예: 1.0x -> 0.7x -> 0.5x).
- 변동성 급등 시 신규 진입을 막고 청산/축소만 허용.

### 3) 실행 품질 지표를 전략 성과와 분리 추적
- 신호 품질(모델)과 체결 품질(실행)을 분리 저장.
- 슬리피지, 체결지연, 부분체결률이 임계치 넘으면 해당 전략 자동 비활성.

### 4) 레짐별 메타-라우팅
- 단일 전략 상시 실행 대신:
  - 추세장: 추세형
  - 박스장: mean-reversion 또는 no-trade
  - 쇼크장: 방어모드/현금
- "모르면 거래 안 함(no-trade is a position)"을 룰로 강제.

---

## 4) 클로드 구현 순서 (추천)

1. P0/P1 교차오염 3개 먼저 수정 (executor, track-b-job, overseas-job).
2. Windows build 고치고 CI에서 `build/test` 강제.
3. BigQuery 초기화 성공/실패 로그 정합화.
4. integrity 스크립트 env 기반으로 전환.
5. 마지막으로 전략 성과 KPI 리포트에 아래 항목 추가:
   - 기대값(EV), PF, MDD, 95/99% 손실분위, 슬리피지 평균/상위10%

---

## 5) 수용 기준 (Definition of Done)

- paper/live 동시 스케줄에서 상호 차단/타이머 취소가 재현되지 않는다.
- Windows에서 `npm run build` 성공.
- BigQuery 실패 시 성공 로그가 찍히지 않는다.
- 시뮬레이션 기준:
  - 상승장: totalReturnPct > 0
  - 횡보장: MDD 제한 내
  - 스트레스장: 강제 손실 상한 준수
- 운영 기준:
  - 일손실 상한 초과 0건
  - 오탐/중복 주문 건수 주간 기준 0 또는 허용 임계 이하

---

## 6) 한 줄 최종 의견

현재 시스템은 "절대 수익 보장형"이 아니라 "리스크 관리형 자동매매"에 가깝다.
정답은 절대수익 약속이 아니라, **교차오염 제거 + 손실 상한 통제 + 레짐 기반 무거래 룰**로 기대값을 높이는 방향이다.
