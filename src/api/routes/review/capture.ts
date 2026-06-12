/**
 * 스크린샷 캡처 저장/서빙 — /review/capture, /review/latest, /review/image/:index
 *
 * 강화 (2026-06-12):
 *  - 캡쳐 시 자동 Copilot 진단 → DB 저장 (mode 메타 포함)
 *  - GET /review/history — 시계열 히스토리
 *  - GET /review/compare — paper/live 동시 진단 비교
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { resolveRequestMode } from '../../guards/live-pin.js';
import { type CaptureTrigger, getCaptureHistory, triggerCapture } from './capture-trigger.js';

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
    const body = await c.req.json<{ screenshots: { tab: string; base64: string }[]; trigger?: CaptureTrigger }>();
    if (!body?.screenshots?.length) return c.json({ error: 'no screenshots' }, 400);

    capturedAt = new Date().toISOString();
    latestCaptures = body.screenshots.map((s) => ({
      tab: s.tab,
      base64: s.base64,
      capturedAt,
    }));

    if (captureExpireTimer) clearTimeout(captureExpireTimer);
    captureExpireTimer = setTimeout(() => {
      latestCaptures = [];
      capturedAt = '';
    }, 30 * 60_000);

    // 강화: 자동 진단 트리거 (현재 viewMode 기준)
    const viewIsPaper = resolveRequestMode(c);
    const mode = viewIsPaper ? 'paper' : 'live';
    const trigger = body.trigger ?? 'manual';
    const snapshot = await triggerCapture(trigger, mode, null).catch(() => null);

    return c.json({
      ok: true,
      count: latestCaptures.length,
      capturedAt,
      mode,
      diagnostic: snapshot
        ? { id: snapshot.id, score: snapshot.score, issues: snapshot.issues, actions: snapshot.actions }
        : null,
    });
  } finally {
    isCapturing = false;
  }
});

// ── GET /review/history — 캡쳐 시계열 히스토리 (강화 #3) ──
app.get('/review/history', async (c) => {
  const mode = c.req.query('mode') as 'paper' | 'live' | undefined;
  const trigger = c.req.query('trigger') as CaptureTrigger | undefined;
  const limit = Number(c.req.query('limit') ?? 50);
  const items = await getCaptureHistory({ mode, trigger, limit });
  return c.json({ items, count: items.length });
});

// ── GET /review/compare — paper/live 동시 진단 비교 (강화 #4) ──
app.get('/review/compare', async (c) => {
  const [paper, live] = await Promise.all([
    triggerCapture('manual', 'paper', null).catch(() => null),
    triggerCapture('manual', 'live', null).catch(() => null),
  ]);
  return c.json({
    timestamp: new Date().toISOString(),
    paper: paper ? { score: paper.score, issues: paper.issues, actions: paper.actions } : null,
    live: live ? { score: live.score, issues: live.issues, actions: live.actions } : null,
    scoreDelta: paper && live ? paper.score - live.score : null,
  });
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
  if (Number.isNaN(idx) || idx < 0 || idx >= latestCaptures.length) {
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
