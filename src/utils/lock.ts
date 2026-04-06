/**
 * 매매 동시성 보호 (Mutex Lock)
 *
 * 같은 종목에 대해 동시에 매수/매도 주문이 들어가는 것을 방지
 * - Track B가 10분 간격으로 실행되지만, 이전 실행이 느려져 겹칠 수 있음
 * - 수동 매도 + AI 매도가 동시에 들어올 수 있음
 */

const locks = new Map<string, { lockedAt: Date; owner: string }>();
const LOCK_TIMEOUT_MS = 60_000; // 1분 초과하면 자동 해제 (데드락 방지)

/**
 * 종목별 락 획득
 * @returns unlock 함수. 반드시 finally에서 호출할 것.
 */
export async function acquireLock(stockCode: string, owner: string): Promise<(() => void) | null> {
  const existing = locks.get(stockCode);

  // 이미 락이 잡혀있으면
  if (existing) {
    const elapsed = Date.now() - existing.lockedAt.getTime();

    // 타임아웃 초과 → 강제 해제
    if (elapsed > LOCK_TIMEOUT_MS) {
      locks.delete(stockCode);
    } else {
      // 락 획득 실패
      return null;
    }
  }

  // 락 획득
  locks.set(stockCode, { lockedAt: new Date(), owner });

  return () => {
    locks.delete(stockCode);
  };
}

/**
 * 현재 락 상태 조회 (디버깅/모니터링용)
 */
export function getActiveLocks(): Array<{ stockCode: string; owner: string; elapsed: number }> {
  const result: Array<{ stockCode: string; owner: string; elapsed: number }> = [];

  for (const [stockCode, info] of locks.entries()) {
    result.push({
      stockCode,
      owner: info.owner,
      elapsed: Date.now() - info.lockedAt.getTime(),
    });
  }

  return result;
}

/**
 * 파이프라인 실행 가드 (Track A/B 중복 실행 방지)
 */
const pipelineLocks = new Set<string>();

export function acquirePipelineLock(name: string): boolean {
  if (pipelineLocks.has(name)) return false;
  pipelineLocks.add(name);
  return true;
}

export function releasePipelineLock(name: string): void {
  pipelineLocks.delete(name);
}
