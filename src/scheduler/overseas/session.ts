/**
 * 세션 관리 — 시장 시간 판별, 세션 캐시, 실행 상태
 */
import { generateAndSaveInsights } from '../../ai/overseas/insights-generator.js';
import { getCtxIsPaper } from '../../config/context.js';
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
    vwapPosition?: 'ABOVE' | 'BELOW' | 'AT';
  }>;
}

type Mode = 'paper' | 'live';

/** 모듈간 공유되는 런타임 상태 — paper/live 분리 필요한 필드는 Map 구조 */
export const overseasState = {
  isRunning: new Map<Mode, boolean>([['paper', false], ['live', false]]),
  _shuttingDown: false,
  // ── 세션캐시: paper/live 완전 격리 (techCache 크로스오염 방지) ──
  usSessionCache: new Map<Mode, SessionCache | null>([['paper', null], ['live', null]]),
  asiaSessionCache: new Map<Mode, SessionCache | null>([['paper', null], ['live', null]]),
  // ── paper/live 격리 필드 ──
  extendedAlertSentAt: new Map<Mode, Map<string, number>>([['paper', new Map()], ['live', new Map()]]),
  lastUSAiCallAt: 0,
  lastPaperAiCallAt: 0,
  sessionStartPortfolioValue: new Map<Mode, number | null>([['paper', null], ['live', null]]),
  dailyLossAlertSent3: new Map<Mode, boolean>([['paper', false], ['live', false]]),
  dailyLossAlertSent5: new Map<Mode, boolean>([['paper', false], ['live', false]]),
};

/** 현재 모드 키 반환 */
export function modeKey(isPaper?: boolean): Mode {
  return (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
}

/** 세션캐시 접근자 — paper/live 격리 보장 */
export function getSessionCache(region: 'US' | 'ASIA', mode?: Mode): SessionCache | null {
  const m = mode ?? modeKey();
  return region === 'US'
    ? overseasState.usSessionCache.get(m) ?? null
    : overseasState.asiaSessionCache.get(m) ?? null;
}

export function setSessionCache(region: 'US' | 'ASIA', cache: SessionCache | null, mode?: Mode): void {
  const m = mode ?? modeKey();
  if (region === 'US') overseasState.usSessionCache.set(m, cache);
  else overseasState.asiaSessionCache.set(m, cache);
}

export const setShuttingDown = (v: boolean) => { overseasState._shuttingDown = v; };
export const isOverseasJobRunning = () =>
  overseasState.isRunning.get('paper') === true || overseasState.isRunning.get('live') === true;

/** 세션 시작 포트폴리오값 DB 영속화 (서버 재시작 시 복원용) */
async function persistSessionStartValue(value: number | null, mode?: Mode): Promise<void> {
  try {
    const key = `overseas_session_start_value${mode === 'paper' ? '_paper' : ''}`;
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

/** 서버 시작 시 세션 시작값 복원 (paper/live 모두) */
export async function restoreSessionStartValue(): Promise<void> {
  for (const mode of ['live', 'paper'] as Mode[]) {
    try {
      const key = mode === 'paper' ? 'overseas_session_start_value_paper' : 'overseas_session_start_value';
      const { rows } = await getPool().query(
        "SELECT value FROM overseas_state WHERE key = $1", [key],
      );
      if (rows.length > 0) {
        const parsed = JSON.parse(rows[0].value);
        const savedAt = new Date(parsed.savedAt);
        const ageMs = Date.now() - savedAt.getTime();
        if (ageMs < 24 * 60 * 60_000) {
          overseasState.sessionStartPortfolioValue.set(mode, parsed.value);
          logger.info(`📦 해외 세션 시작값 복원 [${mode}]: $${parsed.value.toFixed(0)} (${Math.round(ageMs / 60000)}분 전 저장)`, { component: 'OVERSEAS' });
        }
      }
    } catch { /* 복원 실패 → null 유지 */ }
  }
}

/** 세션 시작 포트폴리오값 설정 (overseas-job.ts에서 호출) */
export async function setSessionStartValue(value: number, isPaper?: boolean): Promise<void> {
  const mode = modeKey(isPaper);
  overseasState.sessionStartPortfolioValue.set(mode, value);
  await persistSessionStartValue(value, mode);
}

/** 미국장 세션 캐시 초기화 (runner.ts 23:20 호출) */
export function resetUSSessionCache(): void {
  overseasState.usSessionCache.set('paper', null);
  overseasState.usSessionCache.set('live', null);
  overseasState.sessionStartPortfolioValue.set('paper', null);
  overseasState.sessionStartPortfolioValue.set('live', null);
  overseasState.lastUSAiCallAt = 0;
  overseasState.lastPaperAiCallAt = 0;
  overseasState.dailyLossAlertSent3.set('paper', false);
  overseasState.dailyLossAlertSent3.set('live', false);
  overseasState.dailyLossAlertSent5.set('paper', false);
  overseasState.dailyLossAlertSent5.set('live', false);
  overseasState.extendedAlertSentAt.set('paper', new Map());
  overseasState.extendedAlertSentAt.set('live', new Map());
  persistSessionStartValue(null, 'live').catch(() => {});
  persistSessionStartValue(null, 'paper').catch(() => {});
  generateAndSaveInsights().catch(() => {});
}

/** 아시아장 세션 캐시 초기화 (runner.ts 08:50 호출) */
export function resetAsiaSessionCache(): void {
  overseasState.asiaSessionCache.set('paper', null);
  overseasState.asiaSessionCache.set('live', null);
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

  // 🇰🇷 한국 KRX: 09:00~15:30 KST (평일만 — 요일체크는 overseas-job에서)
  if (mins >= 9 * 60 && mins <= 15 * 60 + 30) open.add('KR');

  // 🇯🇵 일본 TSE: 09:00~11:30, 12:30~15:30 KST
  if ((mins >= 9 * 60 && mins <= 11 * 60 + 30) ||
      (mins >= 12 * 60 + 30 && mins <= 15 * 60 + 30)) open.add('JP');

  // 🇹🇼 대만 TWSE: KST 10:00~14:30
  if (mins >= 10 * 60 && mins <= 14 * 60 + 30) open.add('TW');

  return open;
}

// ── 종가베팅: US 마감 전 N분 구간 확인 ──
/**
 * 미국 정규장 마감 전 N분 구간인지 확인 (종가베팅 매수 윈도우)
 * Summer: 04:30~05:00 KST (N=30), Winter: 05:30~06:00 KST
 */
export function isUSMarketLastNMinutes(minutes: number = 30): boolean {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const shift = isUSDST() ? 0 : 60;
  const usClose = 5 * 60 + shift; // 05:00 KST (summer) / 06:00 KST (winter)
  const windowStart = usClose - minutes;
  return mins >= windowStart && mins <= usClose;
}

/** US 마감까지 남은 분 수 */
export function getMinutesToUSClose(): number {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const shift = isUSDST() ? 0 : 60;
  const usClose = 5 * 60 + shift;
  // 자정 전후 처리: 22:30~24:00 → close까지 남은 분 = (24*60 - mins) + close
  if (mins >= 22 * 60) return (24 * 60 - mins) + usClose;
  return Math.max(0, usClose - mins);
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
