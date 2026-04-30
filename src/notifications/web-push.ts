import webpush from 'web-push';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

// VAPID 키 — 환경변수 우선, 없으면 DB에서 로드/자동 생성
let vapidPublic = '';
let vapidPrivate = '';
let vapidReady = false;

/**
 * VAPID 키 초기화
 * 우선순위: 환경변수 → DB → 자동 생성 후 DB 저장
 */
export async function initVapid(): Promise<void> {
  // 1. 환경변수 우선
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidPublic = process.env.VAPID_PUBLIC_KEY;
    vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    webpush.setVapidDetails('mailto:proscom2208@gmail.com', vapidPublic, vapidPrivate);
    vapidReady = true;
    logger.info('✅ VAPID 키 로드 (환경변수)', { component: 'WEB_PUSH' });
    return;
  }

  try {
    const pool = getPool();

    // system_config 테이블 생성
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 2. DB에서 로드 시도
    const { rows } = await pool.query(
      `SELECT key, value FROM system_config WHERE key IN ('vapid_public', 'vapid_private')`,
    );
    const dbMap: Record<string, string> = {};
    for (const r of rows) dbMap[r.key] = r.value;

    if (dbMap['vapid_public'] && dbMap['vapid_private']) {
      vapidPublic = dbMap['vapid_public'];
      vapidPrivate = dbMap['vapid_private'];
      webpush.setVapidDetails('mailto:proscom2208@gmail.com', vapidPublic, vapidPrivate);
      vapidReady = true;
      logger.info('✅ VAPID 키 로드 (DB)', { component: 'WEB_PUSH' });
      return;
    }

    // 3. 자동 생성 후 DB 저장
    const keys = webpush.generateVAPIDKeys();
    vapidPublic = keys.publicKey;
    vapidPrivate = keys.privateKey;

    await pool.query(
      `INSERT INTO system_config (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [vapidPublic, vapidPrivate],
    );

    webpush.setVapidDetails('mailto:proscom2208@gmail.com', vapidPublic, vapidPrivate);
    vapidReady = true;
    logger.info('✅ VAPID 키 자동 생성 및 DB 저장 완료', { component: 'WEB_PUSH' });
  } catch (err) {
    logger.error(`❌ VAPID 초기화 실패: ${err}`, { component: 'WEB_PUSH' });
  }
}

// 앱 시작 시 즉시 초기화
initVapid().catch(() => {});

export function getVapidPublicKey(): string {
  return vapidPublic;
}

export function isVapidReady(): boolean {
  return vapidReady;
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
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_used TIMESTAMPTZ DEFAULT NOW(),
        user_agent TEXT
      )
    `);
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET last_used = NOW()`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
    );
  } catch {
    if (!memSubscriptions.find(s => s.endpoint === subscription.endpoint)) {
      memSubscriptions.push(subscription);
    }
  }
  logger.info('📱 푸시 구독 등록', { component: 'WEB_PUSH' });
}

export async function getSubscriptionCount(): Promise<number> {
  try {
    const { rows } = await getPool().query('SELECT COUNT(*) as cnt FROM push_subscriptions');
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return memSubscriptions.length;
  }
}

/**
 * 모든 구독자에게 푸시 발송
 */
export async function sendPushNotification(payload: {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  icon?: string;
  badge?: string;
  image?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  if (!vapidReady) {
    logger.warn('푸시 발송 스킵 — VAPID 미준비', { component: 'WEB_PUSH' });
    return;
  }
  const subscriptions = await getAllSubscriptions();
  if (subscriptions.length === 0) return;

  const data = JSON.stringify({
    ...payload,
    timestamp: Date.now(),
  });
  let sent = 0;

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, data, {
        TTL: 3600, // 1시간 내 미수신 시 만료
        urgency: payload.tag?.startsWith('alert') ? 'high' : 'normal',
      });
      sent++;
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await removeSubscription(sub.endpoint);
      } else {
        logger.error(`푸시 발송 실패: ${err.statusCode} ${err.message}`, { component: 'WEB_PUSH' });
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
//  종목명 조회 헬퍼 (코드→이름)
// ══════════════════════════════════════

async function resolveStockName(code: string): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `SELECT stock_name FROM watchlist WHERE stock_code = $1 LIMIT 1`,
      [code],
    );
    const name = rows[0]?.stock_name;
    if (name && name !== code && !/^\d{6}$/.test(name)) return name;
  } catch { /* ignore */ }
  return code;
}

function compactReasoning(reasoning: string, prefixRegex: RegExp): string {
  const cleaned = reasoning.replace(prefixRegex, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 60) : '사유 없음';
}

// ══════════════════════════════════════
//  매매 이벤트별 알림 헬퍼
// ══════════════════════════════════════

export async function notifyBuy(stockCode: string, qty: number, price: number, reasoning: string) {
  const name = await resolveStockName(stockCode);
  const totalKrw = Math.round(qty * price);
  const shortReason = compactReasoning(reasoning, /^(매수|BUY|buy)\s*[:：]?\s*/i);
  const totalStr = totalKrw >= 10_000_000
    ? `${(totalKrw / 10_000_000).toFixed(1)}천만원`
    : totalKrw >= 10000
    ? `${Math.round(totalKrw / 10000)}만원`
    : `${totalKrw.toLocaleString()}원`;

  await sendPushNotification({
    title: `🟢 매수 — ${name}`,
    body: `${qty}주 × ${price.toLocaleString()}원 = ${totalStr}\n${shortReason}`,
    tag: `buy-${stockCode}`,
    url: '/',
    data: { stockCode, action: 'BUY', price, qty, totalKrw },
  });

  try {
    const { sendTelegramMessage } = await import('./telegram.js');
    await sendTelegramMessage(
      `🟢 *매수 체결*\n` +
      `종목: *${name}* (\`${stockCode}\`)\n` +
      `수량: ${qty}주 × ${price.toLocaleString()}원\n` +
      `총액: ${totalKrw.toLocaleString()}원\n` +
      `사유: ${shortReason}`
    );
  } catch { /* telegram optional */ }
}

export async function notifySell(stockCode: string, qty: number, price: number, pnlPct: number, reasoning: string) {
  const name = await resolveStockName(stockCode);
  const isProfit = pnlPct >= 0;
  const emoji = pnlPct >= 5 ? '🎉' : pnlPct >= 2 ? '✅' : pnlPct >= 0 ? '🟡' : pnlPct >= -2 ? '🟠' : '🔻';
  const pnlStr = (isProfit ? '+' : '') + pnlPct.toFixed(2) + '%';
  const shortReason = compactReasoning(reasoning, /^(매도|SELL|sell|강제\s*청산)\s*[:：]?\s*/i);

  const pnlKrw = Math.round(qty * price * (pnlPct / 100));
  const pnlSign = pnlKrw >= 0 ? '+' : '';
  const pnlKrwStr = Math.abs(pnlKrw) >= 10000
    ? `${pnlSign}${Math.round(pnlKrw / 1000) / 10}만원`
    : `${pnlSign}${pnlKrw.toLocaleString()}원`;

  await sendPushNotification({
    title: `${emoji} 매도 — ${name} ${pnlStr}`,
    body: `${qty}주 × ${price.toLocaleString()}원 (${pnlKrwStr})\n${shortReason}`,
    tag: `sell-${stockCode}`,
    url: '/?tab=trades',
    data: { stockCode, action: 'SELL', price, qty, pnlPct, pnlKrw },
  });

  try {
    const { sendTelegramMessage } = await import('./telegram.js');
    await sendTelegramMessage(
      `${emoji} *매도 체결* (${pnlStr})\n` +
      `종목: *${name}* (\`${stockCode}\`)\n` +
      `수량: ${qty}주 × ${price.toLocaleString()}원\n` +
      `손익: ${pnlKrwStr}\n` +
      `사유: ${shortReason}`
    );
  } catch { /* telegram optional */ }
}

export async function notifyOverseasBuy(stockCode: string, stockName: string, qty: number, priceUsd: number, reasoning: string) {
  const shortReason = compactReasoning(reasoning, /^(매수|BUY|buy)\s*[:：]?\s*/i);
  const totalUsd = qty * priceUsd;

  await sendPushNotification({
    title: `🟢 해외매수 — ${stockName}`,
    body: `${qty}주 × $${priceUsd.toFixed(2)} = $${totalUsd.toFixed(0)}\n${shortReason}`,
    tag: `overseas-buy-${stockCode}`,
    url: '/',
    data: { stockCode, action: 'BUY', priceUsd, qty },
  });

  try {
    const { sendTelegramMessage } = await import('./telegram.js');
    await sendTelegramMessage(
      `🟢 *해외 매수 체결*\n` +
      `종목: *${stockName}* (\`${stockCode}\`)\n` +
      `수량: ${qty}주 × $${priceUsd.toFixed(2)}\n` +
      `총액: $${totalUsd.toFixed(2)}\n` +
      `사유: ${shortReason}`,
    );
  } catch { /* telegram optional */ }
}

export async function notifyOverseasSell(
  stockCode: string,
  stockName: string,
  qty: number,
  priceUsd: number,
  pnlPct: number,
  reasoning: string,
) {
  const isProfit = pnlPct >= 0;
  const emoji = pnlPct >= 5 ? '🎉' : pnlPct >= 2 ? '✅' : pnlPct >= 0 ? '🟡' : pnlPct >= -2 ? '🟠' : '🔻';
  const pnlStr = `${isProfit ? '+' : ''}${pnlPct.toFixed(2)}%`;
  const shortReason = compactReasoning(reasoning, /^(매도|SELL|sell|강제\s*청산)\s*[:：]?\s*/i);

  const pnlUsd = qty * priceUsd * (pnlPct / 100);
  const pnlUsdStr = `${pnlUsd >= 0 ? '+' : ''}$${Math.abs(pnlUsd).toFixed(1)}`;

  await sendPushNotification({
    title: `${emoji} 해외매도 — ${stockName} ${pnlStr}`,
    body: `${qty}주 × $${priceUsd.toFixed(2)} (${pnlUsdStr})\n${shortReason}`,
    tag: `overseas-sell-${stockCode}`,
    url: '/?tab=trades',
    data: { stockCode, action: 'SELL', priceUsd, qty, pnlPct },
  });

  try {
    const { sendTelegramMessage } = await import('./telegram.js');
    await sendTelegramMessage(
      `${emoji} *해외 매도 체결* (${pnlStr})\n` +
      `종목: *${stockName}* (\`${stockCode}\`)\n` +
      `수량: ${qty}주 × $${priceUsd.toFixed(2)}\n` +
      `손익: ${pnlUsdStr}\n` +
      `사유: ${shortReason}`,
    );
  } catch { /* telegram optional */ }
}

export async function notifyAlert(title: string, body: string) {
  await sendPushNotification({ title, body, tag: 'alert-' + Date.now(), url: '/' });

  try {
    const { sendTelegramMessage } = await import('./telegram.js');
    await sendTelegramMessage(`⚠️ *${title}*\n${body}`);
  } catch { /* telegram optional */ }
}
