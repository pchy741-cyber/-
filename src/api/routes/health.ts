import { Hono } from 'hono';
import { config } from '../../config/index.js';
import { checkDb } from '../../db/client.js';
import { isMarketOpen } from '../../kis/market.js';
import { getKillSwitchStatus } from '../../risk/kill-switch.js';
import { getActiveLocks } from '../../utils/lock.js';

export const healthRoutes = new Hono();

// 시스템 이벤트 로그 (최근 실행 결과 추적)
interface SystemEvent {
  component: string;
  status: 'success' | 'error' | 'running';
  message: string;
  timestamp: string;
}

const recentEvents: SystemEvent[] = [];
const MAX_EVENTS = 50;

export function logSystemEvent(component: string, status: 'success' | 'error' | 'running', message: string) {
  recentEvents.unshift({ component, status, message, timestamp: new Date().toISOString() });
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;
}

healthRoutes.get('/health', async (c) => {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const hour = kst.getHours();

  // 미국 장 시간 판단 (KST 23:30~06:00, 서머타임 22:30~05:00)
  const usMarketOpen = hour >= 23 || hour < 6;

  const checks: Record<string, unknown> = {
    status: 'ok',
    version: '0.2.0',
    framework: 'hono',
    timestamp: now.toISOString(),
    tradingMode: config.tradingMode,
    marketOpen: isMarketOpen(),
    usMarketOpen,
    killSwitch: getKillSwitchStatus(),
    activeLocks: getActiveLocks(),
    uptime: Math.floor(process.uptime()),
    recentEvents: recentEvents.slice(0, 10),
    // 다음 이벤트 안내
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
  const h = kst.getHours();
  const m = kst.getMinutes();
  const t = h * 60 + m;
  const day = kst.getDay();
  const isWeekday = day >= 1 && day <= 5;

  if (!isWeekday) return '주말 — 월요일 07:30 Track A';
  if (t < 450) return `07:30 Track A 장전 분석 (${450 - t}분 후)`;
  if (t < 540) return `09:00 국내 장 시작 (${540 - t}분 후)`;
  if (t < 930) return `15:30 국내 장 마감 (${930 - t}분 후)`;
  if (t < 1080) return `18:00 Track A 장후 분석 (${1080 - t}분 후)`;
  if (t < 1410) return `23:30 미국 장 시작 (${1410 - t}분 후)`;
  return '미국 장중 — 15분 간격 자동매매';
}
