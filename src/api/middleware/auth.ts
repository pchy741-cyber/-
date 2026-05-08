/**
 * 대시보드 인증 미들웨어
 * - HMAC-SHA256 서명된 세션 쿠키 (httpOnly, Secure, SameSite=Strict)
 * - 타이밍 공격 방지: timingSafeEqual 사용
 * - DASHBOARD_PASSWORD 미설정 시 개발 환경에서만 무조건 통과
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const SESSION_COOKIE = 'qops_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7일

function getSecret(): string {
  return process.env.DASHBOARD_PASSWORD ?? '';
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function createSessionToken(): string {
  const secret = getSecret();
  const payload = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
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
    return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
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
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const secret = getSecret();

  // 패스워드 미설정 시: 개발/로컬 환경 무조건 통과, 프로덕션 차단
  if (!secret) {
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    return c.json({ error: '서버 패스워드 미설정 — 관리자에게 문의' }, 503);
  }

  // X-Api-Key 헤더 지원 (Claude Code /loop 등 서버 간 호출용)
  const apiKey = c.req.header('x-api-key');
  if (apiKey && apiKey === secret) {
    return next();
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (token && verifySessionToken(token)) {
    return next();
  }

  // XHR/fetch 요청이면 401 JSON, 브라우저 직접 접근이면 로그인 페이지로
  const accept = c.req.header('accept') ?? '';
  const isApiCall = accept.includes('application/json') || c.req.header('x-requested-with');
  if (isApiCall) {
    return c.json({ error: '로그인이 필요합니다', redirect: '/login' }, 401);
  }
  return c.redirect('/login', 302);
}
