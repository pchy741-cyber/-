import { Hono } from 'hono';
import { baseTradingMode } from '../../config/index.js';
import { checkDb, isMemoryMode } from '../../db/client.js';
import { isMarketOpen } from '../../kis/market.js';
import { getKillSwitchStatusAll } from '../../risk/kill-switch.js';
import { isWaking, tryWakeIfNeeded } from '../../utils/cloud-sql-wake.js';
import { getActiveLocks } from '../../utils/lock.js';
import { getRecentEvents } from '../../utils/system-events.js';
import { isUSDST } from '../../shared/overseas/market-time.js';

// 역호환: 기존 import 경로 유지
export { logSystemEvent, getRecentEvents } from '../../utils/system-events.js';

export const healthRoutes = new Hono();

// 공개: 최소 정보만 (운영 정보 노출 차단)
// db 필드: PWA가 DB 기상 상태를 알 수 있도록 추가
// 주말에도 사용자 접속 시 DB wake 트리거
healthRoutes.get('/health', async (c) => {
  const mem = isMemoryMode();
  // Health endpoint should NOT trigger DB wake — only report status.
  // DB wake is triggered by actual data requests, not health checks.
  return c.json({ status: 'ok', db: mem ? (isWaking() ? 'waking' : 'offline') : 'ok' }, 200);
});


// 인증 후 상세 헬스 — requireAuth 미들웨어 뒤에서 마운트 필요
export const healthDetailRoutes = new Hono();
healthDetailRoutes.get('/health/detail', async (c) => {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hour = kst.getUTCHours();
  const mins = hour * 60 + kst.getUTCMinutes();
  const shift = isUSDST() ? 0 : 60; // 서머타임: 0, 겨울: +60분
  const usOpen = 22 * 60 + 30 + shift;  // 서머 22:30 / 겨울 23:30
  const usClose = 5 * 60 + shift;       // 서머 05:00 / 겨울 06:00
  const usMarketOpen = mins >= usOpen || mins <= usClose;

  const kstStr = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}:${String(kst.getUTCSeconds()).padStart(2, '0')} KST`;
  const checks: Record<string, unknown> = {
    status: 'ok',
    version: '0.2.0',
    framework: 'hono',
    timestamp: now.toISOString(),
    serverTimeKst: kstStr,
    tradingMode: baseTradingMode,
    marketOpen: isMarketOpen(),
    usMarketOpen,
    killSwitch: getKillSwitchStatusAll(),
    activeLocks: getActiveLocks(),
    uptime: Math.floor(process.uptime()),
    recentEvents: getRecentEvents(10),
    nextEvent: getNextEvent(kst),
  };

  try {
    const ok = await checkDb();
    checks.database = ok ? 'connected' : 'error';
  } catch {
    checks.database = 'disconnected';
  }

  return c.json(checks, 200);
});

function getNextEvent(kst: Date): string {
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const t = h * 60 + m;
  const day = kst.getUTCDay();
  const isWeekday = day >= 1 && day <= 5;

  if (!isWeekday) return '주말 — 월요일 07:30 Track A';
  if (t < 450) return `07:30 Track A 장전 분석 (${450 - t}분 후)`;
  if (t < 540) return `09:00 국내 장 시작 (${540 - t}분 후)`;
  if (t < 930) return `15:30 국내 장 마감 (${930 - t}분 후)`;
  if (t < 1080) return `18:00 Track A 장후 분석 (${1080 - t}분 후)`;
  if (t < 1410) return `23:30 미국 장 시작 (${1410 - t}분 후)`;
  return '미국 장중 — 15분 간격 자동매매';
}
