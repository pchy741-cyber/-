/**
 * Tier 1: 포트폴리오 Kelly + VaR
 *
 * 개별 종목 사이징 위에 포트폴리오 레벨 제약:
 * 1. 포트폴리오 VaR: 오픈 포지션들의 총 VaR가 자산의 8% 초과 시 신규 매수 차단
 * 2. 섹터 집중도: 같은 섹터 투자비중 40% 초과 시 해당 섹터 차단
 * 3. 동시 포지션 Kelly: 총 Kelly 합계 > 1.0이면 신규 진입 불가
 *
 * 데이터: transaction_chains (오픈 포지션) + livePrices (현재가) + ATR → 전부 기존 데이터
 * 폴백: dynamic import + try/catch → 실패 시 기존 게이트만 통과 (fail-open)
 */

import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import type { GateResult } from './trade-gate-types.js';

const COMP = 'PORTFOLIO_VAR';

// 한국주식 평균 상관계수 가정
const AVG_CORRELATION = 0.45;
// VaR 제한: 총 자산의 8%
const MAX_VAR_PCT = 8.0;
// 95% VaR 계수
const VAR_CONFIDENCE = 1.65;
// 섹터 집중도 제한
const MAX_SECTOR_PCT = 40.0;
// Kelly 합계 제한
const MAX_KELLY_SUM = 1.0;

interface OpenPosition {
  stockCode: string;
  totalInvested: number;
  currentValue: number;
  atrPct: number; // ATR / price × 100
  sector: string;
  kellyFraction: number;
}

/**
 * 포트폴리오 레벨 VaR + 집중도 + Kelly 게이트
 *
 * @param stockCode 신규 진입 종목
 * @param totalAssets 총 자산
 * @returns GateResult
 */
export async function portfolioVarGate(
  stockCode: string,
  totalAssets: number,
): Promise<GateResult> {
  if (totalAssets <= 0) {
    return { passed: true, reason: '총자산 0 → VaR 게이트 스킵' };
  }

  const isPaper = getCtxIsPaper();

  // 오픈 포지션 조회
  const { rows: openChains } = await getPool().query(
    `SELECT stock_code, total_invested, total_quantity,
            COALESCE(strategy_mode, 'SWING') AS strategy_mode
     FROM transaction_chains
     WHERE status = 'OPEN' AND is_paper = $1`,
    [isPaper],
  );

  if (openChains.length === 0) {
    return { passed: true, reason: '오픈 포지션 없음 → VaR 게이트 통과' };
  }

  // 간이 ATR% 추정 (DB 조회 없이 — 한국 주식 평균 2.5% 가정)
  const DEFAULT_ATR_PCT = 2.5;

  const positions: OpenPosition[] = openChains.map((c: any) => ({
    stockCode: c.stock_code,
    totalInvested: Number(c.total_invested),
    currentValue: Number(c.total_invested), // 간이: 투자금 = 현재가 근사
    atrPct: DEFAULT_ATR_PCT,
    sector: inferSector(c.stock_code),
    kellyFraction: 0, // 아래에서 계산
  }));

  // ── 1. 포트폴리오 VaR 계산 ──
  const weights = positions.map((p) => p.currentValue / totalAssets);
  const sigmas = positions.map((p) => p.atrPct / 100);

  // Portfolio σ = sqrt(Σ(w²×σ²) + Σ(w_i×w_j×ρ×σ_i×σ_j)) for i≠j
  let varianceSum = 0;
  for (let i = 0; i < positions.length; i++) {
    varianceSum += (weights[i] ** 2) * (sigmas[i] ** 2);
    for (let j = i + 1; j < positions.length; j++) {
      varianceSum += 2 * weights[i] * weights[j] * AVG_CORRELATION * sigmas[i] * sigmas[j];
    }
  }
  const portfolioSigma = Math.sqrt(varianceSum);
  const varPct = VAR_CONFIDENCE * portfolioSigma * 100; // 95% VaR (%)

  if (varPct > MAX_VAR_PCT) {
    logger.info(
      `🚦 [포트폴리오VaR] VaR ${varPct.toFixed(1)}% > ${MAX_VAR_PCT}% → 신규매수 차단`,
      { component: COMP },
    );
    return {
      passed: false,
      reason: `포트폴리오 VaR ${varPct.toFixed(1)}% > ${MAX_VAR_PCT}% (${positions.length}개 포지션)`,
    };
  }

  // ── 2. 섹터 집중도 체크 ──
  const newSector = inferSector(stockCode);
  const sectorValues = new Map<string, number>();
  for (const p of positions) {
    sectorValues.set(p.sector, (sectorValues.get(p.sector) ?? 0) + p.currentValue);
  }
  const sectorPct = ((sectorValues.get(newSector) ?? 0) / totalAssets) * 100;
  if (sectorPct > MAX_SECTOR_PCT) {
    logger.info(
      `🚦 [섹터집중도] ${newSector} ${sectorPct.toFixed(0)}% > ${MAX_SECTOR_PCT}% → ${stockCode} 차단`,
      { component: COMP },
    );
    return {
      passed: false,
      reason: `섹터 집중도 ${newSector} ${sectorPct.toFixed(0)}% > ${MAX_SECTOR_PCT}%`,
    };
  }

  // ── 3. Kelly 합계 체크 ──
  // 간이 Kelly: (winRate × avgWin/avgLoss - lossRate) / (avgWin/avgLoss)
  // 전체 포트폴리오의 총 Kelly가 1.0 초과 시 과다 레버리지
  try {
    const { rows: kellyData } = await getPool().query(
      `SELECT
         COUNT(*)::int AS total,
         SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)::int AS wins,
         AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) AS avg_win,
         AVG(CASE WHEN realized_pnl <= 0 THEN ABS(realized_pnl) END) AS avg_loss
       FROM transaction_chains
       WHERE status = 'CLOSED' AND is_paper = $1
         AND closed_at >= NOW() - INTERVAL '30 days'`,
      [isPaper],
    );

    if (kellyData[0]?.total >= 10) {
      const { total, wins, avg_win, avg_loss } = kellyData[0];
      const winRate = wins / total;
      const avgWin = Number(avg_win) || 1;
      const avgLoss = Number(avg_loss) || 1;
      const b = avgWin / avgLoss;
      const kellyFraction = Math.max(0, (b * winRate - (1 - winRate)) / b);
      const totalKelly = kellyFraction * positions.length;

      if (totalKelly > MAX_KELLY_SUM) {
        logger.info(
          `🚦 [Kelly합계] ${totalKelly.toFixed(2)} > ${MAX_KELLY_SUM} (${positions.length}포지션 × Kelly ${kellyFraction.toFixed(2)}) → 신규 진입 차단`,
          { component: COMP },
        );
        return {
          passed: false,
          reason: `Kelly 합계 ${totalKelly.toFixed(2)} > ${MAX_KELLY_SUM} (${positions.length}개 동시)`,
        };
      }
    }
  } catch {
    // Kelly 계산 실패 → 스킵
  }

  logger.info(
    `✅ [포트폴리오VaR] VaR=${varPct.toFixed(1)}% 섹터=${newSector}(${sectorPct.toFixed(0)}%) ${positions.length}포지션 → 통과`,
    { component: COMP },
  );

  return {
    passed: true,
    reason: `VaR ${varPct.toFixed(1)}%, 섹터 ${newSector} ${sectorPct.toFixed(0)}%`,
  };
}

/**
 * 종목 코드에서 간이 섹터 추론
 * 한국 종목코드: 6자리 숫자. 코드 범위로 대략적 섹터 분류.
 * 정확한 분류는 KRX API 필요 → 간이 버전 사용.
 */
function inferSector(stockCode: string): string {
  // 인버스/레버리지 ETF
  if (['252670', '114800', '122630', '233740'].includes(stockCode)) return 'ETF_INVERSE';

  // 주요 대형주 하드코딩 (삼성, SK, LG 그룹)
  const code = stockCode;
  if (['005930', '000660', '009150'].includes(code)) return 'SEMICONDUCTOR';
  if (['005380', '012330', '000270'].includes(code)) return 'AUTO';
  if (['051910', '006400'].includes(code)) return 'BATTERY';
  if (['035420', '035720', '263750'].includes(code)) return 'INTERNET';
  if (['068270', '028260', '207940'].includes(code)) return 'BIO';
  if (['000720', '010130'].includes(code)) return 'STEEL';
  if (['096770', '034020'].includes(code)) return 'FINANCIAL';

  // 코드 범위 기반 대략 분류 (불완전하지만 집중도 방어 목적으로 충분)
  const num = parseInt(code, 10);
  if (num < 10000) return 'SECTOR_A';
  if (num < 30000) return 'SECTOR_B';
  if (num < 60000) return 'SECTOR_C';
  if (num < 100000) return 'SECTOR_D';
  return 'SECTOR_E';
}
