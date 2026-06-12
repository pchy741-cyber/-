/**
 * Trade Tuner — 90일 매매 데이터 기반 SL/TP/Hold 파라미터 자동 최적화
 *
 * 매일 1회 실행:
 * 1. 최근 90일 매도 기록 분석 (종목별 + 섹터별 + 전체)
 * 2. 진입 후 최대 수익 vs 최종 매도 수익 비교 → 수익 누출(leak) 측정
 * 3. 손절 후 반등 비율 분석 → 손절 적정성 판단
 * 4. 최적 SL/TP 역산 + overseas_state에 저장 → 다음 매수부터 적용
 */
import { getPool } from '../../db/client.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { getOverseasState, setOverseasState } from './utils.js';

// ── Types ──

interface TradeRecord {
  stock_code: string;
  side: string;
  avg_buy: number;
  filled_price: number;
  quantity: number;
  pnl_pct: number;
  max_price: number; // 보유 중 최고가
  holding_days: number;
  ai_reasoning: string;
  created_at: Date;
}

interface SectorStats {
  sector: string;
  trades: number;
  wins: number;
  winRate: number;
  avgPnlPct: number;
  avgMaxPnlPct: number; // 보유 중 최고 수익률
  avgLeakPct: number; // 수익 누출 (최고수익 - 최종수익)
  avgHoldDays: number;
  avgSlHit: number; // 손절 비율
  optimalTp: number;
  optimalSl: number;
}

interface TuneResult {
  analyzedTrades: number;
  globalWinRate: number;
  avgPnlPct: number;
  avgLeakPct: number;
  sectorStats: SectorStats[];
  recommendations: TuneRecommendation[];
  appliedAt: string;
}

interface TuneRecommendation {
  param: string;
  current: number;
  recommended: number;
  reason: string;
}

// ── Constants ──

const STATE_KEY = 'trade_tuner_result';
const STATE_KEY_OVERRIDES = 'trade_tuner_overrides';

// 섹터 분류 (sell-logic.ts와 동일)
const SECTOR_MAP: Record<string, string> = {};

// ── Main ──

export async function runTradeTuner(isPaper = true): Promise<TuneResult | null> {
  const mode = isPaper ? 'paper' : 'live';
  logger.info(`🔧 Trade Tuner 시작 (${mode})`, { component: 'TUNER' });

  try {
    // 1. 최근 90일 매도 데이터 수집
    const trades = await fetchRecentTrades(mode);
    if (trades.length < 10) {
      logger.info(`⏭️ Trade Tuner 스킵 — 데이터 부족 (${trades.length}건, 최소 10건)`, { component: 'TUNER' });
      return null;
    }

    // 2. 전체 통계
    const wins = trades.filter((t) => t.pnl_pct >= 0);
    const losses = trades.filter((t) => t.pnl_pct < 0);
    const globalWinRate = wins.length / trades.length;
    const avgPnlPct = trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length;

    // 3. 수익 누출 분석 (최고 수익 - 실현 수익)
    const tradesWithMax = trades.filter((t) => t.max_price > 0);
    const leaks = tradesWithMax.map((t) => {
      const maxPnlPct = ((t.max_price - t.avg_buy) / t.avg_buy) * 100;
      return Math.max(0, maxPnlPct - t.pnl_pct);
    });
    const avgLeakPct = leaks.length > 0 ? leaks.reduce((s, l) => s + l, 0) / leaks.length : 0;

    // 4. 손절 분석
    const slTrades = losses.filter((t) => t.ai_reasoning.includes('손절') || t.ai_reasoning.includes('stopLoss'));
    const holdExpiredTrades = losses.filter(
      (t) => t.ai_reasoning.includes('보유기한') || t.ai_reasoning.includes('약세종목'),
    );

    // 5. 섹터별 분석
    const sectorStats = analyzeBySector(trades);

    // 6. 최적 파라미터 역산
    const recommendations = generateRecommendations({
      trades,
      wins,
      losses,
      slTrades,
      holdExpiredTrades,
      globalWinRate,
      avgPnlPct,
      avgLeakPct,
      sectorStats,
    });

    // 7. 튜닝 결과 저장
    const result: TuneResult = {
      analyzedTrades: trades.length,
      globalWinRate,
      avgPnlPct,
      avgLeakPct,
      sectorStats,
      recommendations,
      appliedAt: new Date().toISOString(),
    };
    await setOverseasState(isPaper ? STATE_KEY : `${STATE_KEY}_live`, JSON.stringify(result));

    // 8. 파라미터 오버라이드 적용
    const overrides = buildOverrides(recommendations);
    if (Object.keys(overrides).length > 0) {
      await setOverseasState(isPaper ? STATE_KEY_OVERRIDES : `${STATE_KEY_OVERRIDES}_live`, JSON.stringify(overrides));
    }

    // 9. 텔레그램 알림
    const report = formatReport(result);
    logger.info(report, { component: 'TUNER' });
    await sendTelegramMessage(report).catch(() => {});

    return result;
  } catch (e: any) {
    logger.error(`Trade Tuner 실패: ${e.message}`, { component: 'TUNER' });
    return null;
  }
}

// ── 데이터 수집 ──

async function fetchRecentTrades(mode: string): Promise<TradeRecord[]> {
  const { rows } = await getPool().query(
    `
    SELECT
      o.stock_code,
      o.side,
      o.filled_price,
      o.quantity,
      o.ai_reasoning,
      o.created_at,
      (regexp_match(o.ai_reasoning, '\\[avgBuy:([0-9]+\\.?[0-9]*)\\]'))[1]::numeric AS avg_buy
    FROM orders o
    WHERE o.trigger_source = 'OVERSEAS'
      AND o.trading_mode = $1
      AND o.side = 'SELL'
      AND o.status = 'FILLED'
      AND o.filled_price IS NOT NULL
      AND o.ai_reasoning ~ '\\[avgBuy:[0-9]'
      AND o.created_at >= NOW() - INTERVAL '90 days'
    ORDER BY o.created_at DESC
  `,
    [mode],
  );

  const results: TradeRecord[] = [];
  for (const r of rows) {
    const avgBuy = Number(r.avg_buy);
    const filledPrice = Number(r.filled_price);
    if (avgBuy <= 0 || filledPrice <= 0) continue;

    // max_price: overseas_state에 저장된 고점 데이터 조회
    const maxKey = `max_${mode === 'paper' ? 'p_' : ''}${r.stock_code}`;
    let maxPrice = 0;
    try {
      const val = await getOverseasState(maxKey);
      maxPrice = val ? Number(val) : 0;
    } catch {
      /* ignore */
    }
    if (maxPrice <= 0) maxPrice = Math.max(avgBuy, filledPrice);

    // holding_days: 매수시점 추정 (같은 종목 직전 BUY 주문)
    let holdingDays = 7; // 기본값
    try {
      const { rows: buyRows } = await getPool().query(
        `
        SELECT created_at FROM orders
        WHERE stock_code = $1 AND side = 'BUY' AND trigger_source = 'OVERSEAS'
          AND trading_mode = $2 AND status = 'FILLED'
          AND created_at < $3
        ORDER BY created_at DESC LIMIT 1
      `,
        [r.stock_code, mode, r.created_at],
      );
      if (buyRows.length > 0) {
        holdingDays =
          (new Date(r.created_at).getTime() - new Date(buyRows[0].created_at).getTime()) / (1000 * 60 * 60 * 24);
      }
    } catch {
      /* ignore */
    }

    results.push({
      stock_code: r.stock_code,
      side: r.side,
      avg_buy: avgBuy,
      filled_price: filledPrice,
      quantity: Number(r.quantity),
      pnl_pct: ((filledPrice - avgBuy) / avgBuy) * 100,
      max_price: maxPrice,
      holding_days: holdingDays,
      ai_reasoning: String(r.ai_reasoning ?? ''),
      created_at: new Date(r.created_at),
    });
  }
  return results;
}

// ── 섹터 분석 ──

function analyzeBySector(trades: TradeRecord[]): SectorStats[] {
  const groups = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const sector = SECTOR_MAP[t.stock_code] ?? 'UNKNOWN';
    if (!groups.has(sector)) groups.set(sector, []);
    groups.get(sector)!.push(t);
  }

  // 섹터 분류 없으면 stock_code 기반으로 그룹
  if (groups.size <= 1) {
    groups.clear();
    for (const t of trades) {
      if (!groups.has(t.stock_code)) groups.set(t.stock_code, []);
      groups.get(t.stock_code)!.push(t);
    }
  }

  const stats: SectorStats[] = [];
  for (const [sector, group] of groups) {
    if (group.length < 3) continue;
    const wins = group.filter((t) => t.pnl_pct >= 0);
    const slHits = group.filter((t) => t.ai_reasoning.includes('손절') || t.ai_reasoning.includes('stopLoss'));
    const maxPnls = group.filter((t) => t.max_price > 0).map((t) => ((t.max_price - t.avg_buy) / t.avg_buy) * 100);
    const leaks = group
      .filter((t) => t.max_price > 0)
      .map((t) => {
        const maxPnl = ((t.max_price - t.avg_buy) / t.avg_buy) * 100;
        return Math.max(0, maxPnl - t.pnl_pct);
      });

    // 최적 TP: 실현된 수익 상위 75백분위수
    const winPnls = wins.map((t) => t.pnl_pct).sort((a, b) => a - b);
    const optimalTp = winPnls.length > 0 ? winPnls[Math.floor(winPnls.length * 0.75)] : 20;

    // 최적 SL: 손실 trades의 중앙값 × 1.2 (여유)
    const lossPnls = group
      .filter((t) => t.pnl_pct < 0)
      .map((t) => Math.abs(t.pnl_pct))
      .sort((a, b) => a - b);
    const medianLoss = lossPnls.length > 0 ? lossPnls[Math.floor(lossPnls.length * 0.5)] : 5;
    const optimalSl = Math.min(15, Math.max(3, medianLoss * 1.2));

    stats.push({
      sector,
      trades: group.length,
      wins: wins.length,
      winRate: wins.length / group.length,
      avgPnlPct: group.reduce((s, t) => s + t.pnl_pct, 0) / group.length,
      avgMaxPnlPct: maxPnls.length > 0 ? maxPnls.reduce((s, v) => s + v, 0) / maxPnls.length : 0,
      avgLeakPct: leaks.length > 0 ? leaks.reduce((s, l) => s + l, 0) / leaks.length : 0,
      avgHoldDays: group.reduce((s, t) => s + t.holding_days, 0) / group.length,
      avgSlHit: slHits.length / group.length,
      optimalTp,
      optimalSl,
    });
  }

  return stats.sort((a, b) => b.trades - a.trades);
}

// ── 추천 생성 ──

function generateRecommendations(ctx: {
  trades: TradeRecord[];
  wins: TradeRecord[];
  losses: TradeRecord[];
  slTrades: TradeRecord[];
  holdExpiredTrades: TradeRecord[];
  globalWinRate: number;
  avgPnlPct: number;
  avgLeakPct: number;
  sectorStats: SectorStats[];
}): TuneRecommendation[] {
  const recs: TuneRecommendation[] = [];

  // 1. 손절 너무 타이트? (손절 후 반등 많으면 SL 넓히기)
  if (ctx.slTrades.length >= 3) {
    const slPnls = ctx.slTrades.map((t) => Math.abs(t.pnl_pct));
    const avgSlPct = slPnls.reduce((s, v) => s + v, 0) / slPnls.length;
    const slRatio = ctx.slTrades.length / ctx.trades.length;

    if (slRatio > 0.35 && avgSlPct < 6) {
      // 손절 비율 35% 초과 + 평균 손절폭 6% 미만 → 너무 타이트
      const recommended = Math.min(12, avgSlPct * 1.5);
      recs.push({
        param: 'sl_base_pct',
        current: avgSlPct,
        recommended: Math.round(recommended * 10) / 10,
        reason: `손절 ${(slRatio * 100).toFixed(0)}% 발동 — 평균 -${avgSlPct.toFixed(1)}%에서 잘림 → SL 넓히기`,
      });
    }
  }

  // 2. 수익 누출 크면 트레일링 활성화 기준 낮추기
  if (ctx.avgLeakPct > 5) {
    recs.push({
      param: 'trail_activate_pct',
      current: 8, // 현재 기본값 (medium beta)
      recommended: Math.max(3, Math.round(ctx.avgLeakPct * 0.5 * 10) / 10),
      reason: `평균 ${ctx.avgLeakPct.toFixed(1)}% 수익 누출 — 트레일링 조기 활성화 필요`,
    });
  }

  // 3. 보유기한 초과 청산 비율 높으면 maxHoldDays 조정
  if (ctx.holdExpiredTrades.length >= 3) {
    const holdExpRatio = ctx.holdExpiredTrades.length / ctx.trades.length;
    const avgHoldDays = ctx.holdExpiredTrades.reduce((s, t) => s + t.holding_days, 0) / ctx.holdExpiredTrades.length;

    if (holdExpRatio > 0.2) {
      // 보유기한 초과가 20% 넘으면 기한 연장 or 조기 손절로 전환
      const holdExpAvgPnl = ctx.holdExpiredTrades.reduce((s, t) => s + t.pnl_pct, 0) / ctx.holdExpiredTrades.length;
      if (holdExpAvgPnl < -2) {
        recs.push({
          param: 'max_hold_days',
          current: Math.round(avgHoldDays),
          recommended: Math.max(5, Math.round(avgHoldDays * 0.7)),
          reason: `보유기한 초과 ${(holdExpRatio * 100).toFixed(0)}% — 평균 ${holdExpAvgPnl.toFixed(1)}% 손실 → 조기 정리`,
        });
      } else {
        recs.push({
          param: 'max_hold_days',
          current: Math.round(avgHoldDays),
          recommended: Math.round(avgHoldDays * 1.3),
          reason: `보유기한 초과 ${(holdExpRatio * 100).toFixed(0)}% — 평균 ${holdExpAvgPnl.toFixed(1)}% 미미 → 기한 연장`,
        });
      }
    }
  }

  // 4. TP 너무 높아서 안 걸리면 낮추기
  const tpHits = ctx.wins.filter((t) => t.ai_reasoning.includes('익절') || t.ai_reasoning.includes('TP'));
  if (ctx.wins.length >= 5 && tpHits.length / ctx.wins.length < 0.1) {
    // TP 익절이 전체 승리의 10% 미만 → TP 너무 높음
    const avgWinPnl = ctx.wins.reduce((s, t) => s + t.pnl_pct, 0) / ctx.wins.length;
    recs.push({
      param: 'tp_base_pct',
      current: 20, // 현재 기본값
      recommended: Math.max(10, Math.round(avgWinPnl * 1.3)),
      reason: `TP 익절 ${tpHits.length}/${ctx.wins.length}건만 발동 — 평균 수익 +${avgWinPnl.toFixed(1)}% → TP 하향`,
    });
  }

  // 5. 승률 기반 R:R 비율 최적화
  if (ctx.globalWinRate < 0.45 && ctx.losses.length >= 5) {
    const avgWin = ctx.wins.length > 0 ? ctx.wins.reduce((s, t) => s + t.pnl_pct, 0) / ctx.wins.length : 0;
    const avgLoss = ctx.losses.reduce((s, t) => s + Math.abs(t.pnl_pct), 0) / ctx.losses.length;
    const rr = avgLoss > 0 ? avgWin / avgLoss : 1;

    if (rr < 1.5) {
      recs.push({
        param: 'risk_reward_ratio',
        current: Math.round(rr * 10) / 10,
        recommended: 2.0,
        reason: `승률 ${(ctx.globalWinRate * 100).toFixed(0)}% + R:R ${rr.toFixed(1)} → SL 줄이고 TP 늘려 R:R 2.0 목표`,
      });
    }
  }

  // ── 6. 세이버메트릭스: 파라미터 감도 분석 (Parameter Sensitivity) ──
  // 다양한 SL/TP 조합으로 가상 시뮬레이션 → 최적 R배수 역산
  recs.push(...runParameterSensitivity(ctx.trades, ctx.globalWinRate));

  return recs;
}

/**
 * 세이버메트릭스 파라미터 감도 분석
 * 과거 거래의 max_price를 활용해 "만약 TP/SL을 X%로 했다면?" 시뮬레이션
 */
function runParameterSensitivity(trades: TradeRecord[], _currentWinRate: number): TuneRecommendation[] {
  if (trades.length < 15) return [];

  const recs: TuneRecommendation[] = [];
  const tradesWithMax = trades.filter((t) => t.max_price > t.avg_buy * 1.001);
  if (tradesWithMax.length < 10) return recs;

  // SL 후보: 3~12%, TP 후보: 5~25% — 각 조합의 가상 PF 계산
  const slCandidates = [3, 4, 5, 6, 7, 8, 10, 12];
  const tpCandidates = [5, 7, 10, 12, 15, 20];

  let bestPF = 0;
  let bestEV = -Infinity;
  let bestSL = 5;
  let bestTP = 12;

  for (const sl of slCandidates) {
    for (const tp of tpCandidates) {
      if (tp / sl < 1.5) continue; // R:R 1.5 미만은 건너뜀

      let simWins = 0;
      let simGrossWin = 0;
      let simGrossLoss = 0;

      for (const t of tradesWithMax) {
        const maxPnlPct = ((t.max_price - t.avg_buy) / t.avg_buy) * 100;
        const actualPnlPct = t.pnl_pct;

        // 시뮬레이션: TP에 먼저 도달했으면 TP에서 매도, 아니면 SL 또는 실제값
        if (maxPnlPct >= tp) {
          // TP 도달 → 수익
          simWins++;
          simGrossWin += tp;
        } else if (actualPnlPct <= -sl) {
          // SL 발동 → 손실
          simGrossLoss += sl;
        } else {
          // TP/SL 모두 미발동 → 실제 결과 사용
          if (actualPnlPct >= 0) {
            simWins++;
            simGrossWin += actualPnlPct;
          } else {
            simGrossLoss += Math.abs(actualPnlPct);
          }
        }
      }

      const simWinRate = simWins / tradesWithMax.length;
      const simPF = simGrossLoss > 0 ? simGrossWin / simGrossLoss : simGrossWin > 0 ? 99 : 0;
      const simAvgWin = simWins > 0 ? simGrossWin / simWins : 0;
      const simLosses = tradesWithMax.length - simWins;
      const simAvgLoss = simLosses > 0 ? simGrossLoss / simLosses : 1;
      const simEV = simWinRate * simAvgWin - (1 - simWinRate) * simAvgLoss;

      if (simEV > bestEV && simPF > 1.0) {
        bestEV = simEV;
        bestPF = simPF;
        bestSL = sl;
        bestTP = tp;
      }
    }
  }

  // 현재 대비 의미있는 개선이 있으면 추천
  const currentAvgWin = trades.filter((t) => t.pnl_pct > 0).reduce((s, t) => s + t.pnl_pct, 0);
  const currentAvgLoss = Math.abs(trades.filter((t) => t.pnl_pct <= 0).reduce((s, t) => s + t.pnl_pct, 0));
  const currentPF = currentAvgLoss > 0 ? currentAvgWin / currentAvgLoss : 1;

  if (bestPF > currentPF * 1.15 && bestEV > 0.5) {
    // 15% 이상 PF 개선 + EV 0.5% 이상
    recs.push({
      param: 'sensitivity_optimal_sl',
      current: Math.round((currentAvgLoss / trades.filter((t) => t.pnl_pct <= 0).length) * 10) / 10,
      recommended: bestSL,
      reason: `⚾ 감도분석: SL ${bestSL}% + TP ${bestTP}% → PF ${bestPF.toFixed(2)} (현재 ${currentPF.toFixed(2)}) EV +${bestEV.toFixed(2)}%/건`,
    });
    recs.push({
      param: 'sensitivity_optimal_tp',
      current: Math.round((currentAvgWin / Math.max(1, trades.filter((t) => t.pnl_pct > 0).length)) * 10) / 10,
      recommended: bestTP,
      reason: `⚾ 감도분석: R:R ${(bestTP / bestSL).toFixed(1)} 최적 (${tradesWithMax.length}건 시뮬)`,
    });
  }

  return recs;
}

// ── 오버라이드 빌드 ──

function buildOverrides(recs: TuneRecommendation[]): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const r of recs) {
    // 감도분석 결과는 실제 파라미터명으로 매핑
    if (r.param === 'sensitivity_optimal_sl') {
      overrides.sl_base_pct = r.recommended;
    } else if (r.param === 'sensitivity_optimal_tp') {
      overrides.tp_base_pct = r.recommended;
    } else {
      overrides[r.param] = r.recommended;
    }
  }
  return overrides;
}

// ── 튜닝 오버라이드 읽기 (sell-logic/buy-filter에서 호출) ──

export async function getTunerOverrides(isPaper = true): Promise<Record<string, number>> {
  try {
    const key = isPaper ? STATE_KEY_OVERRIDES : `${STATE_KEY_OVERRIDES}_live`;
    const raw = await getOverseasState(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ── 리포트 ──

function formatReport(r: TuneResult): string {
  // 세이버메트릭스 요약 계산
  const wins = r.analyzedTrades * r.globalWinRate;
  const losses = r.analyzedTrades - wins;
  const avgWin = wins > 0 ? (r.avgPnlPct * r.analyzedTrades + Math.abs(r.avgPnlPct) * losses) / wins : 0; // 추정
  const avgLoss = r.avgLeakPct > 0 ? r.avgLeakPct : 3;
  const rMultiple = avgLoss > 0 ? Math.abs(avgWin) / avgLoss : 1;
  const bep = rMultiple > 0 ? 1 / (1 + rMultiple) : 0.5;
  const margin = r.globalWinRate - bep;

  const lines = [
    `🔧 Trade Tuner + ⚾ Sabermetrics 분석`,
    `📊 ${r.analyzedTrades}건 | 승률 ${(r.globalWinRate * 100).toFixed(0)}% | 평균 ${r.avgPnlPct >= 0 ? '+' : ''}${r.avgPnlPct.toFixed(2)}%`,
    `⚾ R배수 ${rMultiple.toFixed(1)} | 손익분기 ${(bep * 100).toFixed(0)}% | 마진 ${margin >= 0 ? '+' : ''}${(margin * 100).toFixed(1)}%p`,
    `💸 수익누출: ${r.avgLeakPct.toFixed(1)}% (고점 대비)`,
  ];

  if (r.sectorStats.length > 0) {
    lines.push('', '📈 종목별:');
    for (const s of r.sectorStats.slice(0, 8)) {
      lines.push(
        `  ${s.sector}: ${s.trades}건 승률${(s.winRate * 100).toFixed(0)}% avg${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}% leak${s.avgLeakPct.toFixed(1)}%`,
      );
    }
  }

  if (r.recommendations.length > 0) {
    lines.push('', '⚙️ 추천 조정:');
    for (const rec of r.recommendations) {
      lines.push(`  ${rec.param}: ${rec.current} → ${rec.recommended} (${rec.reason})`);
    }
  } else {
    lines.push('', '✅ 현재 파라미터 적정 — 조정 불필요');
  }

  return lines.join('\n');
}
