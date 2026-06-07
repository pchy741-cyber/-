/**
 * 실전모드 보호 + 모드 해석 유틸리티
 *
 * v4: LIVE_ENABLED=false (기본값) → 실전 거래 완전 차단
 *     사용자가 "실전 해보자" 할 때까지 paper 전용
 *     설정에서 LIVE_ENABLED=true로 전환 시 PIN 검증 후 실전 가능
 */
import { baseIsPaper } from '../../config/index.js';
import { getPool } from '../../db/client.js';

const LIVE_PIN = '7012';

/** v4: 실전 거래 마스터 스위치 — false면 모든 live 요청 차단 */
let _liveEnabled = (process.env.LIVE_ENABLED ?? 'false') === 'true';
export function isLiveEnabled(): boolean { return _liveEnabled; }
export function setLiveEnabled(enabled: boolean): void { _liveEnabled = enabled; }

export interface PinValidation {
  ok: boolean;
  error?: string;
}

/**
 * live 모드일 때 검증. paper 모드는 항상 통과.
 * v4: LIVE_ENABLED=false → live 거래 자체가 불가
 */
export function validateLivePin(isPaper: boolean, pin?: string): PinValidation {
  if (isPaper) return { ok: true };
  // v4: 실전 마스터 스위치 OFF → 무조건 차단
  if (!_liveEnabled) return { ok: false, error: '실전모드 비활성화 상태입니다. 설정에서 Live를 켜주세요.' };
  if (!pin) return { ok: false, error: '실전모드: PIN 4자리를 입력하세요' };
  if (pin !== LIVE_PIN) return { ok: false, error: '실전모드: PIN이 틀렸습니다' };
  return { ok: true };
}

/** mode 또는 viewMode에서 isPaper 해석 — 'paper' → true, 'live' → false, 미지정 → 서버 기본값 */
export function resolveIsPaper(mode?: string | null): boolean {
  if (mode === 'paper') return true;
  if (mode === 'live') return false;
  return baseIsPaper;
}

/**
 * Hono request에서 viewMode/mode 통합 파싱
 * 우선순위: viewMode > mode > 서버 기본값
 * 프론트엔드가 어떤 파라미터명을 보내든 동작하도록 양쪽 모두 확인
 */
export function resolveRequestMode(c: { req: { query: (k: string) => string | undefined } }): boolean {
  const vm = c.req.query('viewMode') ?? c.req.query('mode');
  return resolveIsPaper(vm);
}

// ── 선물 예산 모드별 컬럼 ──

export const BUDGET_COLS = {
  paper: { allocated: 'allocated_krw_paper', pnl: 'total_pnl_usd_paper', margin: 'used_margin_usd_paper' },
  live: { allocated: 'allocated_krw_live', pnl: 'total_pnl_usd_live', margin: 'used_margin_usd_live' },
} as const;

export function budgetCol(isPaper: boolean) {
  return isPaper ? BUDGET_COLS.paper : BUDGET_COLS.live;
}

// ── 선물 trades PnL 합산 (모드별) ──

export async function getFuturesPnlByMode(): Promise<{ paper: number; live: number }> {
  const { rows } = await getPool().query(`
    SELECT is_paper, COALESCE(SUM(pnl_usd), 0) AS total_pnl
    FROM futures_trades WHERE pnl_usd IS NOT NULL
    GROUP BY is_paper
  `);
  return {
    paper: Number(rows.find((r: any) => r.is_paper)?.total_pnl ?? 0),
    live: Number(rows.find((r: any) => !r.is_paper)?.total_pnl ?? 0),
  };
}
