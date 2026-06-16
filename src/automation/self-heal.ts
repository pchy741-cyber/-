import { checkDb } from '../db/client.js';
import { clearTokenCache, getAccessToken } from '../kis/auth.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { getKillSwitchStatus, isKillSwitchActive, type KillSwitchScope } from '../risk/kill-switch.js';
import { logger } from '../utils/logger.js';

/**
 * 장애 자동 복구 (Self-Healing)
 *
 * 10분마다 실행 → 시스템 상태 점검 → 문제 발견 시 자동 복구 시도
 *
 * 복구 대상:
 * 1. KIS 토큰 만료 → 자동 재발급
 * 2. Supabase 연결 끊김 → 재연결
 * 3. Kill Switch 장기 활성 → CEO 알림
 */

let _lastHealthCheck = new Date();
let consecutiveHealthFailures = 0;

export async function runSelfHealing(): Promise<void> {
  const issues: string[] = [];
  const fixed: string[] = [];

  // 1. KIS 토큰 상태 확인 + 재발급
  try {
    await getAccessToken();
  } catch {
    issues.push('KIS 토큰 만료/에러');
    try {
      clearTokenCache();
      await getAccessToken();
      fixed.push('KIS 토큰 재발급 성공');
    } catch (retryErr) {
      issues.push(`KIS 토큰 재발급 실패: ${retryErr}`);
    }
  }

  // 2. PostgreSQL 연결 확인
  try {
    const ok = await checkDb();
    if (!ok) throw new Error('DB health check failed');
  } catch {
    issues.push('PostgreSQL 연결 끊김');
    // pg Pool은 자동 재연결하므로 별도 조치 불필요
    // 다만 연속 실패 시 알림
    consecutiveHealthFailures++;
    if (consecutiveHealthFailures >= 3) {
      issues.push(`DB 연결 ${consecutiveHealthFailures}회 연속 실패`);
    }
  }

  // 3. Kill Switch 장기 활성 감지 (2시간 이상) — KR/OVERSEAS 양쪽 확인
  for (const scope of ['KR', 'OVERSEAS'] as KillSwitchScope[]) {
    if (isKillSwitchActive(scope)) {
      const status = getKillSwitchStatus(scope);
      if (status.activatedAt) {
        const activatedAt = new Date(status.activatedAt);
        const hoursActive = (Date.now() - activatedAt.getTime()) / (1000 * 60 * 60);
        const label = scope === 'OVERSEAS' ? '해외' : '국내';

        if (hoursActive >= 2) {
          issues.push(`Kill Switch [${label}] ${hoursActive.toFixed(1)}시간째 활성 중`);
        }
      }
    }
  }

  // 문제 없으면 카운터 리셋
  if (issues.length === 0) {
    consecutiveHealthFailures = 0;
    return;
  }

  // 문제 있으면 로그 + 알림
  const msg = [
    `🔧 *시스템 자가 진단*`,
    ``,
    `문제 발견: ${issues.length}건`,
    ...issues.map((i) => `  ❌ ${i}`),
    fixed.length > 0 ? `\n자동 복구: ${fixed.length}건` : '',
    ...fixed.map((f) => `  ✅ ${f}`),
  ]
    .filter(Boolean)
    .join('\n');

  logger.warn(`자가 진단: ${issues.length}건 문제, ${fixed.length}건 복구`, { component: 'HEAL' });

  // 연속 3회 이상 문제 시만 텔레그램 알림 (노이즈 방지)
  if (consecutiveHealthFailures >= 3 || fixed.length > 0) {
    await sendTelegramMessage(msg).catch(() => {});
  }

  _lastHealthCheck = new Date();
}
