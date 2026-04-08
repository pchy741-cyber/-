import webpush from 'web-push';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

// VAPID 키 (환경변수 또는 하드코딩)
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BE6iN3FNECLxC_J_noAEZQ5ZPmp-i8YtEj_NVSu0m4b_qdOgArE5NGi_Qm8AXItsb775RfEbBdt3YjA3jzuL2Eo';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '4qBiE3-_zo8ZJKVAs_qrjLR8E90QT9LwSF-J1SmBqLY';

webpush.setVapidDetails('mailto:pro@proscom-hr.com', VAPID_PUBLIC, VAPID_PRIVATE);

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC;
}

// 인메모리 구독 저장 (DB 없을 때 폴백)
const memSubscriptions: webpush.PushSubscription[] = [];

/**
 * 푸시 구독 저장
 */
export async function saveSubscription(subscription: webpush.PushSubscription): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        endpoint TEXT UNIQUE NOT NULL,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
       VALUES ($1, $2, $3) ON CONFLICT (endpoint) DO NOTHING`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
    );
  } catch {
    // DB 실패 시 인메모리
    if (!memSubscriptions.find(s => s.endpoint === subscription.endpoint)) {
      memSubscriptions.push(subscription);
    }
  }
  logger.info('📱 푸시 구독 등록', { component: 'WEB_PUSH' });
}

/**
 * 모든 구독자에게 푸시 발송
 */
export async function sendPushNotification(payload: {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}): Promise<void> {
  const subscriptions = await getAllSubscriptions();
  if (subscriptions.length === 0) return;

  const data = JSON.stringify(payload);
  let sent = 0;

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, data);
      sent++;
    } catch (err: any) {
      // 410 Gone = 구독 만료 → 삭제
      if (err.statusCode === 410 || err.statusCode === 404) {
        await removeSubscription(sub.endpoint);
      }
    }
  }

  if (sent > 0) {
    logger.info(`📱 푸시 발송: ${sent}건 (${payload.title})`, { component: 'WEB_PUSH' });
  }
}

async function getAllSubscriptions(): Promise<webpush.PushSubscription[]> {
  try {
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM push_subscriptions');
    return rows.map((r: any) => ({
      endpoint: r.endpoint,
      keys: { p256dh: r.keys_p256dh, auth: r.keys_auth },
    }));
  } catch {
    return memSubscriptions;
  }
}

async function removeSubscription(endpoint: string): Promise<void> {
  try {
    await getPool().query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  } catch { /* ignore */ }
  const idx = memSubscriptions.findIndex(s => s.endpoint === endpoint);
  if (idx >= 0) memSubscriptions.splice(idx, 1);
}

// ══════════════════════════════════════
//  매매 이벤트별 알림 헬퍼
// ══════════════════════════════════════

export async function notifyBuy(stockName: string, qty: number, price: number, reasoning: string) {
  await sendPushNotification({
    title: `🟢 매수: ${stockName}`,
    body: `${qty}주 × ${price.toLocaleString()}원\n${reasoning}`,
    tag: 'trade-buy',
    url: '/',
  });
}

export async function notifySell(stockName: string, qty: number, price: number, pnlPct: number, reasoning: string) {
  const emoji = pnlPct >= 0 ? '🔴' : '🔻';
  const pnlStr = pnlPct >= 0 ? `+${pnlPct.toFixed(1)}%` : `${pnlPct.toFixed(1)}%`;
  await sendPushNotification({
    title: `${emoji} 매도: ${stockName} (${pnlStr})`,
    body: `${qty}주 × ${price.toLocaleString()}원\n${reasoning}`,
    tag: 'trade-sell',
    url: '/',
  });
}

export async function notifyAlert(title: string, body: string) {
  await sendPushNotification({ title, body, tag: 'alert', url: '/' });
}
