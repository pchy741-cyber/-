import { Hono } from 'hono';
import { getEffectiveTradingMode, setTradingModeOverride } from '../../../config/index.js';
import { getPool } from '../../../db/client.js';
import { logger } from '../../../utils/logger.js';
import { resolveRequestMode } from '../../guards/live-pin.js';

export const tradingModeRoutes = new Hono();

// ── 거래 모드 전환 (모의/실전) ──
tradingModeRoutes.get('/trading-mode', async (c) => {
  try {
    const { isLiveEnabled } = await import('../../guards/live-pin.js');
    const { rows } = await getPool().query(
      'SELECT trading_mode_override FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1',
    );
    const dbMode = rows[0]?.trading_mode_override ?? null;
    return c.json({ mode: dbMode ?? getEffectiveTradingMode(), dbOverride: dbMode, liveEnabled: isLiveEnabled() });
  } catch {
    const { isLiveEnabled } = await import('../../guards/live-pin.js');
    return c.json({ mode: getEffectiveTradingMode(), dbOverride: null, liveEnabled: isLiveEnabled() });
  }
});

// v4: Live 거래 마스터 스위치 ON/OFF
tradingModeRoutes.post('/live-toggle', async (c) => {
  const body = await c.req.json<{ enabled: boolean; pin?: string }>();
  const { setLiveEnabled, isLiveEnabled } = await import('../../guards/live-pin.js');

  if (body.enabled) {
    // Live 켜기 → PIN 필수
    const { validateLivePin } = await import('../../guards/live-pin.js');
    const pinCheck = validateLivePin(false, body.pin);
    if (!pinCheck.ok) {
      return c.json({ error: pinCheck.error ?? '실전모드 활성화: PIN이 틀렸습니다' }, 403);
    }
    setLiveEnabled(true);
    logger.info('🔴 Live 거래 활성화 (CEO 승인)', { component: 'SETTINGS' });
  } else {
    setLiveEnabled(false);
    logger.info('🟢 Live 거래 비활성화 → Paper 전용', { component: 'SETTINGS' });
  }

  return c.json({ liveEnabled: isLiveEnabled() });
});

tradingModeRoutes.post('/trading-mode', async (c) => {
  const body = await c.req.json();
  const mode: 'paper' | 'live' = body.mode === 'live' ? 'live' : 'paper';

  // 안전 가드: 해외 Job 실행 중 모드 전환 차단 (paper/live 데이터 혼재 방지)
  try {
    const { isOverseasJobRunning } = await import('../../../scheduler/overseas-job.js');
    if (isOverseasJobRunning()) {
      return c.json({ error: '해외 Job 실행 중 — 1분 후 다시 시도하세요' }, 409);
    }
  } catch {}

  // 안전 가드: PENDING 주문 존재 시 모드 전환 차단 (체결 대기 중 모드 변경 → 데이터 불일치)
  try {
    const currentMode = getEffectiveTradingMode();
    const isPaperMode = currentMode === 'paper';
    const { rows: pendingRows } = await getPool().query(
      `SELECT COUNT(*) as cnt FROM orders WHERE status = 'PENDING' AND is_paper = $1`,
      [isPaperMode],
    );
    const pendingCount = Number(pendingRows[0]?.cnt ?? 0);
    if (pendingCount > 0) {
      return c.json({ error: `미체결 주문 ${pendingCount}건 존재 — 체결/취소 후 모드 전환하세요` }, 409);
    }
  } catch (e) {
    logger.warn(`모드 전환 PENDING 체크 실패: ${e}`, { component: 'SETTINGS' });
  }

  setTradingModeOverride(mode);
  try {
    // UPDATE 시도 (live 행만 대상 — 행이 없으면 rowCount=0)
    const { rowCount } = await getPool().query(
      'UPDATE portfolio_allocation_config SET trading_mode_override=$1 WHERE is_paper = false',
      [mode],
    );
    if ((rowCount ?? 0) === 0) {
      // 행이 없으면 기본값으로 INSERT (live 행)
      await getPool().query(
        `INSERT INTO portfolio_allocation_config
           (kr_pct, us_pct, sector_semiconductor, sector_bio, sector_defense,
            sector_finance, sector_etc, trailing_stop_pct, trading_mode_override, is_paper)
         VALUES (70, 30, 30, 20, 25, 20, 30, 5, $1, false)`,
        [mode],
      );
    }
  } catch (e: any) {
    logger.warn(`거래 모드 DB 저장 실패: ${e.message}`, { component: 'SETTINGS' });
  }
  logger.info(`🔄 거래 모드 전환: ${mode.toUpperCase()} (CEO 대시보드)`, { component: 'SETTINGS' });
  const { invalidateModeCache, prewarmDashboard } = await import('../dashboard.js');
  invalidateModeCache(mode); // 새 모드 캐시만 무효화 (이전 모드 캐시 보존 → 되돌아갈 때 즉시 응답)
  prewarmDashboard().catch(() => {}); // 새 모드 캐시 background 선제 빌드
  return c.json({ ok: true, mode });
});
