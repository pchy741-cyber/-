/**
 * Smart Alerts — 지능형 알림 모듈
 *
 * #18: 드로다운 단계별 경고
 * #19: 레짐 변경 알림
 * #20: 성과 마일스톤 알림
 *
 * 매 overseas 사이클에서 호출 + 별도 크론
 */
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from './telegram.js';
import { logger } from '../utils/logger.js';
import { getOverseasState, setOverseasState } from '../scheduler/overseas/utils.js';

const COMP = 'SMART_ALERT';

// ══════════════════════════════════════════════════════════════
// 1. 드로다운 단계별 경고 (#18)
// ══════════════════════════════════════════════════════════════

interface DrawdownLevel {
  threshold: number; // 음수 (e.g., -3)
  label: string;
  emoji: string;
}

const DRAWDOWN_LEVELS: DrawdownLevel[] = [
  { threshold: -7.0, label: 'CRITICAL', emoji: '🚨' },
  { threshold: -5.0, label: 'SEVERE', emoji: '⚠️' },
  { threshold: -3.0, label: 'WARNING', emoji: '🟡' },
];

let _lastDrawdownAlertLevel = 0; // 마지막 알림 레벨 (재알림 방지)
let _lastDrawdownAlertAt = 0;
const DD_COOLDOWN = 2 * 60 * 60_000; // 2시간

export async function checkDrawdownAlert(
  currentValue: number,
  peakValue: number,
  isPaper: boolean,
): Promise<void> {
  if (peakValue <= 0 || currentValue <= 0) return;

  const drawdownPct = ((currentValue - peakValue) / peakValue) * 100;
  if (drawdownPct >= -2.0) {
    _lastDrawdownAlertLevel = 0; // 회복 시 리셋
    return;
  }

  const mode = isPaper ? 'paper' : 'live';
  const now = Date.now();

  for (const level of DRAWDOWN_LEVELS) {
    if (drawdownPct <= level.threshold) {
      // 같은 레벨 이미 알림 + 쿨다운 미만이면 스킵
      if (level.threshold === _lastDrawdownAlertLevel && now - _lastDrawdownAlertAt < DD_COOLDOWN) return;

      _lastDrawdownAlertLevel = level.threshold;
      _lastDrawdownAlertAt = now;

      const msg = [
        `${level.emoji} 드로다운 ${level.label} (${mode})`,
        ``,
        `📉 현재: ${drawdownPct.toFixed(1)}% (고점 대비)`,
        `💰 고점: $${peakValue.toFixed(0)} → 현재: $${currentValue.toFixed(0)}`,
        `손실액: $${(currentValue - peakValue).toFixed(0)}`,
        '',
        level.threshold <= -7 ? '🛑 즉시 포지션 점검 필요' :
        level.threshold <= -5 ? '⚠️ 손절 기준 재확인 권장' :
        '🟡 모니터링 강화',
      ].join('\n');

      await sendTelegramMessage(msg).catch(() => {});
      logger.warn(msg, { component: COMP });
      break; // 가장 심각한 레벨만 알림
    }
  }
}

// ══════════════════════════════════════════════════════════════
// 2. 레짐 변경 알림 (#19)
// ══════════════════════════════════════════════════════════════

type VixRegime = 'CALM' | 'STRESS' | 'CRISIS';

const _prevRegimeAlert: Record<string, VixRegime> = { paper: 'CALM', live: 'CALM' };

export async function checkRegimeChangeAlert(
  currentRegime: VixRegime,
  vix: number,
  isPaper: boolean,
): Promise<void> {
  const mode = isPaper ? 'paper' : 'live';
  const prev = _prevRegimeAlert[mode] ?? 'CALM';

  if (currentRegime === prev) return;
  _prevRegimeAlert[mode] = currentRegime;

  const regimeInfo: Record<VixRegime, { emoji: string; desc: string }> = {
    CALM: { emoji: '🟢', desc: '안정 — 정상 매매' },
    STRESS: { emoji: '🟡', desc: '경계 — 사이징 85%, 트레일 타이트닝' },
    CRISIS: { emoji: '🔴', desc: '위기 — 사이징 50%, 방어 모드' },
  };

  const from = regimeInfo[prev];
  const to = regimeInfo[currentRegime];

  const msg = [
    `🔀 레짐 변경 (${mode})`,
    ``,
    `${from.emoji} ${prev} → ${to.emoji} ${currentRegime}`,
    `VIX: ${vix.toFixed(1)}`,
    ``,
    `적용: ${to.desc}`,
  ].join('\n');

  await sendTelegramMessage(msg).catch(() => {});
  logger.info(msg, { component: COMP });

  // overseas_state에 레짐 변경 이력 저장
  const historyKey = `regime_history_${mode}`;
  try {
    const raw = await getOverseasState(historyKey);
    const history: Array<{ from: string; to: string; vix: number; at: string }> = raw ? JSON.parse(raw) : [];
    history.unshift({ from: prev, to: currentRegime, vix, at: new Date().toISOString() });
    if (history.length > 50) history.length = 50;
    await setOverseasState(historyKey, JSON.stringify(history));
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════
// 3. 성과 마일스톤 알림 (#20)
// ══════════════════════════════════════════════════════════════

interface MilestoneCheck {
  bestWinStreak: number;
  bestDayPnl: number;
  totalPnlUsd: number;
  winRate7d: number;
}

export async function checkMilestoneAlerts(isPaper: boolean): Promise<void> {
  const mode = isPaper ? 'paper' : 'live';
  const stateKey = `milestones_${mode}`;

  try {
    // 기존 마일스톤 로드
    const raw = await getOverseasState(stateKey);
    const prev: Record<string, number> = raw ? JSON.parse(raw) : {};

    // 최근 7일 성과 조회
    const { rows } = await getPool().query(
      `SELECT filled_price, avg_buy_price, quantity, DATE(created_at) as trade_date
       FROM orders
       WHERE trigger_source = 'OVERSEAS' AND side = 'SELL' AND status = 'FILLED'
         AND filled_price > 0 AND avg_buy_price > 0
         AND created_at >= NOW() - INTERVAL '7 days'
         AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
       ORDER BY created_at DESC`,
      [mode],
    );

    if (rows.length < 3) return;

    // 계산
    let wins = 0;
    let currentStreak = 0;
    let bestStreak = prev.bestWinStreak ?? 0;
    let totalPnl = 0;
    const dailyPnl = new Map<string, number>();

    for (const r of rows) {
      const pnl = (Number(r.filled_price) - Number(r.avg_buy_price)) * Number(r.quantity);
      totalPnl += pnl;
      const date = String(r.trade_date).slice(0, 10);
      dailyPnl.set(date, (dailyPnl.get(date) ?? 0) + pnl);

      if (pnl >= 0) {
        wins++;
        currentStreak++;
      } else {
        currentStreak = 0;
      }
    }

    const winRate = rows.length > 0 ? wins / rows.length : 0;
    const bestDayPnl = Math.max(0, ...[...dailyPnl.values()]);
    const prevBestDay = prev.bestDayPnl ?? 0;
    const prevBestStreak = prev.bestWinStreak ?? 0;
    const prevBestWinRate = prev.bestWinRate7d ?? 0;

    const alerts: string[] = [];

    // 최고 연승 갱신
    if (currentStreak > prevBestStreak && currentStreak >= 3) {
      alerts.push(`🔥 최고 연승 갱신: ${currentStreak}연승! (이전: ${prevBestStreak}연승)`);
      prev.bestWinStreak = currentStreak;
    }

    // 최고 일일 수익 갱신
    if (bestDayPnl > prevBestDay && bestDayPnl > 50) {
      alerts.push(`💎 최고 일일수익 갱신: $${bestDayPnl.toFixed(0)} (이전: $${prevBestDay.toFixed(0)})`);
      prev.bestDayPnl = bestDayPnl;
    }

    // 7일 승률 80% 이상 달성
    if (winRate >= 0.8 && rows.length >= 5 && winRate > prevBestWinRate) {
      alerts.push(`🏆 7일 승률 ${(winRate * 100).toFixed(0)}% 달성! (${wins}/${rows.length}건)`);
      prev.bestWinRate7d = winRate;
    }

    // 총 수익 마일스톤 ($100, $500, $1000 단위)
    const milestones = [100, 500, 1000, 2000, 5000];
    for (const m of milestones) {
      const prevTotal = prev.totalPnlMilestone ?? 0;
      if (totalPnl >= m && prevTotal < m) {
        alerts.push(`🎯 7일 누적수익 $${m} 돌파! ($${totalPnl.toFixed(0)})`);
        prev.totalPnlMilestone = m;
        break;
      }
    }

    if (alerts.length > 0) {
      const msg = [`🏅 성과 마일스톤 (${mode})`, '', ...alerts].join('\n');
      await sendTelegramMessage(msg).catch(() => {});
      logger.info(msg, { component: COMP });
    }

    // 마일스톤 상태 저장
    await setOverseasState(stateKey, JSON.stringify(prev));
  } catch (e: any) {
    logger.debug(`마일스톤 체크 실패: ${e.message}`, { component: COMP });
  }
}
