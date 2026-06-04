/**
 * 🚦 Trade Gate 통계 (승률/연패/쿨다운)
 */

import { GATE } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import type { GateResult, CooldownStatus, WinRateStats } from './trade-gate-types.js';

let lastCooldownNotifyAt = 0;
let cooldownResetAt: Date | null = null;

const SELL_PRICE_SUB = `(SELECT filled_price FROM orders WHERE chain_id = tc.id AND side = 'SELL' ORDER BY created_at DESC LIMIT 1) as sell_price`;

export function resetCooldown(): void {
  cooldownResetAt = new Date();
  logger.info('🔓 연속손실 쿨다운 수동 초기화', { component: 'TRADE_GATE' });
  getPool().query(
    `INSERT INTO system_state (key, value) VALUES ('cooldown_reset_at', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [cooldownResetAt.toISOString()],
  ).catch(() => {});
}

export async function restoreCooldownResetAt(): Promise<void> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM system_state WHERE key = 'cooldown_reset_at'",
    );
    if (rows.length > 0) {
      const saved = new Date(rows[0].value);
      if (Date.now() - saved.getTime() < 24 * 60 * 60_000) {
        cooldownResetAt = saved;
        logger.info(`📦 쿨다운 리셋 복원: ${saved.toISOString()}`, { component: 'TRADE_GATE' });
      }
    }
  } catch { /* 복원 실패 시 null 유지 */ }
}

export async function getWinRateStats(days: number = 30): Promise<WinRateStats> {
  const defaultStats: WinRateStats = { totalTrades: 0, wins: 0, losses: 0, avgWinPct: 3.0, avgLossPct: -3.0 };
  try {
    const { rows } = await getPool().query(`
      SELECT close_reason, avg_buy_price, ${SELL_PRICE_SUB}
      FROM transaction_chains tc
      WHERE status = 'CLOSED'
        AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
        AND avg_buy_price > 0
        AND is_paper = $2
    `, [days, getCtxIsPaper()]);

    if (rows.length < 5) return defaultStats;

    let wins = 0, losses = 0, totalWinPct = 0, totalLossPct = 0;
    for (const r of rows) {
      const buyPrice = Number(r.avg_buy_price);
      const sellPrice = Number(r.sell_price ?? buyPrice);
      const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
      if (pnlPct > 0) { wins++; totalWinPct += pnlPct; }
      else { losses++; totalLossPct += pnlPct; }
    }

    return {
      totalTrades: rows.length, wins, losses,
      avgWinPct: wins > 0 ? totalWinPct / wins : 3.0,
      avgLossPct: losses > 0 ? totalLossPct / losses : -3.0,
    };
  } catch {
    return defaultStats;
  }
}

async function getConsecutiveLosses(): Promise<number> {
  try {
    const params: any[] = [getCtxIsPaper()];
    let resetFilter = '';
    if (cooldownResetAt) {
      params.push(cooldownResetAt.toISOString());
      resetFilter = `AND closed_at > $${params.length}`;
    }
    const { rows } = await getPool().query(`
      SELECT close_reason, avg_buy_price, ${SELL_PRICE_SUB}
      FROM transaction_chains tc
      WHERE status = 'CLOSED'
        AND (close_reason IS NULL OR close_reason NOT LIKE '%SCALPING 강제청산%')
        AND is_paper = $1
        ${resetFilter}
      ORDER BY closed_at DESC LIMIT 10
    `, params);

    let consecutive = 0;
    for (const r of rows) {
      if (Number(r.sell_price ?? r.avg_buy_price) < Number(r.avg_buy_price)) consecutive++;
      else break;
    }
    return consecutive;
  } catch {
    return 0;
  }
}

export async function cooldownGate(): Promise<GateResult> {
  const consecutive = await getConsecutiveLosses();
  // Paper 모드: 쿨다운 대폭 완화 (5연패 10분, 3-4연패 5분)
  const isPaper = getCtxIsPaper();
  const cooldownMs = isPaper
    ? (consecutive >= 5 ? 10 * 60_000 : consecutive >= 3 ? 5 * 60_000 : 0)
    : (consecutive >= 5 ? GATE.CONSECUTIVE_LOSS_HALT_MS : consecutive >= 3 ? GATE.CONSECUTIVE_LOSS_WARN_MS : 0);

  if (cooldownMs > 0) {
    try {
      const params: any[] = [isPaper];
      let resetFilter = '';
      if (cooldownResetAt) {
        params.push(cooldownResetAt.toISOString());
        resetFilter = `AND closed_at > $${params.length}`;
      }
      const { rows } = await getPool().query(`
        SELECT closed_at FROM transaction_chains
        WHERE status = 'CLOSED'
          AND (close_reason IS NULL OR close_reason NOT LIKE '%SCALPING 강제청산%')
          AND is_paper = $1 ${resetFilter}
        ORDER BY closed_at DESC LIMIT 1
      `, params);

      if (rows.length > 0) {
        const elapsed = Date.now() - new Date(rows[0].closed_at).getTime();
        if (elapsed < cooldownMs) {
          const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
          const now = Date.now();
          if (now - lastCooldownNotifyAt > GATE.COOLDOWN_NOTIFY_MS) {
            lastCooldownNotifyAt = now;
            sendTelegramMessage(`🚦 연속손실 쿨다운: ${consecutive}연패 → ${remaining}분 후 재진입`).catch(() => {});
          }
          return { passed: false, reason: `연속손실 쿨다운: ${consecutive}연패 → ${remaining}분 대기 중` };
        }
      }
    } catch { /* pass through */ }
  }
  return { passed: true, reason: consecutive > 0 ? `최근 ${consecutive}연패 (쿨다운 미해당)` : '연속손실 없음' };
}

/**
 * 🎰 EOD-only 모드: 연패 시 장중 매매 전면 차단, 종가베팅만 허용
 * Live: 3연패+ → EOD-only | Paper: 5연패+ → EOD-only
 * 승리 1회 시 자동 해제 (getConsecutiveLosses()가 0이면 해제)
 */
// 로그 스팸 방지: 마지막 로그 시점 추적 (대시보드 조회 때마다 안 찍히게)
const _eodLoggedAt = new Map<string, number>();

export async function isEodOnlyMode(): Promise<boolean> {
  try {
    const consecutive = await getConsecutiveLosses();
    const isPaper = getCtxIsPaper();
    const threshold = isPaper ? 5 : 3;
    if (consecutive >= threshold) {
      // 같은 모드(paper/live)에서 5분 이내 중복 로그 방지
      const key = isPaper ? 'paper' : 'live';
      const now = Date.now();
      if (!_eodLoggedAt.has(key) || now - (_eodLoggedAt.get(key) ?? 0) > 300_000) {
        logger.info(`🎰 EOD-only 모드 활성: ${consecutive}연패 (임계값 ${threshold})`, { component: 'TRADE_GATE' });
        _eodLoggedAt.set(key, now);
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function getCooldownStatus(): Promise<CooldownStatus> {
  try {
    const consecutive = await getConsecutiveLosses();
    const isPaper = getCtxIsPaper();
    const cooldownMs = isPaper
      ? (consecutive >= 5 ? 10 * 60_000 : consecutive >= 3 ? 5 * 60_000 : 0)
      : (consecutive >= 5 ? GATE.CONSECUTIVE_LOSS_HALT_MS : consecutive >= 3 ? GATE.CONSECUTIVE_LOSS_WARN_MS : 0);

    if (cooldownMs > 0) {
      const params: any[] = [isPaper];
      let resetFilter = '';
      if (cooldownResetAt) {
        params.push(cooldownResetAt.toISOString());
        resetFilter = `AND closed_at > $${params.length}`;
      }
      const { rows } = await getPool().query(`
        SELECT closed_at FROM transaction_chains
        WHERE status = 'CLOSED'
          AND (close_reason IS NULL OR close_reason NOT LIKE '%SCALPING 강제청산%')
          AND is_paper = $1 ${resetFilter}
        ORDER BY closed_at DESC LIMIT 1
      `, params);
      if (rows.length > 0) {
        const elapsed = Date.now() - new Date(rows[0].closed_at).getTime();
        if (elapsed < cooldownMs) {
          const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
          return { active: true, consecutive, remainingMinutes: remaining, reason: `${consecutive}연패 → ${remaining}분 후 해제` };
        }
      }
    }
    return { active: false, consecutive, remainingMinutes: 0, reason: consecutive > 0 ? `최근 ${consecutive}연패 (쿨다운 미해당)` : '' };
  } catch {
    return { active: false, consecutive: 0, remainingMinutes: 0, reason: '' };
  }
}
