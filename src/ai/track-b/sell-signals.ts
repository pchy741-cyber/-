import { analyzeTechnicals } from '../../analysis/indicators.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import type { TradeDecision } from '../../db/models.js';
import { logger } from '../../utils/logger.js';
import { type TechnicalFallbackParams, resolveStrategyParams, getKstScalpTime, buildAiScoreMap } from './technical-fallback-types.js';
import { getOverride } from '../ai-overrides.js';

// TP 도달 전 수익권 포지션 최고 수익률 추적 (서버 재시작 시 리셋 — 허용)
const _preTpPeakMap = new Map<string, number>(); // stock_code → peak pnlPct

// 자기학습 TP/SL 캐시 (3분 TTL — 매 사이클 DB 조회 방지)
let _learnedCache: { tp?: number; sl?: number; expiresAt: number } | null = null;
async function _getLearnedTpSl(): Promise<{ tp?: number; sl?: number } | null> {
  if (_learnedCache && Date.now() < _learnedCache.expiresAt) return _learnedCache;
  try {
    const { getPool } = await import('../../db/client.js');
    const { getCtxIsPaper } = await import('../../config/context.js');
    const { rows } = await getPool().query(
      `SELECT take_profit_pct::float, stop_loss_pct::float FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
      [getCtxIsPaper()],
    );
    const r = rows[0];
    _learnedCache = { tp: r?.take_profit_pct, sl: r?.stop_loss_pct, expiresAt: Date.now() + 180_000 };
    return _learnedCache;
  } catch { return null; }
}

/**
 * 보유 종목 매도 판단 (손절/익절/강제청산/기술매도)
 */
export async function generateSellDecisions(params: TechnicalFallbackParams): Promise<TradeDecision[]> {
  const { mode, livePrices, chartData, openChains, junkStockCodes, totalAssets, marketSignals } = params;
  const strategyParams = resolveStrategyParams(mode, params);
  const aiScoreMap = buildAiScoreMap(params.aiScores);
  const { h: _scalpH, m: _scalpM, isPastScalpDeadline } = getKstScalpTime();
  const decisions: TradeDecision[] = [];

  // 포트폴리오 전체 PnL 계산 (급락 보호용 — 매 사이클 1회)
  let _portfolioCost = 0;
  let _portfolioValue = 0;
  for (const c of openChains) {
    const p = livePrices.get(c.stock_code);
    if (!p || !c.avg_buy_price) continue;
    _portfolioCost += Number(c.avg_buy_price) * c.total_quantity;
    _portfolioValue += p.currentPrice * c.total_quantity;
  }
  const portfolioPnlPct = _portfolioCost > 0
    ? ((_portfolioValue - _portfolioCost) / _portfolioCost) * 100
    : 0;

  // 하락장 레짐: 분할매도 금지 → 전량 즉시 청산 (단계별 추가 손실 방지)
  const isDowntrendMode = (params.macroSizingMult ?? 1.0) < 0.8;

  // 1. 보유 종목 매도 판단 (손절/익절)
  // 동일 종목에 다중 체인(분할 매수)이 있을 경우 중복 매도 신호 방지
  const processedSellCodes = new Set<string>();
  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 동일 종목 중복 매도 신호 방지 (다중 체인 시 첫 번째 체인만 처리)
    if (processedSellCodes.has(chain.stock_code)) continue;

    // ── 포트폴리오 수익 보호: 하락장 감지 시 수익권 종목 선제 청산 ──
    // 포트폴리오 전체 수익 +2% 이상 + RISK_OFF/하락장(macroSizingMult<0.8) + 이 종목 수익권
    // → 개별 TP 미도달이라도 즉시 청산 (수익 반납 방지)
    if (
      portfolioPnlPct >= 2.0 &&
      (params.macroSizingMult ?? 1.0) < 0.8 &&
      pnlPct >= 0.5 &&
      chain.total_quantity > 0
    ) {
      decisions.push({
        action: 'SELL',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `포트폴리오 수익보호(포트폴리오 +${portfolioPnlPct.toFixed(1)}%/하락장레짐): 수익 +${pnlPct.toFixed(1)}% → 급락전 선제청산`,
        confidence: 0.88,
      });
      processedSellCodes.add(chain.stock_code);
      _preTpPeakMap.delete(chain.stock_code);
      continue;
    }
    // ────────────────────────────────────────────────────────────────────

    // ── TP 도달 전 수익 구간 트레일링 스탑 ──────────────────────────────
    // 기존 트레일링은 PROFIT_TAKING 진입 후에만 작동 → +2~4% 수익권은 보호 없음
    // 이 로직: TP 미도달이라도 고점 대비 ATR×1.5 하락 시 익절
    if (chain.status !== 'PROFIT_TAKING' && chain.strategy_mode !== 'SCALPING') {
      const prevPeak = _preTpPeakMap.get(chain.stock_code) ?? pnlPct;
      const curPeak = Math.max(prevPeak, pnlPct);
      _preTpPeakMap.set(chain.stock_code, curPeak);

      if (curPeak >= 1.5) {
        const earlyChart = chartData.get(chain.stock_code);
        const earlyTech = earlyChart && earlyChart.length >= 20 ? analyzeTechnicals(earlyChart) : null;
        const atrPct = earlyTech?.atrPct ?? 1.5;
        const trailThreshold = Math.max(-(atrPct * 1.5), -3.0); // ATR×1.5, 최대 -3%
        const dropFromPeak = pnlPct - curPeak;

        if (dropFromPeak <= trailThreshold && chain.total_quantity > 0) {
          logger.info(
            `📉 Pre-TP 트레일링: ${chain.stock_code} 고점 +${curPeak.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}% (${dropFromPeak.toFixed(1)}%, 임계 ${trailThreshold.toFixed(1)}%)`,
            { component: 'TRACK_B' },
          );
          decisions.push({
            action: 'SELL',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `수익보호 트레일링(TP전): 고점 +${curPeak.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}% (고점대비 ${dropFromPeak.toFixed(1)}%)`,
            confidence: 0.88,
          });
          processedSellCodes.add(chain.stock_code);
          _preTpPeakMap.delete(chain.stock_code);
          continue;
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // AI Loop forceHold: Claude Code가 매도 보류 지시 (실적 발표 대기 등)
    const aiForceHold = getOverride<boolean>(`${chain.stock_code}_forceHold`);
    if (aiForceHold && pnlPct > -5) {  // 손절 한도(-5%) 이상이면 AI 홀드 존중
      logger.info(`🤖 AI Loop forceHold: ${chain.stock_code} 매도 보류 (pnl=${pnlPct.toFixed(1)}%)`, { component: 'AI_LOOP' });
      processedSellCodes.add(chain.stock_code);
      continue;
    }
    // AI Loop forceSell: Claude Code가 즉시 매도 지시
    const aiForceSell = getOverride<boolean>(`${chain.stock_code}_forceSell`);
    if (aiForceSell) {
      decisions.push({
        action: 'SELL',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `🤖 AI Loop 강제매도 (pnl=${pnlPct.toFixed(1)}%)`,
        confidence: 0.95,
      });
      processedSellCodes.add(chain.stock_code);
      continue;
    }

    // SCALPING 강제청산: 진입 후 60분 또는 고정 10:00 중 이른 시각 (ScalpRadar 장중 진입 대응)
    if (chain.strategy_mode === 'SCALPING' && chain.total_quantity > 0) {
      const nowMs = Date.now();
      const openedMs = chain.opened_at ? new Date(chain.opened_at).getTime() : 0;
      const dynamicDeadlineMs = openedMs > 0 ? openedMs + 60 * 60_000 : 0; // 진입+60분
      // 장 마감 15:15 하드 데드라인
      const kstNow = new Date(nowMs + 9 * 60 * 60_000);
      const todayDate = kstNow.toISOString().split('T')[0];
      const hardDeadlineMs = new Date(`${todayDate}T15:15:00+09:00`).getTime();
      // 기존 10:00 고정 데드라인 (개장벨 진입 호환)
      const fixedDeadlineMs = isPastScalpDeadline ? nowMs - 1 : Infinity;
      const effectiveDeadlineMs = Math.min(dynamicDeadlineMs || Infinity, hardDeadlineMs, fixedDeadlineMs);

      if (nowMs >= effectiveDeadlineMs) {
        const elapsedMin = openedMs > 0 ? Math.round((nowMs - openedMs) / 60_000) : 0;
        decisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `SCALPING 강제청산(${elapsedMin}분 경과): 윈도우 종료, 전량 청산 (${pnlPct.toFixed(1)}%)`,
          confidence: 1.0,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }

    // BREAKOUT 전용 매도: Williams 변동성 돌파 → 익일 시가 매도 (09:00~09:10)
    if (chain.strategy_mode === 'BREAKOUT' && chain.total_quantity > 0) {
      const triggerSrc = (chain as Record<string, unknown>).trigger_source as string | undefined;
      const isWilliams = triggerSrc?.includes('WILLIAMS') ?? false;

      if (isWilliams) {
        const nowMs = Date.now();
        const openedMs = chain.opened_at ? new Date(chain.opened_at).getTime() : 0;
        const holdingDays = openedMs > 0 ? Math.floor((nowMs - openedMs) / (24 * 60 * 60_000)) : 0;
        const { h: wH, m: wM } = getKstScalpTime();

        // 익일 09:00~09:10 기계적 매도 (Williams 원칙: 하루만 보유)
        if (holdingDays >= 1 && wH === 9 && wM <= 10) {
          decisions.push({
            action: 'SELL',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `BREAKOUT/Williams next-day sell: ${holdingDays}d held, pnl=${pnlPct.toFixed(1)}%`,
            confidence: 1.0,
          });
          processedSellCodes.add(chain.stock_code);
          continue;
        }
      }
      // BREAKOUT 비-Williams: 기존 TP/SL 로직 그대로 (SL=-5%, TP=+8%)
      // → 아래 일반 매도 로직에서 strategy_mode별 파라미터로 처리됨
    }

    // 외국인+기관 동반 이탈(STRONG_SELL 수급) 보유 종목
    // 하락장: 전량 즉시 청산 / 정상장: 50% 부분 매도
    if (junkStockCodes?.has(chain.stock_code) && chain.total_quantity > 0) {
      if (isDowntrendMode) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `외국인+기관 동반이탈(하락장): 전량 즉시 청산 → 추가 손실 방지`,
          confidence: 0.90,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
      const partialQty = Math.ceil(chain.total_quantity * 0.5);
      if (partialQty > 0 && partialQty < chain.total_quantity) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: partialQty,
          price_type: 'MARKET',
          reasoning: `외국인+기관 동반이탈(STRONG_SELL): 보유 50% 부분매도 → 수급 리스크 축소`,
          confidence: 0.85,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
      decisions.push({
        action: 'SELL',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `외국인+기관 동반이탈(STRONG_SELL): 분할불가 전량매도 → 수급 리스크 차단`,
        confidence: 0.85,
      });
      processedSellCodes.add(chain.stock_code);
      continue;
    }

    // 마감 근접 수익 확정 — 3단계: 충분한 수익만, 그다음 소폭, 마지막에 손익분기만 확정
    // 15:00~15:10: 1.0%+ 수익만 청산 | 15:10~15:20: 0.3%+ | 15:20~15:25: 0%+ (진짜 마감 직전)
    const isNearClose = _scalpH === 15 && _scalpM < 25;
    if (isNearClose && chain.strategy_mode !== 'SCALPING' && chain.total_quantity > 0) {
      const closeThreshold = _scalpM >= 20 ? 0.0 : _scalpM >= 10 ? 0.3 : 1.0;
      const closeLabel = _scalpM >= 20 ? '15:20+' : _scalpM >= 10 ? '15:10+' : '15:00+';
      if (pnlPct >= closeThreshold) {
        logger.info(
          `⏰ 마감전 수익확정: ${chain.stock_code} +${pnlPct.toFixed(1)}% (${closeLabel} 임계값 ${closeThreshold}%)`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `마감전 수익확정(${closeLabel}): +${pnlPct.toFixed(1)}% → 장마감 손실 방지`,
          confidence: 0.92,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }

    const isScalpChain = chain.strategy_mode === 'SCALPING';
    const rawAiScore = aiScoreMap.get(chain.stock_code) ?? 0;
    const realtimeAiScore = Number.isFinite(rawAiScore) ? rawAiScore : 0;

    // ── 실시간 다팩터 동적 TP/SL (해외 calcDynamicTpSl과 동등) ──
    // 매 사이클마다 현재 기술지표로 재계산 (진입 시점 고정값 X)
    let effectiveTp: number;
    let effectiveSl: number;

    if (!isScalpChain) {
      const holdingChart = chartData.get(chain.stock_code);
      const holdTech = holdingChart && holdingChart.length >= 20
        ? analyzeTechnicals(holdingChart) : null;

      const { getDynamicDomesticTpSl } = await import('../../config/constants.js');
      // 자기학습 TP/SL 로드 (캐시 3분 — 매 사이클 DB 조회 방지)
      const learned = await _getLearnedTpSl();
      // 종목별 수급 데이터 (외국인/기관 순매수 여부)
      const sig = marketSignals?.get(chain.stock_code);
      const dyn = getDynamicDomesticTpSl({
        score: realtimeAiScore > 0 ? realtimeAiScore : (Number(chain.target_profit_pct) >= 8 ? 88 : 80),
        rsi: holdTech?.rsi14,
        adx: holdTech?.adx14,
        atrPct: holdTech?.atrPct,
        isMomentum: holdTech ? (holdTech.sma5 > holdTech.sma20 && holdTech.adx14 > 22) : false,
        foreignNetBuy: sig ? (sig as any).foreignNetBuy === true : undefined,
        institutionNetBuy: sig ? (sig as any).institutionNetBuy === true : undefined,
        learnedTp: learned?.tp,
        learnedSl: learned?.sl,
      });

      // chain TP = CEO 설정 상한선 (dynTp가 더 높아도 chain TP 초과 금지)
      // SL = 더 타이트한 쪽 (손실 최소화)
      const chainTp = chain.target_profit_pct ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.takeProfitPct ?? 7;
      const chainSl = chain.stop_loss_pct ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.stopLossPct ?? -3;
      effectiveTp = Math.min(Number(chainTp), dyn.takeProfitPct); // chain TP 상한 — 설정값 초과 방지
      effectiveSl = Math.min(Number(chainSl), dyn.stopLossPct);   // 더 타이트한 SL

      // AI 약세 전환 + 수익 구간 → 빠른 수익 확정
      if (realtimeAiScore > 0 && realtimeAiScore < 55 && pnlPct > 1.0) {
        effectiveTp = Math.min(effectiveTp, Math.max(pnlPct - 0.5, 1.0));
      }
    } else {
      // SCALPING은 고정 TP/SL
      effectiveTp = STRATEGY_PARAMS.SCALPING.takeProfitPct;
      effectiveSl = STRATEGY_PARAMS.SCALPING.stopLossPct;
    }

    // ─── 3단계 익절 전략 ────────────────────────────────────────────────
    // 1단계: TP 도달 → 25% 부분 매도 (수익 확정, 상태→PROFIT_TAKING)
    // 2단계: TP+3% 도달 → 추가 35% 매도 (잔여 ~40%)
    // 3단계: 트레일링 스톱 또는 TP+8% → 잔여 전량 청산
    // 효과: 수익 꼬리 길게 잡기 + 반납 최소화
    if (chain.status !== 'PROFIT_TAKING' && pnlPct >= effectiveTp) {
      // SCALPING: 전량 즉시 익절 (takeProfitRatio=1.0, 분할 없음)
      if (isScalpChain && chain.total_quantity > 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `SCALPING 익절(전량): +${pnlPct.toFixed(1)}% (목표 ${effectiveTp}%)`,
          confidence: 0.95,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
      // 1단계: 첫 익절 — 하락장이면 전량, 정상장이면 35% 부분 매도
      if (isDowntrendMode && chain.total_quantity > 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `하락장 익절(전량): +${pnlPct.toFixed(1)}% 도달 (목표 ${effectiveTp.toFixed(1)}%) → 분할 없이 즉시 청산`,
          confidence: 0.92,
        });
        processedSellCodes.add(chain.stock_code);
        _preTpPeakMap.delete(chain.stock_code);
        continue;
      }
      const sellQty = Math.ceil(chain.total_quantity * 0.35);
      if (sellQty > 0 && sellQty < chain.total_quantity) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: sellQty,
          price_type: 'MARKET',
          reasoning: `1단계 익절(35%): +${pnlPct.toFixed(1)}% 도달 (목표 ${effectiveTp.toFixed(1)}% AI${realtimeAiScore}점) → 나머지 65% 트레일링 대기`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
      // 수량 1주 등 분할 불가 → 전량 익절
      if (chain.total_quantity > 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `기술적 익절(전량): +${pnlPct.toFixed(1)}% (목표 ${effectiveTp}%)`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }

    // 차트 지표 (트레일링 스톱 + 손절 공통 사용)
    const sellCheckCandles = chartData.get(chain.stock_code);
    const sellTech = sellCheckCandles && sellCheckCandles.length >= 30 ? analyzeTechnicals(sellCheckCandles) : null;

    // 2~3단계: PROFIT_TAKING 상태에서 추가 익절 + 트레일링 스톱
    if (chain.status === 'PROFIT_TAKING') {
      // peak_price가 DB에 없으면 트레일링 기준 없음 → 손실 구간에서 오발동 방지
      if (!(chain as any).peak_price && pnlPct < 0) {
        if (pnlPct <= -1.0) {
          decisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `브레이크이븐스톱(peak없음): ${pnlPct.toFixed(1)}%`,
            confidence: 0.9,
          });
          processedSellCodes.add(chain.stock_code);
        }
        continue;
      }

      // 2단계: TP+3% 도달 → 추가 35% 매도 (아직 잔여량 많으면)
      // 원래 수량 대비 현재 보유가 60%+ 남아있으면 아직 2단계 미실행
      const origQty = (chain as any).original_quantity ?? chain.total_quantity;
      const remainRatio = origQty > 0 ? chain.total_quantity / origQty : 1;
      if (remainRatio > 0.6 && pnlPct >= effectiveTp + 3.0) {
        const sellQty2 = Math.ceil(chain.total_quantity * 0.47); // 잔여의 ~47% (전체의 ~35%)
        if (sellQty2 > 0 && sellQty2 < chain.total_quantity) {
          decisions.push({
            action: 'PARTIAL_SELL',
            stock_code: chain.stock_code,
            quantity: sellQty2,
            price_type: 'MARKET',
            reasoning: `2단계 익절(35%): +${pnlPct.toFixed(1)}% (TP+3% 달성) → 잔여 ${chain.total_quantity - sellQty2}주 트레일링`,
            confidence: 0.9,
          });
          processedSellCodes.add(chain.stock_code);
          continue;
        }
      }

      // 3단계: 트레일링 스톱 또는 최종 목표(+8%) → 잔여 전량 청산
      const peakPrice = (chain as any).peak_price ? Number((chain as any).peak_price) : Number(chain.avg_buy_price) * (1 + strategyParams.takeProfitPct / 100);
      const trailDropPct = ((price.currentPrice - peakPrice) / peakPrice) * 100;
      const trailAtrPct = sellTech?.atrPct ?? 1.5;
      const baseTrailPct = Math.max(-5.0, Math.min(-1.5, -(trailAtrPct * 2.0)));
      const profitTightenDom = pnlPct >= 8 ? 0.5 : pnlPct >= 5 ? 0.3 : 0;
      const aiTrailTighten = getOverride<number>(`${chain.stock_code}_trailTighten`) ?? 0;
      const dynamicTrailPct = baseTrailPct + profitTightenDom + aiTrailTighten;
      const isTrailTriggered = trailDropPct <= dynamicTrailPct;
      const isTargetReached = pnlPct >= 8.0; // 3단계: +8% 최종 목표 (기존 5% → 8%로 상향)

      if (isTargetReached || isTrailTriggered) {
        decisions.push({
          action: isTargetReached ? 'SELL' : 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: isTargetReached
            ? `3단계 익절(잔여전량): +${pnlPct.toFixed(1)}% 최종목표 달성`
            : `트레일링 스톱: peak 대비 ${trailDropPct.toFixed(2)}% 하락 (ATR ${dynamicTrailPct.toFixed(1)}%, peak=${peakPrice.toFixed(0)}원)`,
          confidence: 0.9,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // ── 모멘텀 가드: 진입 직후 기술지표 반전 → SL 타이트닝 ────────────
    // 진입 후 10분 이내 MACD/RSI 꺾이면 모멘텀 소진 가능성 높음 → SL -2%로 축소
    if (chain.opened_at && sellTech && !isScalpChain && chain.status !== 'PROFIT_TAKING') {
      const holdingMin = (Date.now() - new Date(chain.opened_at).getTime()) / 60_000;
      if (holdingMin <= 10) {
        const macdBearish = sellTech.macdCrossover === 'BEARISH';
        const rsiFading = sellTech.rsi14 < 45; // 진입 시 50+ 기대, 45 미만으로 급락
        if (macdBearish || rsiFading) {
          const guardSl = -2.0;
          if (effectiveSl < guardSl) {
            logger.info(
              `⚡ 모멘텀가드: ${chain.stock_code} ${holdingMin.toFixed(0)}분 보유 — ${macdBearish ? 'MACD↓' : ''}${rsiFading ? `RSI${sellTech.rsi14.toFixed(0)}` : ''} → SL ${effectiveSl.toFixed(1)}%→${guardSl}%`,
              { component: 'TRACK_B' },
            );
            effectiveSl = guardSl;
          }
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // ── 데드머니 탈출: 장기 보유 저성과 종목 현금 재배치 ──────────────
    // SCALPING/PROFIT_TAKING 예외 — 이미 별도 청산 로직 존재
    if (chain.strategy_mode !== 'SCALPING' && chain.status !== 'PROFIT_TAKING' && chain.opened_at) {
      const holdingDays = Math.floor((Date.now() - new Date(chain.opened_at).getTime()) / (24 * 60 * 60_000));

      // 6일+ 보유 + 수익 < 1.5% → 모멘텀 부족, 현금 재배치 (8일→6일, 2%→1.5% 강화)
      if (holdingDays >= 6 && pnlPct < 1.5 && pnlPct >= 0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `데드머니탈출(${holdingDays}일 보유 +${pnlPct.toFixed(1)}%<1.5%): 모멘텀 부족 → 현금 재배치`,
          confidence: 0.80,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }

      // 4일+ 보유 + PnL ±0.8% 이내 → 기회비용 청산 (5일→4일, ±1%→±0.8% 강화)
      if (holdingDays >= 4 && Math.abs(pnlPct) <= 0.8) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `데드머니탈출(${holdingDays}일 보유 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%): 기회비용 청산`,
          confidence: 0.75,
        });
        processedSellCodes.add(chain.stock_code);
        continue;
      }

      // 3일+ 보유 + 손실 > 1% → 손절선 타이트닝 (pnlPct - 0.5%)
      if (holdingDays >= 3 && pnlPct < -1.0) {
        const tightenedSl = pnlPct - 0.5;
        // 체인 SL이 타이트닝보다 넓으면 → 좁힌 SL로 교체 (즉시 청산은 아니고, 기존 SL 대신 적용)
        const chainSlRef = chain.stop_loss_pct ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.stopLossPct ?? -3;
        if (Number(chainSlRef) < tightenedSl) {
          // 타이트닝된 SL이 현재 손실보다 이미 넓으면 즉시 청산
          logger.info(
            `⏰ 데드머니 타이트닝: ${chain.stock_code} ${holdingDays}일 보유 ${pnlPct.toFixed(1)}% → SL ${tightenedSl.toFixed(1)}% (기존 ${Number(chainSlRef).toFixed(1)}%)`,
            { component: 'TRACK_B' },
          );
          // effectiveSl을 타이트닝 값으로 교체 — 아래 손절 로직에서 사용됨
          effectiveSl = tightenedSl;
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // 손절 (ATR 동적 손절 vs 전략 고정 손절 — 더 보수적인 쪽 적용)
    const dynamicStop = sellTech ? sellTech.dynamicStopLossPct : effectiveSl;
    // AI 80점+ 고확신 종목은 손절 기준 1.2배 넓히기 (일시적 노이즈로 조기손절 방지)
    const stopWidenMultiplier = realtimeAiScore >= 80 ? 1.2 : 1.0;
    // 시그널 보정: 체결강도 < 80(매도세 압도) → 손절 타이트닝 (0.85x), 체결강도 > 120(매수세) → 1.1x 완화
    const sigIntensity = marketSignals?.get(chain.stock_code)?.tradingIntensity?.intensity ?? 0;
    const signalStopMult = sigIntensity > 0
      ? (sigIntensity < 80 ? 0.85 : sigIntensity >= 120 ? 1.10 : 1.0)
      : 1.0;
    const effectiveStop = Math.min(effectiveSl, dynamicStop) * stopWidenMultiplier * signalStopMult;
    if (pnlPct <= effectiveStop) {
      // v4: 패닉매도 억제 & 대형포지션 부분손절 폐지
      // 이전: RSI<35+거래량급증 시 손절 스킵, 대형포지션 50% 부분손절 → 나머지 50% 추가 하락 → 손실 확대
      // 변경: SL 도달 → 무조건 전량 청산 (예외 없음)
      // 원칙: 손절은 보험이다. 보험금을 깎으면 안 된다.
      decisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `손절: ${pnlPct.toFixed(1)}% (ATR동적=${dynamicStop.toFixed(1)}% 기준=${effectiveSl.toFixed(1)}% AI${realtimeAiScore}점)`,
        confidence: 0.95,
      });
      processedSellCodes.add(chain.stock_code);
      continue;
    }

    // 기술적 지표 기반 매도 판단 (대형 포지션은 STRONG_SELL도 완화)
    const candles = chartData.get(chain.stock_code);
    if (candles && candles.length >= 60) {
      const tech = analyzeTechnicals(candles);
      if (tech && tech.overallSignal === 'STRONG_SELL') {
        const positionValueSell = price.currentPrice * Number(chain.total_quantity);
        const positionWeightSell = (totalAssets ?? 0) > 0 ? positionValueSell / totalAssets! : 0;
        // 대형 포지션(8% 이상) + STRONG_SELL: 전량 매도 대신 30% 부분 매도
        if (positionWeightSell >= 0.08) {
          const partialQty = Math.ceil(Number(chain.total_quantity) * 0.3);
          if (partialQty > 0 && partialQty < Number(chain.total_quantity)) {
            decisions.push({
              action: 'PARTIAL_SELL',
              stock_code: chain.stock_code,
              quantity: partialQty,
              price_type: 'MARKET',
              reasoning: `대형포지션 기술적 부분매도(30%): STRONG_SELL | RSI=${tech.rsi14.toFixed(0)} MACD=${tech.macdCrossover} | 나머지 70% 추가 확인 후 판단`,
              confidence: 0.65,
            });
            processedSellCodes.add(chain.stock_code);
          }
        } else {
          decisions.push({
            action: 'SELL',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `기술적 매도: RSI=${tech.rsi14.toFixed(0)} MACD=${tech.macdCrossover} score=${tech.score}`,
            confidence: 0.7,
          });
          processedSellCodes.add(chain.stock_code);
        }
      }
    }
  }

  return decisions;
}
