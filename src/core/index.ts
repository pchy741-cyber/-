/**
 * core/index.ts — 핵심 비즈니스 로직 배럴
 *
 * ┌─ 모드 컨텍스트 ─────────────────────────────────────────┐
 * │ isPaperCtx() · runWithMode() · baseIsPaper              │
 * └─────────────────────────────────────────────────────────┘
 *
 * 오염 방지 규칙:
 *   - paper/live 분기는 반드시 isPaperCtx() 사용
 *   - config.isPaper 직접 참조는 main.ts, runner.ts 외 금지
 *   - overseas_state 키는 반드시 p_ / l_ 접두사 사용
 */
export { baseIsPaper, isPaperCtx, runWithMode } from './mode.js';
