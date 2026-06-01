/**
 * 실전모드 PIN 보호 + 모드 해석 유틸리티
 * paper 모드: PIN 불필요 (자유롭게 테스트)
 * live 모드: PIN 4자리 필수 (의도적 확인)
 */
import { baseIsPaper } from '../../config/index.js';
import { getPool } from '../../db/client.js';

const LIVE_PIN = '7012';

export interface PinValidation {
  ok: boolean;
  error?: string;
}

/**
 * live 모드일 때 PIN 검증. paper 모드는 항상 통과.
 */
export function validateLivePin(isPaper: boolean, pin?: string): PinValidation {
  if (isPaper) return { ok: true };
  if (!pin) return { ok: false, error: '실전모드: PIN 4자리를 입력하세요' };
  if (pin !== LIVE_PIN) return { ok: false, error: '실전모드: PIN이 틀렸습니다' };
  return { ok: true };
}

/** body.mode에서 isPaper 해석 — 'live' 명시 시 false, 그 외 서버 기본값 */
export function resolveIsPaper(mode?: 'paper' | 'live'): boolean {
  return mode === 'live' ? false : baseIsPaper;
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
