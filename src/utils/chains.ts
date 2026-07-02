import type { TransactionChain } from '../db/models.js';

/** 여러 파일에서 반복되던 "실보유 중(수량>0) 종목코드 집합" 추출 패턴을 공통화. */
export function getActivePositionCodes(chains: TransactionChain[]): Set<string> {
  return new Set(chains.filter((c) => Number(c.total_quantity) > 0).map((c) => c.stock_code));
}

/** 특정 종목코드를 실보유(수량>0) 중인지 확인. */
export function isCodeHeld(chains: TransactionChain[], code: string): boolean {
  return chains.some((c) => c.stock_code === code && Number(c.total_quantity) > 0);
}
