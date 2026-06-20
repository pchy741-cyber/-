/**
 * 실전모드 보호 + 모드 해석 유틸리티
 *
 * v4: LIVE_ENABLED=false (기본값) → 실전 거래 완전 차단
 *     사용자가 "실전 해보자" 할 때까지 paper 전용
 *     설정에서 LIVE_ENABLED=true로 전환 시 PIN 검증 후 실전 가능
 */
import { timingSafeEqual } from 'node:crypto';
import { baseIsPaper } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const LIVE_PIN = process.env.LIVE_PIN;
if (!LIVE_PIN) {
  logger.warn('LIVE_PIN 환경변수 미설정 — 실전모드 PIN 검증 불가 (설정 필수)', { component: 'GUARD' });
}

/** v4: 실전 거래 마스터 스위치 — false면 모든 live 요청 차단 */
let _liveEnabled = (process.env.LIVE_ENABLED ?? 'false') === 'true';
export function isLiveEnabled(): boolean {
  return _liveEnabled;
}
export function setLiveEnabled(enabled: boolean): void {
  _liveEnabled = enabled;
}

export interface PinValidation {
  ok: boolean;
  error?: string;
}

/**
 * live 모드일 때 검증. paper 모드는 항상 통과.
 * v4: LIVE_ENABLED=false → live 거래 자체가 불가
 */
export function validateLivePin(isPaper: boolean, pin?: string): PinValidation {
  if (isPaper) return { ok: true };
  // v4: 실전 마스터 스위치 OFF → 무조건 차단
  if (!_liveEnabled) return { ok: false, error: '실전모드 비활성화 상태입니다. 설정에서 Live를 켜주세요.' };
  if (!pin) return { ok: false, error: '실전모드: PIN 4자리를 입력하세요' };
  if (!LIVE_PIN) return { ok: false, error: '실전모드: 서버 LIVE_PIN 환경변수 미설정' };
  const pinBuf = Buffer.from(pin.padEnd(16, '\0'));
  const expectedBuf = Buffer.from(LIVE_PIN.padEnd(16, '\0'));
  if (!timingSafeEqual(pinBuf, expectedBuf)) return { ok: false, error: '실전모드: PIN이 틀렸습니다' };
  return { ok: true };
}

/** mode 또는 viewMode에서 isPaper 해석 — 'paper' → true, 'live' → false, 미지정 → 서버 기본값 */
export function resolveIsPaper(mode?: string | null): boolean {
  if (mode === 'paper') return true;
  if (mode === 'live') return false;
  return baseIsPaper;
}

/**
 * Hono request에서 viewMode/mode 통합 파싱
 * 우선순위: viewMode > mode > 서버 기본값
 * 프론트엔드가 어떤 파라미터명을 보내든 동작하도록 양쪽 모두 확인
 */
export function resolveRequestMode(c: { req: { query: (k: string) => string | undefined } }): boolean {
  const vm = c.req.query('viewMode') ?? c.req.query('mode');
  return resolveIsPaper(vm);
}

