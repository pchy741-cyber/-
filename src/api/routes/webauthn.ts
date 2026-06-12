/**
 * WebAuthn (FIDO2) 생체인증 라우트
 *
 * 등록: 로그인 상태에서 디바이스 등록 (지문/FaceID 등)
 * 인증: 로그인 화면에서 생체인증으로 세션 발급
 *
 * 엔드포인트 (공개):
 *   POST /auth/webauthn/authenticate/options  — 인증 챌린지 생성
 *   POST /auth/webauthn/authenticate/verify   — 인증 검증 → 세션 쿠키
 *   GET  /auth/webauthn/available             — 등록된 credential 존재 여부
 *
 * 엔드포인트 (인증 필요):
 *   POST /auth/webauthn/register/options      — 등록 챌린지 생성
 *   POST /auth/webauthn/register/verify       — 등록 검증 → credential 저장
 *   GET  /auth/webauthn/credentials           — 등록된 디바이스 목록
 *   DELETE /auth/webauthn/credentials/:id     — 디바이스 삭제
 */

import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { createSessionToken, setSessionCookie } from '../middleware/auth.js';

// RP (Relying Party) 설정 — 요청 Host 헤더에서 동적으로 유도 (staging/live URL 공용 대응)
const rpName = 'AI Auto Bot';
const FALLBACK_RP_ID = process.env.WEBAUTHN_RP_ID || 'ai-auto-bot-ang2aozjiq-du.a.run.app';

/** 요청 컨텍스트에서 RP ID 추출 (Host > X-Forwarded-Host > 환경변수 순) */
function getRpId(c: { req: { header: (name: string) => string | undefined } }): string {
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID;
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || FALLBACK_RP_ID;
  return host.split(':')[0].toLowerCase();
}

function getOrigin(rpId: string): string {
  return process.env.WEBAUTHN_ORIGIN || `https://${rpId}`;
}

// 챌린지 임시 저장 (인메모리, 5분 TTL) — 단일 인스턴스이므로 충분
const challenges = new Map<string, { challenge: string; expiresAt: number }>();
function storeChallenge(key: string, challenge: string): void {
  challenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60_000 });
}
function consumeChallenge(key: string): string | null {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.challenge;
}

// 주기적으로 만료된 챌린지 정리
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) {
    if (now > v.expiresAt) challenges.delete(k);
  }
}, 60_000);

// ── DB 헬퍼 ──

interface StoredCredential {
  id: string;
  public_key: Buffer;
  counter: number;
  device_name: string;
  transports: string[] | null;
}

async function getStoredCredentials(): Promise<StoredCredential[]> {
  const { rows } = await getPool().query(
    'SELECT id, public_key, counter, device_name, transports FROM webauthn_credentials ORDER BY created_at DESC',
  );
  return rows.map((r: any) => ({
    id: r.id,
    public_key: r.public_key,
    counter: Number(r.counter),
    device_name: r.device_name,
    transports: r.transports,
  }));
}

async function getCredentialById(credId: string): Promise<StoredCredential | null> {
  const { rows } = await getPool().query(
    'SELECT id, public_key, counter, device_name, transports FROM webauthn_credentials WHERE id = $1',
    [credId],
  );
  if (rows.length === 0) return null;
  const r = rows[0] as any;
  return {
    id: r.id,
    public_key: r.public_key,
    counter: Number(r.counter),
    device_name: r.device_name,
    transports: r.transports,
  };
}

// ── 라우트 ──

export const webauthnPublicRoutes = new Hono();
export const webauthnProtectedRoutes = new Hono();

// ── 공개: 등록된 credential 존재 여부 ──
webauthnPublicRoutes.get('/auth/webauthn/available', async (c) => {
  try {
    const { rows } = await getPool().query('SELECT COUNT(*) AS cnt FROM webauthn_credentials');
    return c.json({ available: Number(rows[0].cnt) > 0 });
  } catch {
    return c.json({ available: false });
  }
});

// ── 공개: 인증 옵션 생성 ──
webauthnPublicRoutes.post('/auth/webauthn/authenticate/options', async (c) => {
  try {
    const creds = await getStoredCredentials();
    if (creds.length === 0) {
      return c.json({ error: '등록된 생체인증이 없습니다. 먼저 비밀번호로 로그인 후 등록하세요.' }, 404);
    }

    const rpId = getRpId(c);
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: creds.map((cred) => ({
        id: cred.id,
        transports: (cred.transports ?? []) as AuthenticatorTransportFuture[],
      })),
      userVerification: 'preferred',
      timeout: 60_000,
    });

    storeChallenge('auth', options.challenge);
    return c.json(options);
  } catch (err: any) {
    logger.error(`WebAuthn 인증 옵션 생성 실패: ${err.message}`, { component: 'WEBAUTHN' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 공개: 인증 검증 → 세션 발급 ──
webauthnPublicRoutes.post('/auth/webauthn/authenticate/verify', async (c) => {
  try {
    const body = await c.req.json();
    const expectedChallenge = consumeChallenge('auth');
    if (!expectedChallenge) {
      return c.json({ error: '챌린지 만료 — 다시 시도하세요' }, 400);
    }

    const credId = body.id;
    const cred = await getCredentialById(credId);
    if (!cred) {
      return c.json({ error: '등록되지 않은 디바이스입니다' }, 401);
    }

    const rpId = getRpId(c);
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: getOrigin(rpId),
      expectedRPID: rpId,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.public_key),
        counter: cred.counter,
        transports: (cred.transports ?? []) as AuthenticatorTransportFuture[],
      },
    });

    if (!verification.verified) {
      return c.json({ error: '생체인증 검증 실패' }, 401);
    }

    // counter 업데이트 (replay 방지)
    await getPool().query('UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2', [
      verification.authenticationInfo.newCounter,
      credId,
    ]);

    // 세션 쿠키 발급
    const token = createSessionToken();
    setSessionCookie(c, token);
    logger.info(`🔐 WebAuthn 생체인증 로그인 성공 (${cred.device_name})`, { component: 'WEBAUTHN' });
    return c.json({ ok: true, verified: true });
  } catch (err: any) {
    logger.error(`WebAuthn 인증 검증 실패: ${err.message}`, { component: 'WEBAUTHN' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 인증 필요: 등록 옵션 생성 ──
webauthnProtectedRoutes.post('/auth/webauthn/register/options', async (c) => {
  try {
    const existingCreds = await getStoredCredentials();

    const rpId = getRpId(c);
    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: 'ceo',
      userDisplayName: 'CEO',
      attestationType: 'none', // attestation 불필요 (단일 사용자)
      excludeCredentials: existingCreds.map((cred) => ({
        id: cred.id,
        transports: (cred.transports ?? []) as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform', // 내장 생체인증만 (외부 USB 키 제외)
      },
      timeout: 60_000,
    });

    storeChallenge('register', options.challenge);
    return c.json(options);
  } catch (err: any) {
    logger.error(`WebAuthn 등록 옵션 생성 실패: ${err.message}`, { component: 'WEBAUTHN' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 인증 필요: 등록 검증 → credential 저장 ──
webauthnProtectedRoutes.post('/auth/webauthn/register/verify', async (c) => {
  try {
    const body = await c.req.json();
    const deviceName = body.deviceName || '디바이스';
    const expectedChallenge = consumeChallenge('register');
    if (!expectedChallenge) {
      return c.json({ error: '챌린지 만료 — 다시 시도하세요' }, 400);
    }

    const rpId = getRpId(c);
    const verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge,
      expectedOrigin: getOrigin(rpId),
      expectedRPID: rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: '등록 검증 실패' }, 400);
    }

    const { credential } = verification.registrationInfo;

    await getPool().query(
      `INSERT INTO webauthn_credentials (id, public_key, counter, device_name, transports)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET public_key = $2, counter = $3, device_name = $4`,
      [credential.id, Buffer.from(credential.publicKey), credential.counter, deviceName, credential.transports ?? []],
    );

    logger.info(`🔐 WebAuthn 디바이스 등록 완료: ${deviceName}`, { component: 'WEBAUTHN' });
    return c.json({ ok: true, verified: true, deviceName });
  } catch (err: any) {
    logger.error(`WebAuthn 등록 검증 실패: ${err.message}`, { component: 'WEBAUTHN' });
    return c.json({ error: err.message }, 500);
  }
});

// ── 인증 필요: 등록된 디바이스 목록 ──
webauthnProtectedRoutes.get('/auth/webauthn/credentials', async (c) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, device_name, transports, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at DESC',
    );
    return c.json({ credentials: rows });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── 인증 필요: 디바이스 삭제 ──
webauthnProtectedRoutes.delete('/auth/webauthn/credentials/:id', async (c) => {
  try {
    const credId = c.req.param('id');
    await getPool().query('DELETE FROM webauthn_credentials WHERE id = $1', [credId]);
    logger.info(`🗑️ WebAuthn 디바이스 삭제: ${credId}`, { component: 'WEBAUTHN' });
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
