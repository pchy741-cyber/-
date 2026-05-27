/**
 * AsyncLocalStorage 기반 거래 모드 컨텍스트
 *
 * 스케줄러 dual-run과 HTTP 요청이 동시에 실행돼도
 * 각자 독립된 isPaper 값을 갖도록 보장합니다.
 * (전역 변수 오염 원천 차단)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface TradingCtx {
  isPaper: boolean;
}

const _store = new AsyncLocalStorage<TradingCtx>();

const _BASE_IS_PAPER = process.env.TRADING_MODE !== 'live';

/**
 * fn을 지정된 isPaper 컨텍스트 안에서 실행합니다.
 * runOverseasDual(), runDomesticDual() 등에서 전역 오버라이드 대신 사용.
 */
export function runWithMode<T>(isPaper: boolean, fn: () => Promise<T>): Promise<T> {
  return _store.run({ isPaper }, fn);
}

/**
 * 현재 async 컨텍스트의 isPaper 값을 반환합니다.
 * 컨텍스트가 없으면 env TRADING_MODE 기본값을 반환합니다.
 */
export function getCtxIsPaper(): boolean {
  return _store.getStore()?.isPaper ?? _BASE_IS_PAPER;
}

/** 현재 컨텍스트가 설정돼 있는지 (스케줄러/미들웨어에서 주입했는지) */
export function hasCtx(): boolean {
  return _store.getStore() !== undefined;
}
