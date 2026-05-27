import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface KISToken {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
}

let cachedToken: KISToken | null = null;
let cachedTokenIsPaper: boolean | null = null;
// 동시 발급 방지 뮤텍스 — 서버 시작 직후 burst 요청에서 토큰이 중복 발급되는 경쟁 조건 차단
let inflightRequest: Promise<string> | null = null;

// 모드별 별도 캐시 + 뮤텍스 (getAccessTokenForMode용)
// getAccessTokenForMode는 paper서버에서 live잔고 조회 등 cross-mode 호출에 사용
const modeTokenCache = new Map<string, KISToken>();
const modeInflight = new Map<string, Promise<string>>();

// DB에서 토큰 로드 (재시작 시 재발급 방지)
async function loadTokenFromDb(isPaper: boolean): Promise<KISToken | null> {
  try {
    const { getPool, isMemoryMode } = await import('../db/client.js');
    if (isMemoryMode()) return null;
    const key = isPaper ? 'kis_token_paper' : 'kis_token_live';
    const { rows } = await getPool().query<{ value: string }>(
      'SELECT value FROM system_state WHERE key = $1',
      [key]
    );
    if (!rows[0]) return null;
    const saved = JSON.parse(rows[0].value) as { accessToken: string; tokenType: string; expiresAt: string };
    const token: KISToken = { ...saved, expiresAt: new Date(saved.expiresAt) };
    if (isExpired(token)) return null;
    return token;
  } catch {
    return null;
  }
}

// 발급받은 토큰을 DB에 저장
async function saveTokenToDb(token: KISToken, isPaper: boolean): Promise<void> {
  try {
    const { getPool, isMemoryMode } = await import('../db/client.js');
    if (isMemoryMode()) return;
    const key = isPaper ? 'kis_token_paper' : 'kis_token_live';
    const value = JSON.stringify({ accessToken: token.accessToken, tokenType: token.tokenType, expiresAt: token.expiresAt.toISOString() });
    await getPool().query(
      `INSERT INTO system_state(key, value) VALUES($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  } catch (err) {
    logger.warn(`KIS 토큰 DB 저장 실패 (무시): ${err}`, { component: 'KIS_AUTH' });
  }
}

/**
 * KIS OAuth2 토큰 발급/캐싱
 * - 토큰 유효기간: ~24시간
 * - 만료 30분 전 자동 갱신
 * - 모드(paper/live) 전환 시 자동 재발급
 * - DB 영속화: 서비스 재시작 시 DB에서 기존 토큰 로드 → KIS 1일 1회 발급 제한 준수
 */
/**
 * 특정 모드의 토큰 발급 (서버 모드와 독립)
 * paper 서버에서 live 잔고 조회 시 사용
 * 뮤텍스 + 인메모리 캐시로 중복 발급 완전 방지
 */
export async function getAccessTokenForMode(mode: 'paper' | 'live'): Promise<string> {
  const isPaper = mode === 'paper';

  // 1차: 공유 캐시 확인 (getAccessToken과 동일 모드면 히트)
  if (cachedToken && !isExpired(cachedToken) && cachedTokenIsPaper === isPaper) {
    return cachedToken.accessToken;
  }

  // 2차: 모드별 전용 캐시 확인
  const modeCached = modeTokenCache.get(mode);
  if (modeCached && !isExpired(modeCached)) {
    return modeCached.accessToken;
  }

  // 동시 발급 방지 뮤텍스: 이미 진행 중이면 그 결과 공유
  const existing = modeInflight.get(mode);
  if (existing) return existing;

  const promise = (async () => {
    try {
      // 3차: DB에서 복원
      const dbToken = await loadTokenFromDb(isPaper);
      if (dbToken) {
        modeTokenCache.set(mode, dbToken);
        logger.info(`KIS 토큰 [${mode}] DB 복원, 만료: ${dbToken.expiresAt.toISOString()}`, { component: 'KIS_AUTH' });
        return dbToken.accessToken;
      }

      // 4차: 신규 발급 (최후 수단)
      logger.info(`KIS 토큰 [${mode}] 신규 발급 요청`, { component: 'KIS_AUTH' });
      const isLive = mode === 'live';
      const appKey = isLive
        ? (process.env.KIS_APP_KEY_LIVE || process.env.KIS_APP_KEY || '')
        : (process.env.KIS_APP_KEY || '');
      const appSecret = isLive
        ? (process.env.KIS_APP_SECRET_LIVE || process.env.KIS_APP_SECRET || '')
        : (process.env.KIS_APP_SECRET || '');
      const baseUrl = isLive
        ? 'https://openapi.koreainvestment.com:9443'
        : 'https://openapivts.koreainvestment.com:29443';

      const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
      });
      const rawBody = await res.text();
      if (!res.ok) throw new Error(`KIS 토큰 발급 실패 [${mode}] (${res.status}): ${rawBody}`);
      const data = JSON.parse(rawBody) as { access_token?: string; token_type?: string; access_token_token_expired?: string };
      if (!data.access_token) throw new Error(`KIS 토큰 발급 실패 [${mode}]`);

      const token: KISToken = {
        accessToken: data.access_token,
        tokenType: data.token_type ?? 'Bearer',
        expiresAt: new Date(data.access_token_token_expired ?? ''),
      };
      modeTokenCache.set(mode, token);
      await saveTokenToDb(token, isPaper);
      logger.info(`KIS 토큰 [${mode}] 발급 완료, 만료: ${token.expiresAt.toISOString()}`, { component: 'KIS_AUTH' });
      return token.accessToken;
    } finally {
      modeInflight.delete(mode);
    }
  })();

  modeInflight.set(mode, promise);
  return promise;
}

export async function getAccessToken(): Promise<string> {
  const isPaper = config.isPaper;
  if (cachedToken && !isExpired(cachedToken) && cachedTokenIsPaper === isPaper) {
    return cachedToken.accessToken;
  }

  // 동시 발급 방지: 이미 진행 중인 발급 요청이 있으면 그 결과를 공유
  if (inflightRequest) return inflightRequest;

  inflightRequest = (async () => {
    try {
      // 재시작 후 첫 호출: DB에서 유효한 토큰 복원 시도
      if (!cachedToken || cachedTokenIsPaper !== isPaper) {
        const dbToken = await loadTokenFromDb(isPaper);
        if (dbToken) {
          cachedToken = dbToken;
          cachedTokenIsPaper = isPaper;
          logger.info(`KIS 토큰 DB 복원 성공, 만료: ${dbToken.expiresAt.toISOString()}`, { component: 'KIS_AUTH', isPaper });
          return dbToken.accessToken;
        }
      }

      logger.info('KIS 토큰 발급 요청', { component: 'KIS_AUTH', isPaper });

      // config.kis is a dynamic getter — returns correct live/paper credentials based on current mode
      const appKey = config.kis.appKey;
      const appSecret = config.kis.appSecret;

      const res = await fetch(`${config.kis.baseUrl}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: appKey,
          appsecret: appSecret,
        }),
      });

      const rawBody = await res.text();
      if (!res.ok) {
        throw new Error(`KIS 토큰 발급 실패 (${res.status}): ${rawBody}`);
      }

      const data = JSON.parse(rawBody) as { access_token?: string; token_type?: string; access_token_token_expired?: string; error_code?: string; error_description?: string };

      if (!data.access_token) {
        throw new Error(`KIS 토큰 발급 실패: ${data.error_code ?? 'unknown'} - ${data.error_description ?? rawBody}`);
      }

      cachedToken = {
        accessToken: data.access_token,
        tokenType: data.token_type ?? 'Bearer',
        expiresAt: new Date(data.access_token_token_expired ?? ''),
      };
      cachedTokenIsPaper = isPaper;

      logger.info(`KIS 토큰 발급 완료, 만료: ${cachedToken.expiresAt.toISOString()}`, {
        component: 'KIS_AUTH',
      });

      // DB에 저장 — 다음 재시작 시 재발급 없이 복원
      await saveTokenToDb(cachedToken, isPaper);

      return cachedToken.accessToken;
    } finally {
      inflightRequest = null;
    }
  })();

  return inflightRequest;
}

/**
 * Hashkey 발급 (주문 API 필수)
 */
export async function getHashkey(body: Record<string, unknown>): Promise<string> {
  const appKey = config.kis.appKey;
  const appSecret = config.kis.appSecret;

  const res = await fetch(`${config.kis.baseUrl}/uapi/hashkey`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      appkey: appKey,
      appsecret: appSecret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Hashkey 발급 실패: ${res.status}`);
  }

  const data = (await res.json()) as { HASH: string };
  return data.HASH;
}

function isExpired(token: KISToken): boolean {
  // 만료 30분 전에 갱신
  const buffer = 30 * 60 * 1000;
  return Date.now() > token.expiresAt.getTime() - buffer;
}

export function clearTokenCache() {
  cachedToken = null;
  modeTokenCache.clear();
  // DB 토큰도 삭제 (KIS 서버에서 무효화된 토큰이 DB 복원되는 것 방지)
  // 현재 모드의 토큰만 삭제 (반대 모드는 유지)
  (async () => {
    try {
      const { getPool, isMemoryMode } = await import('../db/client.js');
      if (isMemoryMode()) return;
      const key = config.isPaper ? 'kis_token_paper' : 'kis_token_live';
      await getPool().query('DELETE FROM system_state WHERE key = $1', [key]);
      logger.info(`KIS 토큰 DB 캐시 삭제: ${key}`, { component: 'KIS_AUTH' });
    } catch (err) {
      logger.warn(`KIS 토큰 DB 삭제 실패 (무시): ${err}`, { component: 'KIS_AUTH' });
    }
  })();
}
