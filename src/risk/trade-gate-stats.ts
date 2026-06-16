/**
 * 🚦 Trade Gate 통계 (승률/연패/쿨다운)
 */

import { GATE } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { config } from '../config/index.js';
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import type { CooldownStatus, GateResult, WinRateStats } from './trade-gate-types.js';

// Paper/Live 분리: 모드별 독립 알림 쿨다운 (크로스오염 방지)
const lastCooldownNotifyAtMap = new Map<string, number>([['paper', 0], ['live', 0]]);
// Paper/Live 분리: 모드별 독립 쿨다운 리셋 (크로스오염 방지)
const cooldownResetAtMap = new Map<string, Date | null>([['paper', null], ['live', null]]);
function _getCooldownResetAt(): Date | null {
  return cooldownResetAtMap.get(getCtxIsPaper() ? 'paper' : 'live') ?? null;
}
function _setCooldownResetAt(val: Date | null): void {
  cooldownResetAtMap.set(getCtxIsPaper() ? 'paper' : 'live', val);
}

const SELL_PRICE_SUB = `(SELECT filled_price FROM orders WHERE chain_id = tc.id AND side = 'SELL' ORDER BY created_at DESC LIMIT 1) as sell_price`;

export function resetCooldown(): void {
  const now = new Date();
  _setCooldownResetAt(now);
  const mode = getCtxIsPaper() ? 'paper' : 'live';
  logger.info(`🔓 연속손실 쿨다운 수동 초기화 [${mode}]`, { component: 'TRADE_GATE' });
  getPool()
    .query(
      `INSERT INTO system_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
      [`cooldown_reset_at_${mode}`, now.toISOString()],
    )
    .catch(() => {});
}

export async function restoreCooldownResetAt(): Promise<void> {
  try {
    // Paper/Live 양쪽 + 레거시 키 복원
    const { rows } = await getPool().query(
      "SELECT key, value FROM system_state WHERE key IN ('cooldown_reset_at', 'cooldown_reset_at_paper', 'cooldown_reset_at_live')",
    );
    for (const r of rows) {
      const saved = new Date(r.value);
      if (Date.now() - saved.getTime() < 24 * 60 * 60_000) {
        if (r.key === 'cooldown_reset_at_paper') cooldownResetAtMap.set('paper', saved);
        else if (r.key === 'cooldown_reset_at_live') cooldownResetAtMap.set('live', saved);
        else {
          // 레거시 키: 양쪽 모두 설정
          if (!cooldownResetAtMap.get('paper')) cooldownResetAtMap.set('paper', saved);
          if (!cooldownResetAtMap.get('live')) cooldownResetAtMap.set('live', saved);
        }
        logger.info(`📦 쿨다운 리셋 복원 [${r.key}]: ${saved.toISOString()}`, { component: 'TRADE_GATE' });
      }
    }
  } catch {
    /* 복원 실패 시 null 유지 */
  }
}

export async function getWinRateStats(days: number = 30): Promise<WinRateStats> {
  const defaultStats: WinRateStats = { totalTrades: 0, wins: 0, losses: 0, avgWinPct: 3.0, avgLossPct: -3.0 };
  try {
    const { rows } = await getPool().query(
      `
      SELECT close_reason, avg_buy_price, ${SELL_PRICE_SUB}
      FROM transaction_chains tc
      WHERE status = 'CLOSED'
        AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
        AND avg_buy_price > 0
        AND is_paper = $2
    `,
      [days, getCtxIsPaper()],
    );

    if (rows.length < 5) return defaultStats;

    let wins = 0,
      losses = 0,
      totalWinPct = 0,
      totalLossPct = 0;
    for (const r of rows) {
      const buyPrice = Number(r.avg_buy_price);
      const sellPrice = Number(r.sell_price ?? buyPrice);
      const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
      if (pnlPct > 0) {
        wins++;
        totalWinPct += pnlPct;
      } else {
        losses++;
        totalLossPct += pnlPct;
      }
    }

    return {
      totalTrades: rows.length,
      wins,
      losses,
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
    const cooldownResetAt = _getCooldownResetAt();
    if (cooldownResetAt) {
      params.push(cooldownResetAt.toISOString());
      resetFilter = `AND closed_at > $${params.length}`;
    }
    const { rows } = await getPool().query(
      `
      SELECT close_reason, avg_buy_price, ${SELL_PRICE_SUB}
      FROM transaction_chains tc
      WHERE status = 'CLOSED'
        AND (close_reason IS NULL OR close_reason NOT LIKE '%SCALPING 강제청산%')
        AND is_paper = $1
        ${resetFilter}
      ORDER BY closed_at DESC LIMIT 10
    `,
      params,
    );

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
  // Paper 모드: 쿨다운 완전 비활성 (데이터 축적이 우선 — CEO 지시 2026-06-15)
  const isPaper = getCtxIsPaper();
  if (isPaper) {
    return { passed: true, reason: consecutive > 0 ? `[모의] ${consecutive}연패 (쿨다운 면제)` : '연속손실 없음' };
  }
  const mult = 1;
  const cooldownMs =
    consecutive >= 5
      ? Math.round(GATE.CONSECUTIVE_LOSS_HALT_MS * mult)
      : consecutive >= 3
        ? Math.round(GATE.CONSECUTIVE_LOSS_WARN_MS * mult)
        : 0;

  if (cooldownMs > 0) {
    try {
      const params: any[] = [isPaper];
      let resetFilter = '';
      const cooldownResetAt2 = _getCooldownResetAt();
      if (cooldownResetAt2) {
        params.push(cooldownResetAt2.toISOString());
        resetFilter = `AND closed_at > $${params.length}`;
      }
      const { rows } = await getPool().query(
        `
        SELECT closed_at FROM transaction_chains
        WHERE status = 'CLOSED'
          AND (close_reason IS NULL OR close_reason NOT LIKE '%SCALPING 강제청산%')
          AND is_paper = $1 ${resetFilter}
        ORDER BY closed_at DESC LIMIT 1
      `,
        params,
      );

      if (rows.length > 0) {
        const elapsed = Date.now() - new Date(rows[0].closed_at).getTime();
        if (elapsed < cooldownMs) {
          const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
          const now = Date.now();
          const notifyKey = isPaper ? 'paper' : 'live';
          if (now - (lastCooldownNotifyAtMap.get(notifyKey) ?? 0) > GATE.COOLDOWN_NOTIFY_MS) {
            lastCooldownNotifyAtMap.set(notifyKey, now);
            sendTelegramMessage(`🚦 연속손실 쿨다운: ${consecutive}연패 → ${remaining}분 후 재진입`).catch(() => {});
          }
          return { passed: false, reason: `연속손실 쿨다운: ${consecutive}연패 → ${remaining}분 대기 중` };
        }
      }
    } catch {
      /* pass through */
    }
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
    const isPaper = getCtxIsPaper();
    // Paper 모드: EOD-only 비활성 (적극적 매매 학습 목적)
    if (isPaper) return false;

    const consecutive = await getConsecutiveLosses();
    const threshold = 3;
    if (consecutive >= threshold) {
      const key = 'live';
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
    const mult = isPaper ? config.paperRisk.cooldownMultiplier : 1;
    const cooldownMs =
      consecutive >= 5
        ? Math.round(GATE.CONSECUTIVE_LOSS_HALT_MS * mult)
        : consecutive >= 3
          ? Math.round(GATE.CONSECUTIVE_LOSS_WARN_MS * mult)
          : 0;

    if (cooldownMs > 0) {
      const params: any[] = [isPaper];
      let resetFilter = '';
      const cooldownResetAt2 = _getCooldownResetAt();
      if (cooldownResetAt2) {
        params.push(cooldownResetAt2.toISOString());
        resetFilter = `AND closed_at > $${params.length}`;
      }
      const { rows } = await getPool().query(
        `
        SELECT closed_at FROM transaction_chains
        WHERE status = 'CLOSED'
          AND (close_reason IS NULL OR close_reason NOT LIKE '%SCALPING 강제청산%')
          AND is_paper = $1 ${resetFilter}
        ORDER BY closed_at DESC LIMIT 1
      `,
        params,
      );
      if (rows.length > 0) {
        const elapsed = Date.now() - new Date(rows[0].closed_at).getTime();
        if (elapsed < cooldownMs) {
          const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
          return {
            active: true,
            consecutive,
            remainingMinutes: remaining,
            reason: `${consecutive}연패 → ${remaining}분 후 해제`,
          };
        }
      }
    }
    return {
      active: false,
      consecutive,
      remainingMinutes: 0,
      reason: consecutive > 0 ? `최근 ${consecutive}연패 (쿨다운 미해당)` : '',
    };
  } catch {
    return { active: false, consecutive: 0, remainingMinutes: 0, reason: '' };
  }
}
