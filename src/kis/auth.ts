import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface KISToken {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
}

let cachedToken: KISToken | null = null;
let cachedTokenIsPaper: boolean | null = null;

/**
 * KIS OAuth2 토큰 발급/캐싱
 * - 토큰 유효기간: ~24시간
 * - 만료 30분 전 자동 갱신
 * - 모드(paper/live) 전환 시 자동 재발급
 */
export async function getAccessToken(): Promise<string> {
  const isPaper = config.isPaper;
  if (cachedToken && !isExpired(cachedToken) && cachedTokenIsPaper === isPaper) {
    return cachedToken.accessToken;
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`KIS 토큰 발급 실패 (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string; token_type: string; access_token_token_expired: string };

  cachedToken = {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresAt: new Date(data.access_token_token_expired),
  };
  cachedTokenIsPaper = isPaper;

  logger.info(`KIS 토큰 발급 완료, 만료: ${cachedToken.expiresAt.toISOString()}`, {
    component: 'KIS_AUTH',
  });

  return cachedToken.accessToken;
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
}
