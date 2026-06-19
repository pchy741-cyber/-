import { Hono } from 'hono';

export const pushNotificationsRoutes = new Hono();

// ── 푸시 알림 ──
pushNotificationsRoutes.get('/push/vapid-key', async (c) => {
  const { getVapidPublicKey, initVapid } = await import('../../../notifications/web-push.js');
  // 아직 초기화 안 됐을 경우 대기
  if (!getVapidPublicKey()) await initVapid();
  return c.json({ publicKey: getVapidPublicKey() });
});

pushNotificationsRoutes.get('/push/status', async (c) => {
  const { isVapidReady, getSubscriptionCount, getVapidPublicKey } = await import('../../../notifications/web-push.js');
  const count = isVapidReady() ? await getSubscriptionCount() : 0;
  return c.json({
    ready: isVapidReady(),
    publicKey: getVapidPublicKey(),
    deviceCount: count,
  });
});

pushNotificationsRoutes.post('/push/subscribe', async (c) => {
  const subscription = await c.req.json();
  const { saveSubscription } = await import('../../../notifications/web-push.js');
  await saveSubscription(subscription);
  return c.json({ ok: true });
});

pushNotificationsRoutes.post('/push/test', async (c) => {
  const { sendPushNotification, isVapidReady } = await import('../../../notifications/web-push.js');
  if (!isVapidReady()) return c.json({ ok: false, error: 'VAPID 미준비' }, 503);
  await sendPushNotification({
    title: '🔔 알림 테스트',
    body: '매수·매도·긴급상황 알림이 이렇게 옵니다. 실제 거래 시 즉시 알림됩니다.',
    tag: `test-${Date.now()}`,
    url: '/',
  });
  return c.json({ ok: true });
});

pushNotificationsRoutes.delete('/push/subscriptions', async (c) => {
  const { purgeAllSubscriptions } = await import('../../../notifications/web-push.js');
  const count = await purgeAllSubscriptions();
  return c.json({ ok: true, deleted: count });
});
