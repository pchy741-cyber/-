/**
 * 인증 라우트
 * POST /auth/login   — 패스워드 검증 → 세션 쿠키 발급
 * POST /auth/logout  — 세션 쿠키 삭제
 * GET  /auth/me      — 현재 로그인 상태 확인
 */
import { timingSafeEqual } from 'crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { clearSessionCookie, createSessionToken, setSessionCookie, verifySessionToken } from '../middleware/auth.js';

export const authRoutes = new Hono();

authRoutes.post('/auth/login', async (c) => {
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

  // 타이밍 공격 방지: 항상 동일 시간 비교
  const inputBuf = Buffer.from(input.padEnd(secret.length, '\0').slice(0, Math.max(input.length, secret.length)));
  const secretBuf = Buffer.from(secret.padEnd(input.length, '\0').slice(0, Math.max(input.length, secret.length)));
  const match = input.length === secret.length && timingSafeEqual(inputBuf, secretBuf);

  if (!match) {
    // 브루트포스 방지: 500ms 지연
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: '패스워드가 틀렸습니다' }, 401);
  }

  const token = createSessionToken();
  setSessionCookie(c, token);
  return c.json({ ok: true });
});

authRoutes.post('/auth/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', (c) => {
  const secret = process.env.DASHBOARD_PASSWORD ?? '';
  if (!secret) return c.json({ loggedIn: true, noPassword: true });
  const token = getCookie(c, 'qops_session');
  const loggedIn = !!(token && verifySessionToken(token));
  return c.json({ loggedIn });
});
