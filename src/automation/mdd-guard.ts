/**
 * 💀 MDD 자동 가드 — 월간 MDD 임계 초과 시 신규 매수 자동 차단/해제
 *
 * 동작:
 *  - 매시간 portfolio_snapshots에서 월간 MDD 계산
 *  - Live: 8% 초과 시 ai_overrides에 minBuyScore=99 (TTL 6h) 자동 삽입 → 신규매수 차단
 *  - Paper: 40% 초과 시 동일 차단 (Paper는 모험 허용이지만 극단은 차단)
 *  - MDD가 임계의 75% 미만으로 회복 시 → 차단 해제
 *  - 차단/해제 시 Telegram 알림 + capture-trigger 호출
 *
 * 캡쳐 강화 #1의 ACTIONS 추천을 시스템이 자동으로 실행하는 모듈
 */

import { getOverride, removeOverride, setOverride } from '../ai/ai-overrides.js';
import { runWithMode } from '../config/context.js';
import { MDD_LIMIT } from '../config/constants.js';
import { config } from '../config/index.js';
import { getPool } from '../db/client.js';
import { sendByPaperFlag } from '../notifications/mode-message.js';
import { getMonthlyMddSnapshot } from '../risk/mdd-calculator.js';
import { logger } from '../utils/logger.js';

const COMP = 'MDD_GUARD';
// CEO 지시 (2026-06-12): "MDD 가드 DEADLOCK 해제 — 회복 조건 완화"
//   이전: 6h TTL + MDD < 75% (Live 6%) 회복 → 매매 0이면 영원히 차단됨
//   변경: 1h TTL + MDD < 150% (Live 12%) 회복 → 아주 조금만 회복돼도 재개
const BLOCK_TTL_MINUTES = 60; // 6h → 1h 단축 (다음 시간 재평가)
const GUARD_REASON_PREFIX = 'mdd_guard:';

async function runForMode(isPaper: boolean): Promise<void> {
  const mode = isPaper ? 'paper' : 'live';

  // 연습모드: MDD 가드 완전 비활성 — 킬스위치(80% 일일손실)만 유일한 안전장치
  // 백테스팅 데이터 최대 수집 목적, 모든 제한 제거
  if (isPaper) {
    // 기존 가드가 남아 있으면 해제
    const { rows: metaRows2 } = await getPool()
      .query(
        `SELECT reason FROM ai_overrides
         WHERE key = $1 AND is_paper = $2 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY id DESC LIMIT 1`,
        ['minBuyScore', true],
      )
      .catch(() => ({ rows: [] as Array<{ reason: string }> }));
    if ((metaRows2[0]?.reason ?? '').startsWith(GUARD_REASON_PREFIX)) {
      const { removeOverride: rmOvr } = await import('../ai/ai-overrides.js');
      await rmOvr('minBuyScore', true);
      logger.info('🔓 MDD 가드 [paper] 잔존 오버라이드 해제 — 연습모드 제한 제거', { component: COMP });
    }
    return;
  }

  // Paper MDD 임계: config.paperRisk.mddLimit과 통일 / Live: constants.ts SSoT
  const limit = isPaper ? config.paperRisk.mddLimit : MDD_LIMIT.LIVE;
  // 회복 임계 완화 (DEADLOCK 방지): 75% → 150% 즉 limit의 1.5배
  // Live: MDD < 12% 면 해제 (이전 6%), Paper: MDD < 60% 면 해제 (이전 30%)
  // 의미: "악화하지만 않으면 매매 재개" — 매매가 일어나야 회복도 가능
  const recoverAt = limit * 1.5;

  let mdd = 0;
  try {
    const snap = await getMonthlyMddSnapshot(isPaper);
    mdd = snap.mddPct;
  } catch (e) {
    logger.warn(`MDD 계산 실패 [${mode}]: ${(e as Error).message}`, { component: COMP });
    return;
  }

  // 현재 가드 상태 (ai_overrides에 mdd_guard 표식 있는지)
  // 가드 강도 80~90 (이전 95 단일) → 임계값 80+ 면 가드 active로 판정
  const currentOverride = getOverride<number>('minBuyScore', isPaper);
  const isGuardActive = currentOverride !== undefined && currentOverride !== null && currentOverride >= 80;
  // 가드 메타 확인 (reason으로 식별)
  const { rows: metaRows } = await getPool()
    .query(
      `SELECT reason FROM ai_overrides
       WHERE key = $1 AND is_paper = $2 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 1`,
      ['minBuyScore', isPaper],
    )
    .catch(() => ({ rows: [] as Array<{ reason: string }> }));
  const isOurGuard = (metaRows[0]?.reason ?? '').startsWith(GUARD_REASON_PREFIX);

  // ── 차단 발동 ──
  if (mdd >= limit && !isGuardActive) {
    // 가드 강도 결정 — MDD 초과 정도에 따라 차등
    //   limit~limit×1.5: 80 (고확신만 허용, 매매 가능)
    //   limit×1.5 이상:   90 (엘리트만)
    //   이전: 무조건 95 (완전 차단) → DEADLOCK
    const guardScore = mdd >= limit * 1.5 ? 90 : 80;
    await setOverride(
      'threshold',
      'minBuyScore',
      guardScore,
      `${GUARD_REASON_PREFIX}MDD ${mdd.toFixed(1)}% >= 임계 ${limit}%`,
      BLOCK_TTL_MINUTES,
      isPaper,
    );
    logger.warn(
      `🚫 MDD 가드 발동 [${mode}]: MDD ${mdd.toFixed(1)}% >= ${limit}% — minBuyScore=${guardScore} (TTL ${BLOCK_TTL_MINUTES / 60}h)`,
      { component: COMP },
    );
    sendByPaperFlag(
      isPaper,
      `🚫 *MDD 가드 자동 발동*\nMDD ${mdd.toFixed(1)}% (임계 ${limit}%)\n신규 매수 ${BLOCK_TTL_MINUTES / 60}h 자동 차단\n회복 임계 ${recoverAt.toFixed(1)}% 미만이면 자동 해제`,
    ).catch(() => {});
    // 캡쳐 트리거
    import('../shared/capture-trigger.js')
      .then((m) => m.triggerCapture('mdd_danger', mode as 'paper' | 'live').catch(() => {}))
      .catch(() => {});
    return;
  }

  // ── 차단 해제 ──
  if (isGuardActive && isOurGuard && mdd < recoverAt) {
    await removeOverride('minBuyScore', isPaper);
    logger.info(`🟢 MDD 가드 해제 [${mode}]: MDD ${mdd.toFixed(1)}% < 회복 임계 ${recoverAt.toFixed(1)}% — 매수 재개`, {
      component: COMP,
    });
    sendByPaperFlag(
      isPaper,
      `🟢 *MDD 가드 자동 해제*\nMDD ${mdd.toFixed(1)}% < 회복 임계 ${recoverAt.toFixed(1)}%\n신규 매수 재개`,
    ).catch(() => {});
    return;
  }

  // 정상 상태 로그 (debug)
  logger.debug(`MDD 가드 [${mode}]: MDD ${mdd.toFixed(1)}% / 임계 ${limit}% / 회복 ${recoverAt.toFixed(1)}%`, {
    component: COMP,
  });
}

/** paper + live 모두 체크 (시간별 cron에서 호출) */
export async function runMddGuard(): Promise<void> {
  await Promise.all([
    runWithMode(false, () => runForMode(false)).catch((e) =>
      logger.error(`MDD 가드 live 실패: ${e}`, { component: COMP }),
    ),
    runWithMode(true, () => runForMode(true)).catch((e) =>
      logger.error(`MDD 가드 paper 실패: ${e}`, { component: COMP }),
    ),
  ]);
}
