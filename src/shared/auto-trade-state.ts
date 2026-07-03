/**
 * 자동매매 ON/OFF 상태 — api/routes/settings/manual-triggers.ts에서 추출
 * scheduler, automation 등 비-API 레이어에서도 import 가능
 */
import { logger } from '../utils/logger.js';

// ── v16: 실전/연습 모드 별도 자동매매 ON/OFF ──
// DB 영속 (system_state: auto_trade_paper / auto_trade_live), 기본값 true
export const _autoTradeEnabled = { paper: true, live: true };

/** 부팅 시 DB → 메모리 복원 (main.ts에서 호출) */
export async function initAutoTrade(): Promise<void> {
  try {
    const { getPool } = await import('../db/client.js');
    const { rows } = await getPool().query(
      `SELECT key, value FROM system_state WHERE key IN ('auto_trade_paper', 'auto_trade_live')`,
    );
    for (const r of rows) {
      if (r.key === 'auto_trade_paper') _autoTradeEnabled.paper = r.value === true || r.value === 'true';
      if (r.key === 'auto_trade_live') _autoTradeEnabled.live = r.value === true || r.value === 'true';
    }
    logger.info(`🔧 자동매매 복원: paper=${_autoTradeEnabled.paper} live=${_autoTradeEnabled.live}`, { component: 'BOOT' });
  } catch (e: any) {
    logger.warn(`자동매매 상태 복원 실패 (기본 ON 사용): ${e.message}`, { component: 'BOOT' });
  }
}

/** 자동매매 활성화 여부 조회 (Track B, Loop, Overseas에서 참조) */
export function isAutoTradeEnabled(isPaper: boolean): boolean {
  return isPaper ? _autoTradeEnabled.paper : _autoTradeEnabled.live;
}
