/**
 * 실전 모드 큰 손실 즉시 알림 — 장중 30분마다 실행
 *
 * 감지 기준 (is_paper = false만):
 * 1. 일일 실현손실 누적 > -100만원
 * 2. 미실현손실 > 총자산 -5%
 * 3. 단일 종목 -15% 이상
 *
 * 발동: sendAlertEmail() + sendTelegramMessage() 동시 발송
 * 중복 방지: 인메모리 1시간 cooldown
 */

import { runWithMode } from '../config/context.js';
import { paperOnly } from '../config/index.js';
import { getPool } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { sendAlertEmail } from '../notifications/email.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

const COMPONENT = 'LOSS_ALERT';
const COOLDOWN_MS = 60 * 60 * 1000; // 1시간

// 알림별 마지막 발송 시각 (중복 방지)
const lastAlertAt = new Map<string, number>();

function canAlert(key: string): boolean {
  const last = lastAlertAt.get(key) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return false;
  lastAlertAt.set(key, Date.now());
  return true;
}

export async function checkLiveAlerts(): Promise<void> {
  if (paperOnly) return; // PAPER_ONLY 모드면 실전 알림 불필요

  try {
    await runWithMode(false, async () => {
      const balance = await getAccountBalance(true);
      const today = getKSTNow().toISOString().split('T')[0];
      const alerts: string[] = [];

      // 1. 일일 실현손실 > -100만원
      const { rows: closedToday } = await getPool().query(
        `SELECT COALESCE(SUM(realized_pnl), 0) as total_pnl
         FROM transaction_chains WHERE status = 'CLOSED' AND closed_at >= $1 AND is_paper = false`,
        [`${today}T00:00:00+09:00`],
      );
      const dailyRealizedPnl = Number(closedToday[0]?.total_pnl ?? 0);
      if (dailyRealizedPnl < -1_000_000 && canAlert('daily_loss')) {
        alerts.push(
          `🔴 일일 실현손실 ${dailyRealizedPnl.toLocaleString()}원 (한도: -100만원)`,
        );
      }

      // 2. 미실현손실 > 총자산 -5% (positions에서 직접 계산 — paper/live 의미 차이 방지)
      const totalAsset = balance.orderableCash + balance.totalEvalAmount;
      const unrealizedPnl = balance.positions.reduce((sum, p) => sum + p.profitLoss, 0);
      if (totalAsset > 0) {
        const unrealizedPct = (unrealizedPnl / totalAsset) * 100;
        if (unrealizedPct < -5 && canAlert('unrealized_loss')) {
          alerts.push(
            `🔴 미실현손실 ${unrealizedPnl.toLocaleString()}원 (${unrealizedPct.toFixed(1)}%, 한도: -5%)`,
          );
        }
      }

      // 3. 단일 종목 -15% 이상
      for (const p of balance.positions) {
        if (p.profitLossPct < -15 && canAlert(`stock_${p.stockCode}`)) {
          alerts.push(
            `🔴 ${p.stockName}(${p.stockCode}) ${p.profitLossPct.toFixed(1)}% (한도: -15%)`,
          );
        }
      }

      if (alerts.length === 0) return;

      const subject = `🚨 [실전] 손실 알림 — ${alerts.length}건 감지`;
      const body = alerts.join('\n');

      // 이메일 + 텔레그램 동시 발송
      const html = `
        <div style="font-family:sans-serif;padding:20px;background:#1a1a2e;color:#e0e0e0;">
          <h2 style="color:#ef4444;margin:0 0 16px 0;">🚨 실전 손실 알림</h2>
          <p style="color:#9ca3af;font-size:13px;">${today} ${getKSTNow().toISOString().split('T')[1].slice(0, 5)} KST</p>
          ${alerts.map((a) => `<p style="font-size:14px;margin:8px 0;padding:8px;background:#2d1b1b;border-left:3px solid #ef4444;border-radius:4px;">${a}</p>`).join('')}
          <hr style="border-color:#333;margin:16px 0;">
          <p style="font-size:12px;color:#6b7280;">총자산: ${totalAsset.toLocaleString()}원 · 미실현: ${unrealizedPnl.toLocaleString()}원 · 일일실현: ${dailyRealizedPnl.toLocaleString()}원</p>
        </div>`;

      await Promise.all([
        sendAlertEmail({ subject, html }),
        sendTelegramMessage(`${subject}\n\n${body}`),
      ]);

      logger.warn(`🚨 실전 손실 알림 발송: ${alerts.length}건`, { component: COMPONENT });
    });
  } catch (err) {
    logger.error(`손실 알림 체크 실패: ${err}`, { component: COMPONENT });
  }
}
