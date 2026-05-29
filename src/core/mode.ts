/**
 * core/mode.ts — Paper / Live 모드 단일 출처 (Single Source of Truth)
 *
 * 모든 paper/live 판단은 이 파일에서만 import.
 * 직접 `config.isPaper` 또는 `getCtxIsPaper()` 을 쓰지 말 것.
 *
 * 우선순위:
 *   1. AsyncLocalStorage 컨텍스트 (runWithMode 내부)
 *   2. 전역 기본값 (baseIsPaper, 서버 기동 시 결정)
 */

export {
  runWithMode,
  getCtxIsPaper,
} from '../config/context.js';

export { baseIsPaper } from '../config/index.js';

/**
 * 현재 실행 컨텍스트의 isPaper 값을 반환.
 * runWithMode 바깥에서 호출하면 baseIsPaper 폴백.
 */
export function isPaperCtx(): boolean {
  const { getCtxIsPaper } = require('../config/context.js');
  return getCtxIsPaper();
}
