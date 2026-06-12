/**
 * 대시보드 인증 미들웨어
 * - HMAC-SHA256 서명된 세션 쿠키 (httpOnly, Secure, SameSite=Strict)
 * - 타이밍 공격 방지: timingSafeEqual 사용
 * - DASHBOARD_PASSWORD 미설정 시 개발 환경에서만 무조건 통과
 * - 모바일폰 단일 세션: 새 로그인 시 이전 폰 세션 자동 무효화
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const SESSION_COOKIE = 'qops_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7일

// 모바일폰 단일 세션 레지스트리 (현재 유효한 phone 세션 nonce)
let _mobileNonce: string | null = null;

export function isMobilePhone(ua: string): boolean {
  return /iPhone|Android.*Mobile|Windows Phone/i.test(ua) && !/iPad/i.test(ua);
}

/** 모바일 로그인 시 새 nonce 등록 — 이전 폰 세션 자동 무효화 */
export function registerMobileSession(nonce: string): void {
  _mobileNonce = nonce;
}

/** 토큰에서 nonce(두 번째 페이로드 필드) 추출 */
export function extractSessionNonce(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const lastDot = decoded.lastIndexOf('.');
    if (lastDot < 0) return null;
    const payload = decoded.slice(0, lastDot);
    return payload.split('.')[1] ?? null;
  } catch {
    return null;
  }
}

function getSecret(): string {
  return process.env.DASHBOARD_PASSWORD ?? '';
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** nonce 지정 시 재사용 (세션 롤링용), 미지정 시 신규 생성 */
export function createSessionToken(nonce?: string): string {
  const secret = getSecret();
  const sessionNonce = nonce ?? Math.random().toString(36).slice(2);
  const payload = `${Date.now()}.${sessionNonce}`;
  const sig = signPayload(payload, secret);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export function verifySessionToken(token: string): boolean {
  const secret = getSecret();
  if (!secret) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const lastDot = decoded.lastIndexOf('.');
    if (lastDot < 0) return false;
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    const expected = signPayload(payload, secret);
    // 길이 다르면 바로 false (timingSafeEqual은 같은 길이 필요)
    if (sig.length !== expected.length) return false;
    if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) return false;

    // 토큰 만료 확인 — payload 형식: "timestamp.random"
    const tsStr = payload.split('.')[0];
    const issuedAt = Number(tsStr);
    if (!Number.isNaN(issuedAt) && Date.now() - issuedAt > SESSION_MAX_AGE * 1000) return false;

    return true;
  } catch {
    return false;
  }
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/**
 * 인증 미들웨어 — /api/* 전체에 적용
 * 예외: /api/health, /api/auth/login (패스워드 불필요)
 */
export async function requireAuth(c: Context, next: Next): Promise<Response | undefined> {
  const secret = getSecret();

  // 패스워드 미설정 시: 모든 환경에서 차단 (보안)
  if (!secret) {
    return c.json({ error: '서버 패스워드 미설정 — 관리자에게 문의' }, 503);
  }

  // X-Api-Key 헤더 지원 (Claude Code /loop 등 서버 간 호출용) — timing-safe 비교
  const apiKey = c.req.header('x-api-key');
  if (apiKey && apiKey.length === secret.length && timingSafeEqual(Buffer.from(apiKey), Buffer.from(secret))) {
    await next();
    return;
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (token && verifySessionToken(token)) {
    const ua = c.req.header('user-agent') ?? '';
    const nonce = extractSessionNonce(token);

    // 모바일폰 단일 세션 검증: 다른 곳에서 로그인하면 이전 세션 무효화
    if (isMobilePhone(ua) && nonce && _mobileNonce !== null && _mobileNonce !== nonce) {
      clearSessionCookie(c);
      return c.json({ error: '다른 기기에서 로그인됨', redirect: '/login' }, 401);
    }

    // 세션 갱신: 동일 nonce로 만료 시간 연장 (태블릿 장기 운영 지원)
    const newToken = createSessionToken(nonce ?? undefined);
    setSessionCookie(c, newToken);
    await next();
    return;
  }

  // XHR/fetch 요청이면 401 JSON, 브라우저 직접 접근이면 로그인 페이지로
  const accept = c.req.header('accept') ?? '';
  const isApiCall = accept.includes('application/json') || c.req.header('x-requested-with');
  if (isApiCall) {
    return c.json({ error: '로그인이 필요합니다', redirect: '/login' }, 401);
  }
  return c.redirect('/login', 302);
}
