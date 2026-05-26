/**
 * 세션 관리 — 시장 시간 판별, 세션 캐시, 실행 상태
 */
import { generateAndSaveInsights } from '../../ai/overseas/insights-generator.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

// ── 세션 캐시 (미국/아시아 별도 관리) ──
export interface SessionCache {
  topCodes: string[];
  sessionDate: string;
  techCache: Map<string, {
    score: number; rsi: number; adx: number; signal: string;
    trendStrength: string; isMomentum: boolean; dayRangePct: number;
    aboveMA20: boolean; aboveMA60: boolean;
    bollingerSqueeze: boolean; bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
    atrPct: number;
  }>;
}

/** 모듈간 공유되는 런타임 상태 */
export const overseasState = {
  isRunning: false,
  _shuttingDown: false,
  usSessionCache: null as SessionCache | null,
  asiaSessionCache: null as SessionCache | null,
  extendedAlertSentAt: new Map<string, number>(),
  lastUSAiCallAt: 0,
  lastPaperAiCallAt: 0,
  sessionStartPortfolioValue: null as number | null,
  dailyLossAlertSent3: false,
  dailyLossAlertSent5: false,
};

export const setShuttingDown = (v: boolean) => { overseasState._shuttingDown = v; };
export const isOverseasJobRunning = () => overseasState.isRunning;

/** 세션 시작 포트폴리오값 DB 영속화 (서버 재시작 시 복원용) */
async function persistSessionStartValue(value: number | null): Promise<void> {
  try {
    const key = 'overseas_session_start_value';
    if (value === null) {
      await getPool().query("DELETE FROM overseas_state WHERE key = $1", [key]);
    } else {
      await getPool().query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, JSON.stringify({ value, savedAt: new Date().toISOString() })],
      );
    }
  } catch { /* DB 실패 시 무시 — 메모리 값은 유지 */ }
}

/** 서버 시작 시 세션 시작값 복원 */
export async function restoreSessionStartValue(): Promise<void> {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = 'overseas_session_start_value'",
    );
    if (rows.length > 0) {
      const parsed = JSON.parse(rows[0].value);
      const savedAt = new Date(parsed.savedAt);
      const ageMs = Date.now() - savedAt.getTime();
      // 24시간 이내 저장된 값만 복원 (세션 넘어간 값은 무시)
      if (ageMs < 24 * 60 * 60_000) {
        overseasState.sessionStartPortfolioValue = parsed.value;
        logger.info(`📦 해외 세션 시작값 복원: $${parsed.value.toFixed(0)} (${Math.round(ageMs / 60000)}분 전 저장)`, { component: 'OVERSEAS' });
      }
    }
  } catch { /* 복원 실패 → null 유지 (첫 실행 시 자동 설정) */ }
}

/** 세션 시작 포트폴리오값 설정 (overseas-job.ts에서 호출) */
export async function setSessionStartValue(value: number): Promise<void> {
  overseasState.sessionStartPortfolioValue = value;
  await persistSessionStartValue(value);
}

/** 미국장 세션 캐시 초기화 (runner.ts 23:20 호출) */
export function resetUSSessionCache(): void {
  overseasState.usSessionCache = null;
  overseasState.sessionStartPortfolioValue = null;
  overseasState.lastUSAiCallAt = 0;
  overseasState.lastPaperAiCallAt = 0;
  overseasState.dailyLossAlertSent3 = false;
  overseasState.dailyLossAlertSent5 = false;
  persistSessionStartValue(null).catch(() => {});
  generateAndSaveInsights().catch(() => {});
}

/** 아시아장 세션 캐시 초기화 (runner.ts 08:50 호출) */
export function resetAsiaSessionCache(): void {
  overseasState.asiaSessionCache = null;
}

// ── 미국 서머타임(DST) 자동 감지 ──
// 규칙: 3월 둘째 일요일 2AM EST ~ 11월 첫째 일요일 2AM EDT
function isUSDST(): boolean {
  const now = new Date();
  const month = now.getUTCMonth(); // 0-indexed
  const year = now.getUTCFullYear();

  if (month > 2 && month < 10) return true;   // Apr~Oct: always DST
  if (month < 2 || month > 10) return false;   // Jan~Feb, Dec: never DST

  const nthSunday = (m: number, n: number) => {
    const dow = new Date(Date.UTC(year, m, 1)).getUTCDay();
    return (dow === 0 ? 1 : 8 - dow) + (n - 1) * 7;
  };

  if (month === 2) { // March: DST starts 2nd Sunday 2AM EST = 7AM UTC
    return now >= new Date(Date.UTC(year, 2, nthSunday(2, 2), 7));
  }
  // November: DST ends 1st Sunday 2AM EDT = 6AM UTC
  return now < new Date(Date.UTC(year, 10, nthSunday(10, 1), 6));
}

/** DST 여부 외부 노출 (cron 스케줄 등에서 사용) */
export { isUSDST };

// ── 현재 열려 있는 시장 판별 (KST 기준, DST 자동) ──
export function getOpenMarketRegions(): Set<string> {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const open = new Set<string>();

  const shift = isUSDST() ? 0 : 60; // 겨울시간 = 1시간 후

  // 🇺🇸 미국 정규장 (서머: KST 22:30~05:00 / 겨울: 23:30~06:00)
  const usOpen = 22 * 60 + 30 + shift;
  const usClose = 5 * 60 + shift;
  if (mins >= usOpen || mins <= usClose) open.add('US');

  // 🇺🇸 프리마켓 + 포스트마켓 (서머: 17:00~22:30 / 겨울: 18:00~23:30)
  const preStart = 17 * 60 + shift;
  const postEnd = 9 * 60 + shift;
  if ((mins >= preStart && mins < usOpen) ||
      (mins > usClose && mins <= postEnd)) open.add('US_EXTENDED');

  // 🇯🇵 일본 TSE: 09:00~11:30, 12:30~15:30 KST
  if ((mins >= 9 * 60 && mins <= 11 * 60 + 30) ||
      (mins >= 12 * 60 + 30 && mins <= 15 * 60 + 30)) open.add('JP');

  // 🇹🇼 대만 TWSE: KST 10:00~14:30
  if (mins >= 10 * 60 && mins <= 14 * 60 + 30) open.add('TW');

  return open;
}

/** KST 날짜 문자열 반환 */
export function getKSTDateString(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

/** 미국 세션 ID — KST 기준 날짜+야간세션(0~6시는 전날로 묶음) */
export function getUSSessionId(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  if (h < 7) kst.setUTCDate(kst.getUTCDate() - 1);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}
