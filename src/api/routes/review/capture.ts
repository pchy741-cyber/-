/**
 * 스크린샷 캡처 저장/서빙 — /review/capture, /review/latest, /review/image/:index
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

const app = new Hono();

// 최근 캡처 저장소 (메모리, 최대 1세트, 30분 만료)
let latestCaptures: { tab: string; base64: string; capturedAt: string }[] = [];
let capturedAt = '';
let captureExpireTimer: ReturnType<typeof setTimeout> | null = null;
let isCapturing = false;

app.post('/review/capture', bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
  if (isCapturing) return c.json({ error: '캡처 진행 중 — 잠시 후 다시 시도' }, 429);
  isCapturing = true;
  try {
    const body = await c.req.json<{ screenshots: { tab: string; base64: string }[] }>();
    if (!body?.screenshots?.length) return c.json({ error: 'no screenshots' }, 400);

    capturedAt = new Date().toISOString();
    latestCaptures = body.screenshots.map((s) => ({
      tab: s.tab,
      base64: s.base64,
      capturedAt,
    }));

    if (captureExpireTimer) clearTimeout(captureExpireTimer);
    captureExpireTimer = setTimeout(() => { latestCaptures = []; capturedAt = ''; }, 30 * 60_000);

    return c.json({ ok: true, count: latestCaptures.length, capturedAt });
  } finally {
    isCapturing = false;
  }
});

app.get('/review/latest', (c) => {
  if (!latestCaptures.length) return c.json({ captures: [], capturedAt: null });
  return c.json({
    capturedAt,
    captures: latestCaptures.map((cap, i) => ({
      index: i,
      tab: cap.tab,
      sizeKb: Math.round((cap.base64.length * 3) / 4 / 1024),
    })),
  });
});

app.get('/review/image/:index', (c) => {
  const idx = parseInt(c.req.param('index'), 10);
  if (isNaN(idx) || idx < 0 || idx >= latestCaptures.length) {
    return c.json({ error: 'not found' }, 404);
  }
  const cap = latestCaptures[idx];
  const raw = cap.base64.includes(',') ? cap.base64.split(',')[1] : cap.base64;
  const buffer = Buffer.from(raw, 'base64');
  return new Response(buffer, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Disposition': `inline; filename="aab_${idx}.jpg"`,
      'X-Tab': encodeURIComponent(cap.tab),
      'X-Captured-At': cap.capturedAt,
    },
  });
});

export default app;
