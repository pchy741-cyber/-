/**
 * Paper/Live 잔고 조회 통합 헬퍼 — 여러 스케줄러/API 파일에 반복되던
 * `isPaper ? await getPaperBalance() : await getAccountBalance(true)` 분기를 공통화.
 * (동적 import: kis/account.ts ↔ risk/paper-balance.ts 순환참조 방지 — 기존 코드베이스 관례와 동일)
 */
import type { AccountBalance } from '../kis/account.js';

export async function fetchBalance(isPaper: boolean, forceLive = true): Promise<AccountBalance> {
  if (isPaper) {
    const { getPaperBalance } = await import('./paper-balance.js');
    return getPaperBalance();
  }
  const { getAccountBalance } = await import('../kis/account.js');
  return getAccountBalance(forceLive);
}
