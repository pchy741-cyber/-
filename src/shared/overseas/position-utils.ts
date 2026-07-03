/**
 * overseas 포지션 유틸리티 — scheduler/overseas/utils.ts에서 추출
 * 순수 계산 함수만 포함 (DB 의존 없음)
 */
import { getCtxIsPaper } from '../../config/context.js';

/** 현재 컨텍스트의 trading_mode 문자열 반환 */
export function ctxMode(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
}

/** paper/live 분리 state key 접두사 */
export function modePrefix(isPaper?: boolean): string {
  return (isPaper ?? getCtxIsPaper()) ? 'p_' : 'l_';
}

/** PnL% 계산 */
export function calcPnlPct(currentPrice: number, avgPrice: number): number {
  if (avgPrice <= 0) return 0;
  return ((currentPrice - avgPrice) / avgPrice) * 100;
}

/** 포지션 종료 시 정리해야 할 overseas_state 키 배열 반환 */
export function positionStateKeys(code: string, isPaper?: boolean): string[] {
  const pfx = modePrefix(isPaper);
  return [
    `${pfx}maxprice_${code}`,
    `${pfx}partial_tp_stage_${code}`,
    `${pfx}dynamic_tpsl_${code}`,
    `${pfx}scale_in_${code}`,
    `${pfx}turtle_trail_${code}`,
    `${pfx}sync_sell_pending_${code}`,
  ];
}
