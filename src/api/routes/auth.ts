/**
 * 인증 라우트
 * POST /auth/login   — 패스워드 검증 → 세션 쿠키 발급
 * POST /auth/logout  — 세션 쿠키 삭제
 * GET  /auth/me      — 현재 로그인 상태 확인
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { sleep } from '../../utils/sleep.js';
import {
  clearSessionCookie,
  createSessionToken,
  extractSessionNonce,
  isMobilePhone,
  registerMobileSession,
  setSessionCookie,
  verifySessionToken,
} from '../middleware/auth.js';

export const authRoutes = new Hono();

// ── In-memory rate limiter: IP-based, max 5 login attempts per 60 seconds ──
const _loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 60_000;

// Periodic cleanup to prevent unbounded growth (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _loginAttempts) {
    if (now >= entry.resetAt) _loginAttempts.delete(ip);
  }
}, 5 * 60_000).unref();

authRoutes.post('/auth/login', async (c) => {
  // Rate limiting: max 5 attempts per minute per IP
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown';
  const now = Date.now();
  const attempt = _loginAttempts.get(clientIp);
  if (attempt && now < attempt.resetAt) {
    if (attempt.count >= LOGIN_RATE_LIMIT) {
      const retryAfterSec = Math.ceil((attempt.resetAt - now) / 1000);
      return c.json({ error: `로그인 시도 횟수 초과. ${retryAfterSec}초 후 재시도하세요.` }, 429);
    }
    attempt.count++;
  } else {
    _loginAttempts.set(clientIp, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
  }

  const secret = process.env.DASHBOARD_PASSWORD ?? '';
  if (!secret) {
    return c.json({ error: '서버 패스워드 미설정' }, 503);
  }

  let body: { password?: string };
  try {
    body = await c.req.json<{ password?: string }>();
  } catch {
    return c.json({ error: '요청 형식 오류' }, 400);
  }

  const input = body?.password ?? '';
  if (!input) {
    return c.json({ error: '패스워드를 입력하세요' }, 400);
  }

  // 타이밍 공격 방지: 항상 256바이트 고정 길이 비교 (길이 정보 노출 차단)
  const FIXED_LEN = 256;
  const inputBuf = Buffer.alloc(FIXED_LEN);
  const secretBuf = Buffer.alloc(FIXED_LEN);
  Buffer.from(input).copy(inputBuf, 0, 0, Math.min(input.length, FIXED_LEN));
  Buffer.from(secret).copy(secretBuf, 0, 0, Math.min(secret.length, FIXED_LEN));
  // 길이가 다를 때 항상 false — 단 비교 시간은 동일하게 유지
  const lenMatch = input.length === secret.length;
  const bufMatch = timingSafeEqual(inputBuf, secretBuf);
  const match = lenMatch && bufMatch;

  if (!match) {
    // 브루트포스 방지: 500ms 지연
    await sleep(500);
    return c.json({ error: '패스워드가 틀렸습니다' }, 401);
  }

  const token = createSessionToken();
  setSessionCookie(c, token);

  // 모바일폰에서 패스워드 로그인: 이전 폰 세션 무효화
  const ua = c.req.header('user-agent') ?? '';
  if (isMobilePhone(ua)) {
    const nonce = extractSessionNonce(token);
    if (nonce) registerMobileSession(nonce);
  }

  return c.json({ ok: true });
});

authRoutes.post('/auth/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', (c) => {
  const token = getCookie(c, 'qops_session');
  const loggedIn = !!(token && verifySessionToken(token));
  // 🔒 비밀번호 설정 여부를 절대 노출하지 않음 (noPassword 필드 제거)
  return c.json({ loggedIn });
});
