/**
 * AI Override Store — Claude Code/Cursor AI가 설정한 트레이딩 파라미터 오버라이드
 *
 * 구독형 AI(Opus급)가 API 토큰 비용 없이 매매 파라미터를 동적으로 조절.
 * 모든 오버라이드는 TTL 기반 자동 만료 + 모드(paper/live) 격리.
 */

import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ── 타입 ──────────────────────────────────────────────────────────────
export type OverrideCategory = 'stock' | 'risk' | 'threshold' | 'signal';

export interface AiOverride {
  id: number;
  category: OverrideCategory;
  key: string;
  value: unknown;
  reason: string | null;
  is_paper: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiCommand {
  type: 'setOverride' | 'removeOverride' | 'forceAction';
  category?: OverrideCategory;
  key: string;
  value?: unknown;
  reason?: string;
  ttlMinutes?: number; // 기본 120분 (2시간)
}

// ── 밸리데이션 범위 (안전 가드) ─────────────────────────────────────
const VALUE_BOUNDS: Record<string, { min: number; max: number }> = {
  scoreAdj: { min: -20, max: 20 },
  minBuyScore: { min: 55, max: 95 },
  maxPositionPct: { min: 5, max: 25 },
  stopLossPct: { min: -10, max: -1 },
  takeProfitPct: { min: 2, max: 15 },
  trailTighten: { min: 0, max: 3 },
};

function validateBound(key: string, val: unknown): string | null {
  // key에서 bound 타입 추출 (e.g. '005930_scoreAdj' → 'scoreAdj')
  const suffix = key.includes('_') ? key.split('_').pop()! : key;
  const bound = VALUE_BOUNDS[suffix];
  if (!bound || typeof val !== 'number') return null;
  if (val < bound.min || val > bound.max) {
    return `값 ${val}이 허용 범위(${bound.min}~${bound.max})를 벗어남`;
  }
  return null;
}

// ── 인메모리 캐시 (빠른 조회용, DB 동기화) ──────────────────────────
const _cache = new Map<string, { value: unknown; expiresAt: number | null }>();
let _cacheLoaded = false;

function cacheKey(key: string, isPaper: boolean): string {
  return `${isPaper ? 'P' : 'L'}:${key}`;
}

/** 서버 시작 시 DB → 캐시 로드 */
export async function loadOverridesCache(): Promise<void> {
  try {
    const { rows } = await getPool().query<AiOverride>(
      `SELECT * FROM ai_overrides WHERE expires_at IS NULL OR expires_at > NOW()`,
    );
    _cache.clear();
    for (const r of rows) {
      _cache.set(cacheKey(r.key, r.is_paper), {
        value: r.value,
        expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
      });
    }
    _cacheLoaded = true;
    logger.info(`🤖 AI 오버라이드 캐시 로드: ${rows.length}건`, { component: 'AI_LOOP' });
  } catch {
    // 테이블 미존재 시 무시 (마이그레이션 전)
    _cacheLoaded = true;
  }
}

// ── 조회 (파이프라인에서 호출, 초고속) ──────────────────────────────
/**
 * 특정 오버라이드 값 조회. 만료된 것은 자동 제외.
 * @param key 오버라이드 키 (e.g. '005930_scoreAdj', 'minBuyScore')
 * @param isPaper 모드 (기본: 현재 컨텍스트)
 */
export function getOverride<T = unknown>(key: string, isPaper?: boolean): T | null {
  const mode = isPaper ?? getCtxIsPaper();
  const ck = cacheKey(key, mode);
  const entry = _cache.get(ck);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    _cache.delete(ck);
    return null;
  }
  return entry.value as T;
}

/** 특정 카테고리의 모든 오버라이드 (prefix 매칭) */
export function getOverridesByPrefix(prefix: string, isPaper?: boolean): Map<string, unknown> {
  const mode = isPaper ?? getCtxIsPaper();
  const modePrefix = mode ? 'P:' : 'L:';
  const result = new Map<string, unknown>();
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (!k.startsWith(modePrefix)) continue;
    if (v.expiresAt && now > v.expiresAt) continue;
    const realKey = k.slice(2); // 'P:' 또는 'L:' 제거
    if (realKey.startsWith(prefix) || realKey.includes(`_${prefix}`)) {
      result.set(realKey, v.value);
    }
  }
  return result;
}

// ── 쓰기 (AI Loop 명령 처리) ────────────────────────────────────────
export async function setOverride(
  category: OverrideCategory,
  key: string,
  value: unknown,
  reason: string | null,
  ttlMinutes: number = 120,
  isPaper?: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const mode = isPaper ?? getCtxIsPaper();

  // 안전 가드: 값 범위 검증
  const boundErr = validateBound(key, value);
  if (boundErr) return { ok: false, error: boundErr };

  // Kill switch 관련 오버라이드 차단
  if (key.toLowerCase().includes('killswitch') || key.toLowerCase().includes('kill_switch')) {
    return { ok: false, error: 'Kill switch 오버라이드는 금지됨' };
  }

  const expiresAt = ttlMinutes > 0 ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null;

  try {
    await getPool().query(
      `INSERT INTO ai_overrides (category, key, value, reason, is_paper, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (key, is_paper) DO UPDATE SET
         value = EXCLUDED.value,
         reason = EXCLUDED.reason,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [category, key, JSON.stringify(value), reason, mode, expiresAt],
    );

    // 캐시 갱신
    _cache.set(cacheKey(key, mode), {
      value,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
    });

    // 감사 로그
    await logCommand('setOverride', { category, key, value, reason, ttlMinutes }, 'OK', null, mode);
    logger.info(
      `🤖 AI 오버라이드 설정: [${category}] ${key} = ${JSON.stringify(value)} (TTL=${ttlMinutes}분, reason=${reason})`,
      { component: 'AI_LOOP' },
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logCommand('setOverride', { category, key, value }, 'ERROR', msg, mode).catch(() => {});
    return { ok: false, error: msg };
  }
}

export async function removeOverride(key: string, isPaper?: boolean): Promise<{ ok: boolean }> {
  const mode = isPaper ?? getCtxIsPaper();
  try {
    await getPool().query(`DELETE FROM ai_overrides WHERE key = $1 AND is_paper = $2`, [key, mode]);
    _cache.delete(cacheKey(key, mode));
    await logCommand('removeOverride', { key }, 'OK', null, mode);
    logger.info(`🤖 AI 오버라이드 삭제: ${key}`, { component: 'AI_LOOP' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** 만료된 오버라이드 정리 (1시간마다 호출) */
export async function cleanupExpired(): Promise<number> {
  try {
    const { rowCount } = await getPool().query(
      `DELETE FROM ai_overrides WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
    );
    const count = rowCount ?? 0;
    if (count > 0) {
      logger.info(`🤖 만료된 AI 오버라이드 ${count}건 정리`, { component: 'AI_LOOP' });
      await loadOverridesCache(); // 캐시 재동기화
    }
    return count;
  } catch {
    return 0;
  }
}

// ── 전체 조회 (대시보드/API용) ──────────────────────────────────────
export async function getAllOverrides(isPaper?: boolean): Promise<AiOverride[]> {
  const mode = isPaper ?? getCtxIsPaper();
  try {
    const { rows } = await getPool().query<AiOverride>(
      `SELECT * FROM ai_overrides
       WHERE is_paper = $1 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY category, key`,
      [mode],
    );
    return rows;
  } catch {
    return [];
  }
}

export async function getCommandHistory(limit: number = 50): Promise<unknown[]> {
  try {
    const { rows } = await getPool().query(`SELECT * FROM ai_command_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows;
  } catch {
    return [];
  }
}

// ── 감사 로그 ───────────────────────────────────────────────────────
async function logCommand(
  type: string,
  payload: unknown,
  result: string,
  rejectReason: string | null,
  isPaper: boolean,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO ai_command_log (command_type, payload, result, reject_reason, is_paper)
       VALUES ($1, $2, $3, $4, $5)`,
      [type, JSON.stringify(payload), result, rejectReason, isPaper],
    );
  } catch {
    /* 로그 실패는 무시 */
  }
}
