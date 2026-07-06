/**
 * 해외 Paper 자동 리필 — state.ts에서 분리
 */
import { fetchExchangeRate } from '../../automation/macro-data.js';
import { FALLBACK_FX_RATE } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import { isKillSwitchActive } from '../../risk/kill-switch.js';
import { computePaperCash, getEffectivePaperSeedKrw } from '../../shared/overseas/paper-cash.js';
import { logger } from '../../utils/logger.js';
import { getHoldings } from './state-holdings.js';

// ── Paper 해외 자금 자동 리필 (자율학습 모드) ──────────────────────────
const OVERSEAS_REFILL_THRESHOLD = 0.15; // 시드 대비 15% 미만이면 리필
let lastOverseasRefillCheck = 0;

/**
 * Paper 해외 자금 고갈 시 자동 리필 (통합증거금 기준)
 * - 포트폴리오 가치(현금+보유) < 시드 15% → 리필 트리거
 * - 기존 overseas paper 주문을 아카이브
 * @param force 강제 리필 (수동 트리거 시)
 * @returns true if refill happened
 */
export async function checkAndRefillOverseasPaper(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - lastOverseasRefillCheck < 5 * 60 * 1000) return false;
  lastOverseasRefillCheck = now;

  try {
    const fxRate = await fetchExchangeRate();
    const seedKrw = await getEffectivePaperSeedKrw();
    const seedUsd = seedKrw / (fxRate > 0 ? fxRate : FALLBACK_FX_RATE);
    const cash = await computePaperCash(fxRate);
    const holdings = await getHoldings(true);

    // 포트폴리오 총 가치 계산 (현금 + 보유종목 시가)
    let holdingsValue = 0;
    for (const h of holdings.values()) {
      holdingsValue += h.qty * h.avgPrice; // avgPrice 폴백 (시가 미확보 시)
    }
    const totalValue = cash + holdingsValue;
    const totalRatio = seedUsd > 0 ? totalValue / seedUsd : 0;

    if (!force && totalRatio >= OVERSEAS_REFILL_THRESHOLD) return false;

    // 🛡️ Kill Switch 활성 시 리필 차단 — API 장애로 인한 가짜 포트폴리오 하락 → 리필 → 데이터 영구손실 방지
    if (!force && isKillSwitchActive('OVERSEAS', true)) {
      logger.warn('🛑 Kill Switch 활성 중 → Paper 리필 차단 (API 장애 의심)', { component: 'OVERSEAS' });
      return false;
    }

    // v10.8.4 안전장치: 최근 1시간 내 매매가 있었으면 리필 차단 (현금 계산 일시 오류 방지)
    const { rows: recentTrades } = await getPool().query(
      `SELECT COUNT(*) AS cnt FROM orders
       WHERE trading_mode = 'paper' AND is_paper = true AND trigger_source = 'OVERSEAS' AND status = 'FILLED'
       AND created_at > NOW() - INTERVAL '1 hour'`,
    );
    if (Number(recentTrades[0]?.cnt ?? 0) > 0) {
      logger.info('🔒 Paper 리필 차단: 최근 1시간 내 매매 존재 → 현금 재계산 대기', { component: 'OVERSEAS' });
      return false;
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
    await client.query('BEGIN');

    // 세대 번호
    const { rows: genRows } = await client.query(
      `SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(value, '[^0-9]', '', 'g'), '') AS int)), 0) + 1 as next_gen
       FROM overseas_state WHERE key LIKE 'paper_us_gen_%'`,
    );
    const gen = genRows[0]?.next_gen ?? 1;

    // 기존 overseas paper 주문 아카이브 (varchar(10) 제한 → 'p_arch' 사용)
    const { rowCount } = await client.query(
      `UPDATE orders SET trading_mode = 'p_arch'
       WHERE trading_mode = 'paper' AND trigger_source = 'OVERSEAS' AND status = 'FILLED'`,
    );

    // overseas_holdings paper 삭제
    await client.query(`DELETE FROM overseas_holdings WHERE is_paper = true`);

    // cash_paper 리셋 (환율 기준 USD)
    await client.query(
      `INSERT INTO overseas_state (key, value) VALUES ('cash_paper', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [seedUsd.toFixed(2)],
    );

    // 세대 기록
    await client.query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [
        `paper_us_gen_${gen}`,
        JSON.stringify({
          archivedAt: new Date().toISOString(),
          ordersArchived: rowCount,
          finalCashUsd: cash,
          seedKrw,
          fxRate,
          seedUsd,
        }),
      ],
    );

    await client.query('COMMIT');

    logger.info(
      `🔄 [PAPER-REFILL] 통합증거금 리필 (세대 #${gen}): $${cash.toFixed(0)} → $${seedUsd.toFixed(0)} (₩${(seedKrw / 10000).toFixed(0)}만 / 환율 ${fxRate.toFixed(0)}) — ${rowCount}건 아카이브`,
      { component: 'OVERSEAS' },
    );
    return true;
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (e) {
    logger.warn(`해외 Paper 리필 체크 실패: ${e}`, { component: 'OVERSEAS' });
    return false;
  }
}
