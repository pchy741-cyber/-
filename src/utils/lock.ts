/**
 * 매매 동시성 보호 (Mutex Lock)
 *
 * 같은 종목에 대해 동시에 매수/매도 주문이 들어가는 것을 방지
 * - Track B가 3분 간격으로 실행되지만, 이전 실행이 느려져 겹칠 수 있음
 * - 수동 매도 + AI 매도가 동시에 들어올 수 있음
 */

import { getCtxIsPaper } from '../config/context.js';
import { logger } from './logger.js';

const locks = new Map<string, { lockedAt: Date; owner: string; ttlMs: number }>();
const LOCK_TIMEOUT_MS = 45_000; // 기본 TTL: 45초 (체결확인 31초 + 여유 14초)

/**
 * 종목별 락 획득
 * @param ttlMs 락 TTL (기본 45초). 용도별 조정: 빠른 매매 30초, 배치 60초
 * @returns unlock 함수. 반드시 finally에서 호출할 것.
 */
export async function acquireLock(stockCode: string, owner: string, ttlMs?: number): Promise<(() => void) | null> {
  const lockTtl = ttlMs ?? LOCK_TIMEOUT_MS;
  // paper/live 모드별 독립 락 — paper 005930 매매가 live 005930을 차단하지 않음
  const modePrefix = getCtxIsPaper() ? 'P:' : 'L:';
  const lockKey = `${modePrefix}${stockCode}`;
  const existing = locks.get(lockKey);

  // 이미 락이 잡혀있으면
  if (existing) {
    const elapsed = Date.now() - existing.lockedAt.getTime();

    // 개별 락 TTL 초과 → 강제 해제
    if (elapsed > existing.ttlMs) {
      logger.warn(
        `🔓 종목 락 타임아웃 강제 해제: ${lockKey} (owner: ${existing.owner}, ${Math.round(elapsed / 1000)}초/${Math.round(existing.ttlMs / 1000)}초)`,
        { component: 'LOCK' },
      );
      locks.delete(lockKey);
    } else {
      // 락 획득 실패
      return null;
    }
  }

  // 락 획득
  locks.set(lockKey, { lockedAt: new Date(), owner, ttlMs: lockTtl });
  const myEntry = locks.get(lockKey)!;

  // Only delete if the current entry is still ours — prevents clearing a new owner's lock
  // when our TTL expired, we were force-released, and another caller re-acquired the same key.
  return () => {
    if (locks.get(lockKey) === myEntry) {
      locks.delete(lockKey);
    }
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

