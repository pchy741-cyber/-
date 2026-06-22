import type { CrashSignal } from '../../automation/crash-profit.js';
import { getConcentrationSellTargets } from '../../automation/portfolio-guard.js';
import type { StrategyMode } from '../../config/constants.js';
import type { TradeDecision, TransactionChain } from '../../db/models.js';
import type { CurrentPrice } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { applyEodBluechipStrategy } from './eod-bluechip.js';
import { adjustPositionSizes } from './position-sizer.js';
import {
  applyHardRules,
  deduplicateSells,
  filterEarlySells,
  filterManualCooldown,
  filterSectorConcentration,
} from './risk-guard.js';

/**
 * 매매 결정 필터 체인 — 우선순위 순서 절대 고정
 *
 * ❌ 이 파일의 실행 순서를 변경하지 말 것. 각 단계는 이전 단계 결과에 의존함.
 *
 *  1. 집중도 부분매도 주입  — portfolio-guard 25%↑ 비중 강제 조정 (선점형 매도)
 *  2. 조기 매도 방지        — 손절선 미도달 AI 매도 신호 차단 (수익 구간 포지션 보호)
 *  3. 섹터 집중 차단        — 같은 섹터 2종목↑ 신규매수 차단 (분산 강제)
 *  4. 유휴현금 파킹         — idle cash → ETF 파킹/해제 (기회비용 최소화)
 *  5. 하드룰 강제 실행      — 트레일링 스탑 + 고정 손절 (AI 무관 강제 청산, 최강 우선)
 *  5b. 현재가 주입          — BUY/AVERAGE_DOWN limit_price 보정 (executor 재조회 실패 방지)
 *  6. 수동매도 쿨다운       — CEO 수동매도 후 24시간 재진입 금지 (CEO 의사 존중)
 *  7. 포지션 크기 보정      — KOSPI 레짐 반영 수량 조정 (시장 상황 적응)
 *  8. 중복 매도 제거        — FORCE_CLOSE > SELL > PARTIAL_SELL 우선순위
 *  9. EOD 블루칩 줍줍       — 하락장 14:50 매수 / 익일 09:05 청산 (오버나잇 갭 전략)
 * 10. 최종 필터 + 정렬      — HOLD 제거, 가격 검증, 매도→매수 순
 */

export interface DecisionFlowParams {
  rawDecisions: TradeDecision[];
  openChains: TransactionChain[];
  livePrices: Map<string, CurrentPrice>;
  mode: StrategyMode;
  manuallySoldCodes: Set<string>;
  scores: Array<{ stock_code: string; composite_score?: number }>;
  totalAssets: number;
  kospiRegime: { penalty: number; boost: boolean; todayDown: boolean; adamKhooBullish?: boolean };
  resolvedSl: number | undefined | null;
  resolvedTp: number | undefined | null;
  orderableCash: number;
  hasBuyCandidates: boolean;
  blockNewBuys: boolean;
  blockEodBuys: boolean;
  adjMaxPositionKrw: number;
  chartData?: Map<string, import('../../kis/market.js').DailyCandle[]>;
  kstH: number;
  kstM: number;
  macroRiskOff?: boolean;
  isPaper?: boolean;
  crashSignal?: CrashSignal;
  overseasValueKrw?: number;
}

export async function applyDecisionFlow(params: DecisionFlowParams): Promise<TradeDecision[]> {
  const {
    rawDecisions,
    openChains,
    livePrices,
    mode,
    manuallySoldCodes,
    scores,
    totalAssets,
    kospiRegime,
    resolvedSl,
    resolvedTp,
    orderableCash,
    hasBuyCandidates,
    blockNewBuys,
    blockEodBuys,
    adjMaxPositionKrw,
    chartData,
    kstH,
    kstM,
  } = params;

  let decisions = [...rawDecisions];

  // ── 0-pre. 실험 전략 실전 차단: 졸업 전까지 Paper에서 승률 검증 ──
  // 졸업 시스템 연동: AUTO_APPLIED/APPROVED된 전략은 Live 매수 허용
  // 연습(Paper) = 전체 전략 허용 → 승률 데이터 축적
  const { getPaperOnlyModes } = await import('../../automation/strategy-graduation.js');
  const PAPER_ONLY_MODES = await getPaperOnlyModes();
  if (!params.isPaper && PAPER_ONLY_MODES.has(mode)) {
    const buys = decisions.filter((d) => d.action === 'BUY' || d.action === 'AVERAGE_DOWN');
    if (buys.length > 0) {
      logger.info(`🧪 ${mode} 실험모드: 실전 신규매수 ${buys.length}건 차단 (Paper에서 승률 검증 중)`, {
        component: 'DECISION_FLOW',
      });
    }
    // 매도/손절은 허용 (기존 보유분 정리)
    decisions = decisions.filter((d) => d.action !== 'BUY' && d.action !== 'AVERAGE_DOWN');
  }

  // ── 0a. CEO 매수금지 종목 보유분 처리 ─────────────────────────────
  //
  // CEO 지시 (2026-06-12): 강제청산 → 익절/손절 도달까지 hold 로 완화
  //   Why: ARIRANG 단기채권 사례 — 정책 추가로 강제청산 2회, -75k 손실 확정
  //   How:
  //     - 신규 매수는 hard-gates.ts에서 이미 차단 중 (보유 0인 종목은 진입 불가)
  //     - 기존 보유분은 일반 TP/SL/트레일링 신호 따름
  //     - 단, 신규 매수/물타기 신호는 무조건 차단 (이중 안전장치)
  //   인버스 ETF는 crash-profit.ts가 신호 기반으로 직접 관리 (별도)
  {
    const { BUY_BLOCKED_CODES } = await import('./trading-rules.js');
    const blockedBuys = decisions.filter(
      (d) =>
        BUY_BLOCKED_CODES.has(d.stock_code) &&
        (d.action === 'BUY' || d.action === 'AVERAGE_DOWN'),
    );
    if (blockedBuys.length > 0) {
      logger.warn(
        `🚫 매수금지 종목 신규매수 ${blockedBuys.length}건 차단: ${blockedBuys.map((d) => d.stock_code).join(', ')}`,
        { component: 'DECISION_FLOW' },
      );
      decisions = decisions.filter(
        (d) =>
          !(BUY_BLOCKED_CODES.has(d.stock_code) && (d.action === 'BUY' || d.action === 'AVERAGE_DOWN')),
      );
    }
  }

  // ── 0b. 인버스 ETF 결정 보호 (crash-profit 결정은 필터 우회) ────
  const { INVERSE_ETF_CODES } = await import('../../automation/crash-profit.js');
  const inverseDecisions = decisions.filter((d) => INVERSE_ETF_CODES.has(d.stock_code));
  decisions = decisions.filter((d) => !INVERSE_ETF_CODES.has(d.stock_code));

  // ── 0c. BREAKOUT 모드: 비돌파 매수 차단 (BREAKOUT 전용 매수만 허용) ────
  if (mode === 'BREAKOUT') {
    const nonBreakoutBuys = decisions.filter(
      (d) => (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && d.strategy_mode !== 'BREAKOUT',
    );
    if (nonBreakoutBuys.length > 0) {
      logger.info(`📈 BREAKOUT 모드: 비돌파 매수 ${nonBreakoutBuys.length}건 차단`, { component: 'DECISION_FLOW' });
      decisions = decisions.filter(
        (d) => !((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && d.strategy_mode !== 'BREAKOUT'),
      );
    }
  }

  // ── 1. 집중도 부분매도 주입 ─────────────────────────────────────────
  const concentrationTargets = getConcentrationSellTargets(
    openChains,
    livePrices,
    totalAssets,
    params.overseasValueKrw,
  );
  for (const code of concentrationTargets) {
    const chain = openChains.find((c) => c.stock_code === code);
    if (!chain || chain.total_quantity < 3) continue;
    const sellQty = Math.floor(chain.total_quantity / 3);
    if (sellQty < 1) continue;
    const alreadySelling = decisions.some(
      (d) => d.stock_code === code && ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action),
    );
    if (!alreadySelling) {
      decisions.unshift({
        action: 'PARTIAL_SELL',
        stock_code: code,
        quantity: sellQty,
        price_type: 'MARKET',
        reasoning: '집중도 자동조정: 포트폴리오 25% 초과 + 수익구간 → 1/3 비중 축소',
        confidence: 0.9,
      });
    }
  }

  // ── 2. 조기 매도 방지 필터 ──────────────────────────────────────────
  decisions = filterEarlySells({
    decisions,
    openChains,
    livePrices,
    mode,
    stopLossPct: resolvedSl ?? null,
    takeProfitPct: resolvedTp ?? null,
  });

  // ── 3. 섹터 집중 매수 차단 ──────────────────────────────────────────
  decisions = filterSectorConcentration(decisions, openChains, params.isPaper ?? false);

  // ── 3.5. 크로스마켓 테크 비중 관리 (KR+US 합산 테크 50% 캡) ──────
  if (!params.isPaper && (params.overseasValueKrw ?? 0) > 0) {
    try {
      const { getPool } = await import('../../db/client.js');
      const { SECTOR_MAP_KR } = await import('../../config/constants.js');
      // 해외 테크 섹터 보유금액 조회
      const { rows: osRows } = await getPool().query(`
        SELECT stock_code, total_quantity, avg_buy_price
        FROM transaction_chains
        WHERE status = 'OPEN' AND trading_mode = 'live'
          AND stock_code ~ '^[A-Z]'
      `);
      const US_TECH_SECTORS = new Set(['AI_SEMI', 'TECH', 'CLOUD', 'GROWTH']);
      const { GLOBAL_WATCHLIST } = await import('../../scheduler/overseas/watchlist.js');
      const usSectorMap = new Map(GLOBAL_WATCHLIST.map((w: { code: string; sector: string }) => [w.code, w.sector]));
      let usTechValueKrw = 0;
      for (const r of osRows) {
        const sector = usSectorMap.get(String(r.stock_code));
        if (sector && US_TECH_SECTORS.has(sector)) {
          usTechValueKrw += Number(r.total_quantity) * Number(r.avg_buy_price);
        }
      }
      // KR 테크 섹터 보유금액 (반도체 + 인터넷)
      const KR_TECH_SECTORS = new Set(['반도체', '인터넷']);
      let krTechValueKrw = 0;
      for (const c of openChains) {
        if (Number(c.total_quantity) <= 0) continue;
        const sector = SECTOR_MAP_KR[c.stock_code];
        if (sector && KR_TECH_SECTORS.has(sector)) {
          krTechValueKrw += Number(c.total_quantity) * Number(c.avg_buy_price);
        }
      }
      // 해외 USD → KRW 환산 (overseasValueKrw / 해외총평가 비율 기반)
      const totalOsValue = osRows.reduce((s: number, r: { total_quantity: number; avg_buy_price: number }) =>
        s + Number(r.total_quantity) * Number(r.avg_buy_price), 0);
      const krwRate = totalOsValue > 0 ? (params.overseasValueKrw ?? 0) / totalOsValue : 0;
      const usTechKrw = usTechValueKrw * krwRate;
      const combinedTechKrw = krTechValueKrw + usTechKrw;
      const combinedTechPct = totalAssets > 0 ? (combinedTechKrw / totalAssets) * 100 : 0;

      if (combinedTechPct >= 50) {
        const blocked: string[] = [];
        for (const d of decisions) {
          if (d.action !== 'BUY' && d.action !== 'AVERAGE_DOWN') continue;
          const sector = SECTOR_MAP_KR[d.stock_code];
          if (sector && KR_TECH_SECTORS.has(sector)) {
            blocked.push(d.stock_code);
            d.action = 'HOLD';
            d.reasoning = `[크로스마켓 테크 ${combinedTechPct.toFixed(0)}%≥50% 차단] ${d.reasoning}`;
          }
        }
        if (blocked.length > 0) {
          logger.info(`🌐 크로스마켓 테크 비중 ${combinedTechPct.toFixed(1)}% → KR 테크 매수 ${blocked.length}건 차단: ${blocked.join(',')}`, { component: 'CROSS_SECTOR' });
        }
      }
    } catch (e) {
      logger.warn(`크로스마켓 섹터 체크 실패: ${e}`, { component: 'CROSS_SECTOR' });
    }
  }

  // ── 4. 유휴 현금 파킹 해제 (SELL만 먼저 — BUY는 포지션사이저 이후 step 7.5에서 추가) ──
  // confirmedBuyCount: confidence 0.6+ 인 확정 매수만 카운트 (저품질 매수로 파킹 깨지 않게)
  const confirmedBuyCount = decisions.filter(
    (d) => (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && (d.confidence ?? 0) >= 0.6,
  ).length;
  const _parkingBuyDecisions: import('../../db/models.js').TradeDecision[] = [];
  {
    const { manageCashParking } = await import('./cash-manager.js');
    // 해외 목표 비중 조회 — cash-manager가 국내 파킹 예산 제한에 사용
    let overseasTargetPct = 0;
    if (!params.isPaper) {
      try {
        const { getPool } = await import('../../db/client.js');
        const { rows } = await getPool().query(
          'SELECT us_pct FROM portfolio_allocation_config WHERE is_paper = false ORDER BY id DESC LIMIT 1',
        );
        overseasTargetPct = Number(rows[0]?.us_pct ?? 0);
      } catch { /* 기본값 0 유지 */ }
    }
    const cashDecisions = manageCashParking({
      orderableCash,
      totalAssets,
      hasBuyCandidates,
      confirmedBuyCount,
      openChains,
      livePrices,
      chartData,
      mode,
      blockNewBuys,
      macroRiskOff: params.macroRiskOff,
      isPaper: params.isPaper,
      overseasTargetPct,
    });
    for (const d of cashDecisions) {
      if (d.action === 'SELL')
        decisions.unshift(d); // 파킹 해제 즉시
      else _parkingBuyDecisions.push(d); // 파킹 매수는 보류
    }
  }

  // ── 5. 하드룰: 트레일링 스탑 + 고정 손절 (AI 결정 무관 강제 실행) ──
  decisions = await applyHardRules({
    decisions,
    openChains,
    livePrices,
    mode,
    stopLossPct: resolvedSl ?? null,
    chartData, // 동적 ATR 트레일링에 사용
  });

  // ── 5.5. 분할 수익실현 — 수익 종목 단계별 일부 매도 (해외 시스템 포팅) ──
  {
    const { evaluateKrPartialTp } = await import('./partial-tp.js');
    for (const chain of openChains) {
      const price = livePrices.get(chain.stock_code);
      if (!price || !chain.avg_buy_price || chain.total_quantity < 2) continue;
      const avgBuy = Number(chain.avg_buy_price);
      if (avgBuy <= 0) continue;
      const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;
      if (pnlPct < 1.0) continue; // 최소 +1% 이상만 평가

      // 이미 매도 결정 있으면 스킵
      const alreadySelling = decisions.some(
        (d) => d.stock_code === chain.stock_code && ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action),
      );
      if (alreadySelling) continue;

      // ADX 조회 (chartData 있으면)
      let adx: number | undefined;
      const candles = chartData?.get(chain.stock_code);
      if (candles && candles.length >= 20) {
        const { analyzeTechnicals } = await import('../../analysis/indicators.js');
        const tech = analyzeTechnicals(candles);
        adx = tech?.adx14;
      }

      const ptpResults = await evaluateKrPartialTp({
        chainId: chain.id,
        stockCode: chain.stock_code,
        pnlPct,
        totalQty: chain.total_quantity,
        adx,
      });
      for (const ptp of ptpResults) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: ptp.quantity,
          price_type: 'MARKET',
          reasoning: `분할TP ${ptp.stage}단계: +${pnlPct.toFixed(1)}% (임계 ${ptp.triggerPct}%)`,
          confidence: 0.95,
        });
      }
    }
  }

  // ── 5b. BUY/AVERAGE_DOWN 현재가 주입 ────────────────────────────────
  for (const d of decisions) {
    if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !d.limit_price) {
      const livePrice = livePrices.get(d.stock_code)?.currentPrice ?? 0;
      if (livePrice > 0) d.limit_price = livePrice;
    }
  }

  // ── 6. CEO 수동 매도 쿨다운 필터 ────────────────────────────────────
  decisions = filterManualCooldown(decisions, manuallySoldCodes);

  // ── 7. 포지션 크기 보정 (KOSPI 레짐 반영) ────────────────────────────
  // adjMaxPositionKrw는 pipeline에서 totalAssets×20%×perfMult×stressMult×earlyWarnMult로 계산
  // position-sizer는 이 값을 기준으로 convMult만 적용 (독자 재계산 안 함)
  decisions = adjustPositionSizes({
    decisions,
    scores: scores.map((s) => ({ stock_code: s.stock_code, composite_score: s.composite_score })),
    mode,
    totalAssets,
    adjMaxPositionKrw,
    kospiRegimePenalty: Math.min(2, Math.max(0, Math.round(kospiRegime.penalty))) as 0 | 1 | 2,
    kospiBoost: kospiRegime.boost,
    adamKhooBullish: kospiRegime.adamKhooBullish,
  });

  // ── 7.5. 파킹 매수 추가 (포지션사이저 이후 — 사이저가 파킹 수량 줄이지 않게) ──
  // 파킹은 cash-manager가 이미 적정 수량 계산했으므로 사이저 우회
  for (const d of _parkingBuyDecisions) decisions.push(d);

  // ── 8. 중복 매도 신호 제거 (FORCE_CLOSE > SELL > PARTIAL_SELL) ───────
  decisions = deduplicateSells(decisions);

  // ── 9. EOD 블루칩 줍줍 + 익일 장시작 청산 ────────────────────────────
  decisions = applyEodBluechipStrategy(decisions, {
    kstH,
    kstM,
    openChains,
    livePrices,
    todayDown: kospiRegime.todayDown,
    kospiPenalty: kospiRegime.penalty,
    adjMaxPositionKrw,
    totalAssets,
    blockNewBuys: blockEodBuys, // EOD 전략은 isPastClose/eodOnlyActive 제외한 하드블록만
    watchlistCodes: scores.map((s) => s.stock_code),
  });

  // ── 9a. 실험 전략 개별 매수 실전 차단 (eod-bluechip에서 주입된 BOTTOM_FISHING 등) ──
  if (!params.isPaper) {
    const before = decisions.length;
    decisions = decisions.filter((d) => {
      if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && PAPER_ONLY_MODES.has(d.strategy_mode ?? '')) {
        logger.info(`🧪 ${d.stock_code}: ${d.strategy_mode} 실험전략 실전매수 차단`, { component: 'DECISION_FLOW' });
        return false;
      }
      return true;
    });
    if (decisions.length < before) {
      logger.info(`🧪 실험전략 실전매수 ${before - decisions.length}건 차단됨`, { component: 'DECISION_FLOW' });
    }
  }

  // ── 9.5. 컨센서스 기반 매수 필터 — 하락세 종목 매수 차단 ──────────
  {
    const { getConsensusTrend } = await import('../../market/consensus.js');
    for (const d of decisions) {
      if (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') {
        const signal = getConsensusTrend(d.stock_code);
        if (signal?.trend === 'BEARISH') {
          logger.info(
            `🐻 컨센서스 하락세 매수 차단: ${d.stock_code} ${signal.name} (하향${signal.downgradeCount} 상향${signal.upgradeCount})`,
            { component: 'CONSENSUS' },
          );
          d.action = 'HOLD';
          d.reasoning = `[컨센서스 하락세] ${d.reasoning}`;
        } else if (signal?.trend === 'BULLISH' && d.confidence) {
          d.confidence = Math.min(1.0, d.confidence + 0.05);
          d.reasoning = `[컨센서스 상승세↑] ${d.reasoning}`;
        }
      }
    }
  }

  // ── 9.6. 실적발표 7일 매수 차단 — 어닝스 변동성 회피 ──────────────
  {
    const { checkKrEarnings } = await import('../../automation/earnings-sentinel.js');
    const earningsBlocked: string[] = [];
    for (const d of decisions) {
      if (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') {
        const er = await checkKrEarnings(d.stock_code);
        if (er.hasUpcomingEarnings) {
          earningsBlocked.push(`${d.stock_code}(D-${er.daysUntil})`);
          d.action = 'HOLD';
          d.reasoning = `[실적발표 D-${er.daysUntil}일 차단] ${d.reasoning}`;
        }
      }
    }
    if (earningsBlocked.length > 0) {
      logger.info(`📅 실적발표 매수차단: ${earningsBlocked.join(', ')}`, { component: 'EARNINGS_SENTINEL' });
    }
  }

  // ── 9.7. 골든아워 타이밍 보너스 — 최적 진입 시간대 확신도 부스트 ──────
  {
    const kstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
    const kstMin = new Date(Date.now() + 9 * 3600_000).getUTCMinutes();
    const kstTime = kstHour + kstMin / 60;
    // 09:00-09:30 개장 모멘텀 (가장 강한 방향성)
    // 13:00-14:00 오후장 추세 확인 (점심 이후 재시작 모멘텀)
    let timeBonus = 0;
    let timeLabel = '';
    if (kstTime >= 9.0 && kstTime < 9.5) {
      timeBonus = 0.05; timeLabel = '개장모멘텀';
    } else if (kstTime >= 13.0 && kstTime < 14.0) {
      timeBonus = 0.03; timeLabel = '오후추세';
    } else if (kstTime >= 14.5 && kstTime < 15.0) {
      // 14:30-15:00 마감 전 — 약간의 페널티 (마감 직전 진입 리스크)
      timeBonus = -0.02; timeLabel = '마감임박';
    }
    if (timeBonus !== 0) {
      for (const d of decisions) {
        if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && d.confidence) {
          d.confidence = Math.min(1.0, Math.max(0.1, d.confidence + timeBonus));
          d.reasoning = `[${timeLabel}${timeBonus > 0 ? '+' : ''}${Math.round(timeBonus * 100)}%] ${d.reasoning}`;
        }
      }
    }
  }

  // ── 9.8. 인버스 ETF 결정 재주입 (필터 우회 — crash-profit 전략 보호) ──
  if (inverseDecisions.length > 0) {
    decisions.unshift(...inverseDecisions);
  }

  // ── 10. 최종 필터: HOLD 제거 + 가격 검증 + 실행 순서 정렬 ──────────
  const filtered = decisions.filter((d) => {
    if (d.action === 'HOLD') return false;
    if (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') {
      const hasPrice = (d.limit_price ?? 0) > 0;
      if (!hasPrice) logger.warn(`가격 없는 BUY 제외: ${d.stock_code}`, { component: 'DECISION_FLOW' });
      return hasPrice;
    }
    return true;
  });

  const scoreMap = new Map(scores.map((s) => [s.stock_code, Number(s.composite_score ?? 0)]));
  const actionOrder = (d: TradeDecision) => {
    // 인버스 ETF / CRASH_PROFIT 결정은 최우선
    if (INVERSE_ETF_CODES.has(d.stock_code)) return -2;
    if (d.trigger_source?.startsWith('CRASH_PROFIT')) return -1;
    return d.action === 'SELL' || d.action === 'FORCE_CLOSE' || d.action === 'PARTIAL_SELL'
      ? 0
      : d.action === 'AVERAGE_DOWN'
        ? 1
        : 2;
  };
  filtered.sort((a, b) => {
    const orderDiff = actionOrder(a) - actionOrder(b);
    if (orderDiff !== 0) return orderDiff;
    return (scoreMap.get(b.stock_code) ?? 0) - (scoreMap.get(a.stock_code) ?? 0);
  });

  return filtered;
}
