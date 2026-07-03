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
  techCache: Map<
    string,
    {
      score: number;
      rsi: number;
      adx: number;
      signal: string;
      trendStrength: string;
      isMomentum: boolean;
      dayRangePct: number;
      aboveMA20: boolean;
      aboveMA60: boolean;
      bollingerSqueeze: boolean;
      bollingerBreakout: 'UP' | 'DOWN' | 'NONE';
      atrPct: number;
      vwapPosition?: 'ABOVE' | 'BELOW' | 'AT';
    }
  >;
}

type Mode = 'paper' | 'live';

/** 모듈간 공유되는 런타임 상태 — paper/live 분리 필요한 필드는 Map 구조 */
export const overseasState = {
  isRunning: new Map<Mode, boolean>([
    ['paper', false],
    ['live', false],
  ]),
  _shuttingDown: false,
  // ── 세션캐시: paper/live 완전 격리 (techCache 크로스오염 방지) ──
  usSessionCache: new Map<Mode, SessionCache | null>([
    ['paper', null],
    ['live', null],
  ]),
  asiaSessionCache: new Map<Mode, SessionCache | null>([
    ['paper', null],
    ['live', null],
  ]),
  // ── paper/live 격리 필드 ──
  extendedAlertSentAt: new Map<Mode, Map<string, number>>([
    ['paper', new Map()],
    ['live', new Map()],
  ]),
  lastUSAiCallAt: 0,
  lastPaperAiCallAt: 0,
  sessionStartPortfolioValue: new Map<Mode, number | null>([
    ['paper', null],
    ['live', null],
  ]),
  dailyLossAlertSent3: new Map<Mode, boolean>([
    ['paper', false],
    ['live', false],
  ]),
  dailyLossAlertSent5: new Map<Mode, boolean>([
    ['paper', false],
    ['live', false],
  ]),
};

/** 현재 모드 키 반환 */
export function modeKey(isPaper?: boolean): Mode {
  return (isPaper ?? getCtxIsPaper()) ? 'paper' : 'live';
}

/** 세션캐시 접근자 — paper/live 격리 보장 */
export function getSessionCache(region: 'US' | 'ASIA', mode?: Mode): SessionCache | null {
  const m = mode ?? modeKey();
  return region === 'US'
    ? (overseasState.usSessionCache.get(m) ?? null)
    : (overseasState.asiaSessionCache.get(m) ?? null);
}

export function setSessionCache(region: 'US' | 'ASIA', cache: SessionCache | null, mode?: Mode): void {
  const m = mode ?? modeKey();
  if (region === 'US') overseasState.usSessionCache.set(m, cache);
  else overseasState.asiaSessionCache.set(m, cache);
}

export const setShuttingDown = (v: boolean) => {
  overseasState._shuttingDown = v;
};
export const isOverseasJobRunning = () =>
  overseasState.isRunning.get('paper') === true || overseasState.isRunning.get('live') === true;

/** 세션 시작 포트폴리오값 DB 영속화 (서버 재시작 시 복원용) */
async function persistSessionStartValue(value: number | null, mode?: Mode): Promise<void> {
  try {
    const key = `overseas_session_start_value${mode === 'paper' ? '_paper' : ''}`;
    if (value === null) {
      await getPool().query('DELETE FROM overseas_state WHERE key = $1', [key]);
    } else {
      await getPool().query(
        `INSERT INTO overseas_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, JSON.stringify({ value, savedAt: new Date().toISOString() })],
      );
    }
  } catch {
    /* DB 실패 시 무시 — 메모리 값은 유지 */
  }
}

/** 서버 시작 시 세션 시작값 복원 (paper/live 모두) */
export async function restoreSessionStartValue(): Promise<void> {
  for (const mode of ['live', 'paper'] as Mode[]) {
    try {
      const key = mode === 'paper' ? 'overseas_session_start_value_paper' : 'overseas_session_start_value';
      const { rows } = await getPool().query('SELECT value FROM overseas_state WHERE key = $1', [key]);
      if (rows.length > 0) {
        const parsed = JSON.parse(rows[0].value);
        const savedAt = new Date(parsed.savedAt);
        const ageMs = Date.now() - savedAt.getTime();
        const MAX_SESSION_AGE_MS = 24 * 60 * 60_000; // 24 hours
        if (ageMs < MAX_SESSION_AGE_MS && Number.isFinite(parsed.value)) {
          overseasState.sessionStartPortfolioValue.set(mode, parsed.value);
          logger.info(
            `📦 해외 세션 시작값 복원 [${mode}]: $${parsed.value.toFixed(0)} (${Math.round(ageMs / 60000)}분 전 저장)`,
            { component: 'OVERSEAS' },
          );
        }
      }
    } catch {
      /* 복원 실패 → null 유지 */
    }
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

// ── 시장 시간 — shared/overseas/market-time.ts에서 re-export (하위호환) ──
export { isUSDST, getOpenMarketRegions, KST_OFFSET_MS } from '../../shared/overseas/market-time.js';
import { isUSDST, KST_OFFSET_MS } from '../../shared/overseas/market-time.js';

// ── 종가베팅: US 마감 전 N분 구간 확인 ──
/**
 * 미국 정규장 마감 전 N분 구간인지 확인 (종가베팅 매수 윈도우)
 * Summer: 04:30~05:00 KST (N=30), Winter: 05:30~06:00 KST
 */
export function isUSMarketLastNMinutes(minutes: number = 30): boolean {
  const now = new Date();
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const shift = isUSDST() ? 0 : 60;
  const usClose = 5 * 60 + shift; // 05:00 KST (summer) / 06:00 KST (winter)
  const windowStart = usClose - minutes;
  return mins >= windowStart && mins <= usClose;
}

/** US 마감까지 남은 분 수 */
export function getMinutesToUSClose(): number {
  const now = new Date();
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const shift = isUSDST() ? 0 : 60;
  const usClose = 5 * 60 + shift;
  // 자정 전후 처리: 22:30~24:00 → close까지 남은 분 = (24*60 - mins) + close
  if (mins >= 22 * 60) return 24 * 60 - mins + usClose;
  return Math.max(0, usClose - mins);
}

/** KST 날짜 문자열 반환 */
export function getKSTDateString(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

/** 미국 세션 ID — KST 기준 날짜+야간세션(0~6시는 전날로 묶음) */
export function getUSSessionId(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const h = kst.getUTCHours();
  if (h < 7) kst.setUTCDate(kst.getUTCDate() - 1);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}
