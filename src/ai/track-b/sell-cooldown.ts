/**
 * 인메모리 매도 쿨다운 상태 머신
 * (pipeline.ts에서 추출)
 *
 * v10.4: DB 반영 전에도 재매수 차단 (churning 방지)
 * v10.5: paper/live 모드별 분리 (크로스오염 방지)
 * v21: 손절 매도 쿨다운 2h→4h, 당일 2회 손절 시 재진입 완전 차단
 */
// paper/live 모드별 분리 (크로스오염 방지 — Paper 매도가 Live 차단하던 버그 수정)
const _recentSellTimestamps = new Map<string, Map<string, number>>(); // mode → (stock_code → epoch ms)
const MEMORY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 익절 매도: 2시간 유지
const STOPLOSS_COOLDOWN_MS = 4 * 60 * 60 * 1000; // v21: 손절 매도: 4시간 (2h→4h, 반복 손절 방지)

// 손절 매도 여부 추적 (쿨다운 시간 분기용)
const _isStopLossSell = new Map<string, Map<string, boolean>>(); // mode → (stock_code → isStopLoss)

// v21: 당일 손절 횟수 추적 (같은 종목 당일 2회 손절 → 재진입 완전 차단)
const _dailyStopLossCount = new Map<string, Map<string, number>>(); // mode → (stock_code → count)
let _dailyCountDate = ''; // YYYY-MM-DD (날짜 변경 시 리셋)

function _getSellMapFor(isPaper: boolean): Map<string, number> {
  const mode = isPaper ? 'paper' : 'live';
  if (!_recentSellTimestamps.has(mode)) _recentSellTimestamps.set(mode, new Map());
  return _recentSellTimestamps.get(mode)!;
}

function _getStopLossMapFor(isPaper: boolean): Map<string, boolean> {
  const mode = isPaper ? 'paper' : 'live';
  if (!_isStopLossSell.has(mode)) _isStopLossSell.set(mode, new Map());
  return _isStopLossSell.get(mode)!;
}

function _getDailySlCountFor(isPaper: boolean): Map<string, number> {
  const mode = isPaper ? 'paper' : 'live';
  // 날짜 변경 시 전체 리셋
  const today = new Date().toISOString().split('T')[0];
  if (_dailyCountDate !== today) {
    _dailyStopLossCount.clear();
    _dailyCountDate = today;
  }
  if (!_dailyStopLossCount.has(mode)) _dailyStopLossCount.set(mode, new Map());
  return _dailyStopLossCount.get(mode)!;
}

/**
 * 매도 실행 시 호출 — 인메모리 쿨다운 기록.
 * CEO 지적(2026-07-02): 매도 체결부터 기록까지 여러 await를 거치는 실행 경로에서
 * 앰비언트 AsyncLocalStorage(getCtxIsPaper())에 의존하면 컨텍스트 유실 시 잘못된
 * 모드로 기록될 수 있음(006340 대원전선 21분만에 재진입 허용 사례) — 호출부가
 * 캡처해둔 isPaper 값을 명시적으로 넘기도록 강제.
 *
 * v21: isStopLoss 플래그 추가 — 손절 시 4시간, 익절 시 2시간 쿨다운 분기
 */
export function recordSellForCooldown(stockCode: string, isPaper: boolean, isStopLoss = false): void {
  _getSellMapFor(isPaper).set(stockCode, Date.now());
  _getStopLossMapFor(isPaper).set(stockCode, isStopLoss);

  // 당일 손절 횟수 누적
  if (isStopLoss) {
    const slMap = _getDailySlCountFor(isPaper);
    slMap.set(stockCode, (slMap.get(stockCode) ?? 0) + 1);
  }
}

/** 인메모리 쿨다운 중인 종목 Set 반환 (명시적 모드 전용) */
export function getMemoryCooldownCodes(isPaper: boolean): Set<string> {
  const now = Date.now();
  const map = _getSellMapFor(isPaper);
  const slMap = _getStopLossMapFor(isPaper);
  const result = new Set<string>();
  for (const [code, ts] of map) {
    const isStopLoss = slMap.get(code) ?? false;
    const cooldownMs = isStopLoss ? STOPLOSS_COOLDOWN_MS : MEMORY_COOLDOWN_MS;
    if (now - ts < cooldownMs) {
      result.add(code);
    } else {
      map.delete(code); // 만료 정리
      slMap.delete(code);
    }
  }
  return result;
}

/**
 * v21: 당일 동일 종목 2회 이상 손절 여부 확인
 * @returns true = 재진입 차단 (당일 2회 손절됨)
 */
export function isDailyStopLossBlocked(stockCode: string, isPaper: boolean): boolean {
  if (isPaper) return false; // Paper 모드 면제
  const slMap = _getDailySlCountFor(isPaper);
  return (slMap.get(stockCode) ?? 0) >= 2;
}
