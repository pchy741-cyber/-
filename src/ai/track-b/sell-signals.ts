import { analyzeTechnicals } from '../../analysis/indicators.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getTimeWeightedStop } from '../../risk/entry-timing-guard.js';
import { logger } from '../../utils/logger.js';
import { getOverride } from '../ai-overrides.js';
import {
  buildAiScoreMap,
  getKstScalpTime,
  resolveStrategyParams,
  type TechnicalFallbackParams,
} from './technical-fallback-types.js';

// TP 도달 전 수익권 포지션 최고 수익률 추적
// 서버 재시작 시 DB peak_price_since_open에서 복원 (restorePreTpPeakMap 호출)
// Paper/Live 분리: 모드별 독립 맵 (크로스오염 방지)
const _preTpPeakMap = new Map<string, Map<string, number>>(); // 'paper'|'live' → stock_code → peak pnlPct
function _getPeakMap(): Map<string, number> {
  const key = getCtxIsPaper() ? 'paper' : 'live';
  if (!_preTpPeakMap.has(key)) _preTpPeakMap.set(key, new Map());
  return _preTpPeakMap.get(key)!;
}

/** 서버 부팅 시 DB 오픈 체인의 peak_price_since_open → _preTpPeakMap 복원 */
export function restorePreTpPeakMap(
  chains: Array<{ stock_code: string; avg_buy_price: number | string | null; peak_price_since_open?: number | null }>,
): void {
  // 부팅 시에는 ALS 컨텍스트 없으므로 live 맵에 직접 복원
  if (!_preTpPeakMap.has('live')) _preTpPeakMap.set('live', new Map());
  const liveMap = _preTpPeakMap.get('live')!;
  for (const c of chains) {
    const avg = Number(c.avg_buy_price ?? 0);
    const peak = Number(c.peak_price_since_open ?? 0);
    if (avg > 0 && peak > 0) {
      const peakPnlPct = ((peak - avg) / avg) * 100;
      if (peakPnlPct > 0) {
        liveMap.set(c.stock_code, peakPnlPct);
      }
    }
  }
  if (liveMap.size > 0) {
    logger.info(`📈 Pre-TP peak 복원: ${liveMap.size}종목 (${[...liveMap.entries()].map(([k, v]) => `${k}:+${v.toFixed(1)}%`).join(', ')})`, { component: 'TRACK_B' });
  }
}

// CEO 지시 (2026-06-12): STRONG_SELL 분할매도 쿨다운
//   Why: 한화비전 사례 — 같은 종목 14건 분할매도, 회당 수수료 0.195% 누적
//   How: 종목별 마지막 STRONG_SELL 시각 기록, 15분 내 중복 매도 신호 차단
// Paper/Live 분리: 모드별 독립 쿨다운 (크로스오염 방지)
const _strongSellCooldownMap = new Map<string, Map<string, number>>(); // 'paper'|'live' → stock_code → lastFireMs
function _getStrongSellCooldown(): Map<string, number> {
  const key = getCtxIsPaper() ? 'paper' : 'live';
  if (!_strongSellCooldownMap.has(key)) _strongSellCooldownMap.set(key, new Map());
  return _strongSellCooldownMap.get(key)!;
}
const STRONG_SELL_COOLDOWN_MS = 15 * 60_000;

// 자기학습 TP/SL 캐시 (3분 TTL — 매 사이클 DB 조회 방지)
// Paper/Live 분리: 모드별 독립 캐시 (크로스오염 방지)
const _learnedCacheMap = new Map<string, { tp?: number; sl?: number; expiresAt: number }>();
async function _getLearnedTpSl(): Promise<{ tp?: number; sl?: number } | null> {
  const isPaper = getCtxIsPaper();
  const cacheKey = isPaper ? 'paper' : 'live';
  const cached = _learnedCacheMap.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached;
  try {
    const { getPool } = await import('../../db/client.js');
    const { rows } = await getPool().query(
      `SELECT take_profit_pct::float, stop_loss_pct::float FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
      [isPaper],
    );
    const r = rows[0];
    const entry = { tp: r?.take_profit_pct, sl: r?.stop_loss_pct, expiresAt: Date.now() + 180_000 };
    _learnedCacheMap.set(cacheKey, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * 보유 종목 매도 판단 (손절/익절/강제청산/기술매도)
 */
export async function generateSellDecisions(params: TechnicalFallbackParams): Promise<TradeDecision[]> {
  const { mode, livePrices, chartData, openChains, junkStockCodes, totalAssets, marketSignals } = params;
  const strategyParams = resolveStrategyParams(mode, params);
  const aiScoreMap = buildAiScoreMap(params.aiScores);
  const { h: _scalpH, m: _scalpM } = getKstScalpTime();
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
  const portfolioPnlPct = _portfolioCost > 0 ? ((_portfolioValue - _portfolioCost) / _portfolioCost) * 100 : 0;

  // 하락장 레짐: 분할매도 금지 → 전량 즉시 청산 (단계별 추가 손실 방지)
  const isDowntrendMode = (params.macroSizingMult ?? 1.0) < 0.8;

  // 1. 보유 종목 매도 판단 (손절/익절)
  // 각 체인은 독립 평가 — 같은 종목이라도 avg_buy_price/strategy가 다를 수 있음
  const processedSellChains = new Set<string>(); // chain.id 기반 중복 방지
  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) continue;

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 이미 이 체인에 대해 결정이 내려졌으면 스킵
    if (processedSellChains.has(chain.id)) continue;

    // ── BreakEvenGuard: +1.5% 도달 시 SL → 본절(0%)로 자동 상향 ────────────
    // pnl +1.5% 도달 순간 기존 SL(예: -3%)을 0%로 이동 → 원금 손실 방지
    if (
      chain.strategy_mode !== 'SCALPING' &&
      chain.status !== 'PROFIT_TAKING' &&
      pnlPct >= 1.5 &&
      chain.stop_loss_pct != null &&
      Number(chain.stop_loss_pct) < 0
    ) {
      try {
        await getPool().query(
          `UPDATE transaction_chains SET stop_loss_pct = 0 WHERE id = $1 AND stop_loss_pct < 0`,
          [chain.id],
        );
        (chain as any).stop_loss_pct = 0;
        logger.info(
          `🛡️ BreakEvenGuard: ${chain.stock_code} SL → 0%(본절) [pnl +${pnlPct.toFixed(1)}%]`,
          { component: 'TRACK_B' },
        );
      } catch (e) {
        logger.warn(`BreakEvenGuard DB 실패 (${chain.stock_code}): ${(e as Error).message}`, { component: 'TRACK_B' });
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // ── 포트폴리오 수익 보호: 하락장 감지 시 수익권 종목 선제 청산 ──
    // 포트폴리오 전체 수익 +2% 이상 + RISK_OFF/하락장(macroSizingMult<0.8) + 이 종목 수익권
    // → 개별 TP 미도달이라도 즉시 청산 (수익 반납 방지)
    // v10.3: 개별 종목 최소 +2.0% 이상만 선제 청산 (기존 +0.5%는 수수료 차감 후 실질 손실)
    if (portfolioPnlPct >= 2.0 && (params.macroSizingMult ?? 1.0) < 0.8 && pnlPct >= 2.0 && chain.total_quantity > 0) {
      decisions.push({
        action: 'SELL',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `포트폴리오 수익보호(포트폴리오 +${portfolioPnlPct.toFixed(1)}%/하락장레짐): 수익 +${pnlPct.toFixed(1)}% → 급락전 선제청산`,
        confidence: 0.88,
      });
      processedSellChains.add(chain.id);
      _getPeakMap().delete(chain.stock_code);
      continue;
    }
    // ────────────────────────────────────────────────────────────────────

    // ── v12: 비-초대형주 BREAKOUT/눌림 반전매도 ────────────────────────────
    // CEO 지시 (2026-06-17): 국내 비초대형주 돌파/눌림매매에서 수익권→반전 시 즉시 탈출
    //   Why: 수익권이었다가 다같이 마이너스 — 물려서 손해보는 구조가 많음
    //   How: peak +1.5% 이상 도달 후 RSI+MA20 기반으로 반전 강도 판단, 전량 또는 60% 매도
    //        초대형주(삼성전자 등)는 제외 — 며칠 만에 회복하는 경우 있음
    //        수익률 0.5% 미만 or RSI<45+MA20 이탈 = 강한 반전 → 전량, 아니면 60%
    {
      const REVERSAL_MEGA_CAPS = new Set(['005930','000660','005380','000270','035420','068270','005490','051910','207940','000720']);
      const _isMegaCap = REVERSAL_MEGA_CAPS.has(chain.stock_code);
      const _isReversalEligible = !_isMegaCap
        && chain.status !== 'PROFIT_TAKING'
        && chain.strategy_mode !== 'SCALPING'
        && ['BREAKOUT','DARVAS','SWING','BOTTOM_FISHING'].includes(chain.strategy_mode ?? '');

      if (_isReversalEligible) {
        const _revPeakMap = _getPeakMap();
        const _revPrevPeak = _revPeakMap.get(chain.stock_code) ?? pnlPct;
        const _revCurPeak = Math.max(_revPrevPeak, pnlPct);
        _revPeakMap.set(chain.stock_code, _revCurPeak);

        const REVERSAL_ACTIVATE_PCT = 1.5; // 이 수익률 이상 도달 후에만 발동
        if (_revCurPeak >= REVERSAL_ACTIVATE_PCT) {
          const _revDropFromPeak = pnlPct - _revCurPeak;
          const _revChart = chartData.get(chain.stock_code);
          const _revTech = _revChart && _revChart.length >= 20 ? analyzeTechnicals(_revChart) : null;
          const _revRsi = _revTech?.rsi14 ?? 50;
          const _revAboveSma20 = _revTech ? price.currentPrice > _revTech.sma20 : true;

          // RSI < 45 + MA20 이탈: 강한 하락 반전 → 민감하게
          // 그 외: 느슨하게 (잠깐 눌림일 수 있음)
          const _isStrongReversal = _revRsi < 45 && !_revAboveSma20;
          const _revDropThreshold = _isStrongReversal ? -1.0 : -1.8;

          if (_revDropFromPeak <= _revDropThreshold && chain.total_quantity > 0) {
            const _sellAll = pnlPct < 0.5 || _isStrongReversal;
            const _revQty = _sellAll ? chain.total_quantity : Math.ceil(chain.total_quantity * 0.6);
            logger.info(
              `🔄 반전매도(v12/${chain.strategy_mode}): ${chain.stock_code} 고점+${_revCurPeak.toFixed(1)}%→현재${pnlPct.toFixed(1)}% (${_revDropFromPeak.toFixed(1)}%) RSI${_revRsi.toFixed(0)} MA20${_revAboveSma20?'↑':'↓'} ${_sellAll?'전량':'60%'}`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: _sellAll ? 'SELL' : 'PARTIAL_SELL',
              stock_code: chain.stock_code,
              quantity: _revQty,
              price_type: 'MARKET',
              reasoning: `반전매도(${chain.strategy_mode}): 고점+${_revCurPeak.toFixed(1)}%→현재${pnlPct.toFixed(1)}% (${_revDropFromPeak.toFixed(1)}%) RSI${_revRsi.toFixed(0)} ${_sellAll?'전량청산':'60%매도+재매수대기'}`,
              confidence: _isStrongReversal ? 0.90 : 0.82,
            });
            processedSellChains.add(chain.id);
            if (_sellAll) _revPeakMap.delete(chain.stock_code);
            continue;
          }
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // ── TrailingStop 1%: +1.5% 이후 최고점 대비 -1.0% 하락 시 전량 매도 ──────
    // BreakEvenGuard(SL=0%)와 연동 2중 수익 보호 체계
    //   · +1.5% 도달 → SL=0%로 상향(BreakEvenGuard) + peak 추적 시작(TrailingStop)
    //   · peak 대비 -1.0% 하락 → 전량 시장가 매도 (이익 보존)
    // PROFIT_TAKING 체인도 포함: ScaleOut 후 나머지 50%에도 동일 규칙 적용
    if (chain.strategy_mode !== 'SCALPING') {
      const peakMap = _getPeakMap();
      const prevPeak = peakMap.get(chain.stock_code) ?? pnlPct;
      const curPeak = Math.max(prevPeak, pnlPct);
      peakMap.set(chain.stock_code, curPeak);

      if (curPeak >= 1.5 && chain.total_quantity > 0) {
        const dropFromPeak = pnlPct - curPeak;
        if (dropFromPeak <= -1.0) {
          logger.info(
            `📉 TrailingStop: ${chain.stock_code} 고점 +${curPeak.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}% (${dropFromPeak.toFixed(1)}%)`,
            { component: 'TRACK_B' },
          );
          decisions.push({
            action: 'SELL',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `TrailingStop: 고점 +${curPeak.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}% (고점대비 ${dropFromPeak.toFixed(1)}%)`,
            confidence: 0.90,
          });
          processedSellChains.add(chain.id);
          _getPeakMap().delete(chain.stock_code);
          continue;
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // AI Loop forceHold: Claude Code가 매도 보류 지시 (실적 발표 대기 등)
    const aiForceHold = getOverride<boolean>(`${chain.stock_code}_forceHold`);
    if (aiForceHold && pnlPct > -5) {
      // 손절 한도(-5%) 이상이면 AI 홀드 존중
      logger.info(`🤖 AI Loop forceHold: ${chain.stock_code} 매도 보류 (pnl=${pnlPct.toFixed(1)}%)`, {
        component: 'AI_LOOP',
      });
      processedSellChains.add(chain.id);
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
      processedSellChains.add(chain.id);
      continue;
    }

    // SCALPING 강제청산 제거: SCALPING 전략 자체가 영구 비활성화됨 (Step 2)
    // 기존 SCALPING 체인이 남아있는 경우 일반 TP/SL 로직에서 처리

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
          processedSellChains.add(chain.id);
          continue;
        }
      }
      // BREAKOUT 비-Williams: 기존 TP/SL 로직 그대로 (SL=-5%, TP=+8%)
      // → 아래 일반 매도 로직에서 strategy_mode별 파라미터로 처리됨
    }

    // 외국인+기관 동반 이탈(STRONG_SELL 수급) 보유 종목
    // 하락장: 전량 즉시 청산 / 정상장: 50% 부분 매도
    // 쿨다운 적용: 같은 종목 15분 내 중복 STRONG_SELL 차단 (수수료 누적 방지)
    if (junkStockCodes?.has(chain.stock_code) && chain.total_quantity > 0) {
      const ssCooldown = _getStrongSellCooldown();
      const lastFire = ssCooldown.get(chain.stock_code) ?? 0;
      if (Date.now() - lastFire < STRONG_SELL_COOLDOWN_MS) {
        // 쿨다운 중 — 스킵 (다음 사이클에서 재평가)
        continue;
      }
      ssCooldown.set(chain.stock_code, Date.now());
      if (isDowntrendMode) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `외국인+기관 동반이탈(하락장): 전량 즉시 청산 → 추가 손실 방지`,
          confidence: 0.9,
        });
        processedSellChains.add(chain.id);
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
        processedSellChains.add(chain.id);
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
      processedSellChains.add(chain.id);
      continue;
    }

    // ── 장중 1% 스캘핑 익절 (CEO 지시 2026-06-17: SCALP_TARGET 1% 무한루프) ──
    // SCALP_TARGET 성격 체인(비추세, SWING/WILLIAMS/BOTTOM_FISHING): 장중(10:30~14:30)에
    // +1.0% 달성 즉시 청산 → 꺾인포인트 재진입 대기. 트레일링 홀딩 포지션(CHART_DOCTOR/MINERVINI)은 제외.
    {
      const _isIntradayScalpWindow =
        (_scalpH === 10 && _scalpM >= 30) || (_scalpH >= 11 && _scalpH <= 13) ||
        (_scalpH === 14 && _scalpM < 30);
      const _isTrendLeaderChain =
        (chain.trigger_source ?? '').includes('CHART_DOCTOR') ||
        (chain.trigger_source ?? '').includes('MINERVINI') ||
        (chain.trigger_source ?? '').includes('SNIPER');
      if (
        _isIntradayScalpWindow &&
        !_isTrendLeaderChain &&
        chain.strategy_mode !== 'SCALPING' &&
        pnlPct >= 1.0 &&
        chain.total_quantity > 0 &&
        !processedSellChains.has(chain.id)
      ) {
        logger.info(
          `💰 장중1%스캘핑익절: ${chain.stock_code} +${pnlPct.toFixed(2)}% (10:30~14:30 비추세체인)`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `장중1%익절(Scalp): +${pnlPct.toFixed(2)}% → 꺾인포인트 재진입 대기`,
          confidence: 0.90,
        });
        processedSellChains.add(chain.id);
        continue;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // v10.3: 마감전 수익확정 — 최소 +1.0% (수수료+세금 0.21% 차감 후 실질 수익 보장)
    // 기존 +0.25%, +0.5%는 수수료 차감 시 실질 손실 → 매도 자체가 손해
    // 당일 진입(6h 이내) + 수익 +1.0% 이상만 마감 전 청산
    const holdHrsForClose = chain.opened_at
      ? (Date.now() - new Date(chain.opened_at).getTime()) / (60 * 60_000)
      : 999;
    const isNearClose = _scalpH === 15 && _scalpM < 25;
    if (isNearClose && chain.strategy_mode !== 'SCALPING' && chain.strategy_mode !== 'BREAKOUT' && holdHrsForClose < 6 && chain.total_quantity > 0) {
      const closeThreshold = 1.0; // v10.3: 모든 시간대 최소 1.0% (수수료 커버 후 순수익 확보)
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
        processedSellChains.add(chain.id);
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
      const holdTech = holdingChart && holdingChart.length >= 20 ? analyzeTechnicals(holdingChart) : null;

      const { getDynamicDomesticTpSl } = await import('../../config/constants.js');
      // 자기학습 TP/SL 로드 (캐시 3분 — 매 사이클 DB 조회 방지)
      const learned = await _getLearnedTpSl();
      // 종목별 수급 데이터 (외국인/기관 순매수 여부)
      const sig = marketSignals?.get(chain.stock_code);
      const dyn = getDynamicDomesticTpSl({
        score: realtimeAiScore > 0 ? realtimeAiScore : Number(chain.target_profit_pct) >= 8 ? 88 : 80,
        rsi: holdTech?.rsi14,
        adx: holdTech?.adx14,
        atrPct: holdTech?.atrPct,
        isMomentum: holdTech ? holdTech.sma5 > holdTech.sma20 && holdTech.adx14 > 22 : false,
        foreignNetBuy: sig ? (sig as any).foreignNetBuy === true : undefined,
        institutionNetBuy: sig ? (sig as any).institutionNetBuy === true : undefined,
        learnedTp: learned?.tp,
        learnedSl: learned?.sl,
      });

      // chain TP = CEO 설정 상한선 (dynTp가 더 높아도 chain TP 초과 금지)
      // SL = 더 타이트한 쪽 (손실 최소화)
      const chainTp =
        chain.target_profit_pct ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.takeProfitPct ?? 7;
      const chainSl = chain.stop_loss_pct ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.stopLossPct ?? -3;
      effectiveTp = Math.min(Number(chainTp), dyn.takeProfitPct); // chain TP 상한 — 설정값 초과 방지
      effectiveSl = Math.min(Number(chainSl), dyn.stopLossPct); // 더 타이트한 SL

      // AI 약세 전환 + 수익 구간 → 빠른 수익 확정
      if (realtimeAiScore > 0 && realtimeAiScore < 55 && pnlPct > 1.0) {
        effectiveTp = Math.min(effectiveTp, Math.max(pnlPct - 0.5, 1.0));
      }
    } else {
      // SCALPING은 고정 TP/SL
      effectiveTp = STRATEGY_PARAMS.SCALPING.takeProfitPct;
      effectiveSl = STRATEGY_PARAMS.SCALPING.stopLossPct;
    }

    // ── ScaleOut 1차 익절: +3.0% 도달 시 50% 시장가 익절 ────────────────────
    // BreakEvenGuard + TrailingStop과 연동 3중 수익 보호:
    //   +1.5%: SL → 본절(BEG) + peak 추적 시작(Trailing)
    //   +3.0%: 50% 익절(ScaleOut) → 나머지 50%에 BEG+Trailing 계속 적용
    if (
      !isScalpChain &&
      chain.status !== 'PROFIT_TAKING' &&
      !isDowntrendMode &&
      pnlPct >= 3.0 &&
      chain.total_quantity > 0 &&
      !processedSellChains.has(chain.id)
    ) {
      const scaleQty = Math.ceil(chain.total_quantity * 0.5);
      if (scaleQty > 0 && scaleQty < chain.total_quantity) {
        logger.info(
          `💰 ScaleOut 1차(50%): ${chain.stock_code} +${pnlPct.toFixed(1)}% → ${scaleQty}주 익절`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: scaleQty,
          price_type: 'MARKET',
          reasoning: `ScaleOut 1차(50%): +${pnlPct.toFixed(1)}% 도달 → 나머지 50% BreakEven+Trailing 대기`,
          confidence: 0.90,
        });
        processedSellChains.add(chain.id);
        continue;
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // ─── 3단계 익절 전략 ────────────────────────────────────────────────
    // 1단계: TP 도달 → 35% 부분 매도 (상태→PROFIT_TAKING)
    // 2단계: TP+3% 도달 → 추가 35% 매도 (잔여 ~30%)
    // 3단계: TP+8% 최종 목표 → 잔여 전량 청산 (trailing은 위 TrailingStop이 담당)
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
        processedSellChains.add(chain.id);
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
        processedSellChains.add(chain.id);
        _getPeakMap().delete(chain.stock_code);
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
        processedSellChains.add(chain.id);
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
        processedSellChains.add(chain.id);
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
          processedSellChains.add(chain.id);
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
          processedSellChains.add(chain.id);
          continue;
        }
      }

      // 3단계: TP+8% 최종 목표 → 잔여 전량 청산
      // (trailing은 위 TrailingStop 1%가 담당 — 여기서 중복 처리 없음)
      const isTargetReached = pnlPct >= 8.0;
      if (isTargetReached) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `3단계 익절(잔여전량): +${pnlPct.toFixed(1)}% 최종목표(+8%) 달성`,
          confidence: 0.9,
        });
        processedSellChains.add(chain.id);
        continue;
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // ── 시간 가중치 트레일링 스탑 (getTimeWeightedStop 통합) ──────────
    // 기존 모멘텀 가드 + 데드머니 3/4/6일 exit 5개를 Phase 1~3으로 통합
    // Phase 1 (0-48h): 구조적 SL만 (초기 휩소 방어) — ATR dynamicStop도 비활성화
    // Phase 2 (48-72h): 수익 시 본절 이동
    // Phase 3 (72h+): ATR 기반 trailing, 손실 시 강제 손절
    let twStopIsPhase1Hold = false; // Phase 1 HOLD 시 ATR dynamicStop 우회 플래그
    if (chain.opened_at && !isScalpChain && chain.status !== 'PROFIT_TAKING') {
      const holdingHours = (Date.now() - new Date(chain.opened_at).getTime()) / (60 * 60_000);
      // MA20 이탈 판정: 현재가 vs SMA20 (sellTech에 close 없으므로 livePrices 사용)
      const belowMa20 = sellTech ? price.currentPrice < sellTech.sma20 : false;

      const twStop = getTimeWeightedStop({
        holdingHours,
        pnlPct,
        baseSlPct: effectiveSl,
        belowMa20,
      });

      logger.debug(
        `⏱️ TWStop ${chain.stock_code}: ${twStop.action} (${twStop.reason})`,
        { component: 'TRACK_B' },
      );

      if (twStop.action === 'EXECUTE_SL') {
        decisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `시간가중SL: ${twStop.reason}`,
          confidence: 0.9,
        });
        processedSellChains.add(chain.id);
        continue;
      }

      if (twStop.action === 'HOLD') {
        // Phase 1 버퍼: 구조적 SL만 허용, 일반 SL + ATR dynamicStop 비활성화
        effectiveSl = twStop.effectiveSlPct;
        twStopIsPhase1Hold = true; // ATR 우회 플래그
      }

      if (twStop.action === 'BREAK_EVEN') {
        // 본절 이동: SL을 twStop이 지정한 값(0%)으로 올림
        effectiveSl = Math.max(effectiveSl, twStop.effectiveSlPct);
      }

      if (twStop.action === 'TRAIL_TIGHTEN') {
        // 트레일링 강화: 고점 대비 -2% trail
        effectiveSl = Math.max(effectiveSl, twStop.effectiveSlPct);
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // 손절 (ATR 동적 손절 vs 전략 고정 손절 — 더 보수적인 쪽 적용)
    // Phase 1 HOLD 중에는 ATR dynamicStop 비활성화 (구조적 SL만 허용 — 초기 휩소 방어)
    const dynamicStop = twStopIsPhase1Hold
      ? effectiveSl // Phase 1: ATR 무시, effectiveSl(=baseSlPct×1.5)만 사용
      : (sellTech ? sellTech.dynamicStopLossPct : effectiveSl);
    // AI 80점+ 고확신 종목은 손절 기준 1.2배 넓히기 (일시적 노이즈로 조기손절 방지)
    const stopWidenMultiplier = realtimeAiScore >= 80 ? 1.2 : 1.0;
    // 시그널 보정: 체결강도 < 80(매도세 압도) → 손절 타이트닝 (0.85x), 체결강도 > 120(매수세) → 1.1x 완화
    const sigIntensity = marketSignals?.get(chain.stock_code)?.tradingIntensity?.intensity ?? 0;
    const signalStopMult = sigIntensity > 0 ? (sigIntensity < 80 ? 0.85 : sigIntensity >= 120 ? 1.1 : 1.0) : 1.0;
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
      processedSellChains.add(chain.id);
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
            processedSellChains.add(chain.id);
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
          processedSellChains.add(chain.id);
        }
      }
    }
  }

  return decisions;
}

/**
 * KR Track B 단계 익절 — SWING/SNIPER 전략 전용 부분익절
 *   SWING:  3.5%@25%, 6.5%@35%, 10%@100%
 *   SNIPER: 4.0%@30%, 8.0%@100%
 * generateSellDecisions 이후 별도 실행 — applyDecisionFlow에서 최종 중복 제거
 */
export function generatePartialTpDecisions(
  openChains: TechnicalFallbackParams['openChains'],
  livePrices: TechnicalFallbackParams['livePrices'],
): TradeDecision[] {
  const decisions: TradeDecision[] = [];

  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price || chain.total_quantity <= 0) continue;
    if (chain.status === 'PROFIT_TAKING') continue;

    const avgBuy = Number(chain.avg_buy_price);
    if (avgBuy <= 0) continue;
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    if (chain.strategy_mode === 'SWING') {
      if (pnlPct >= 10.0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `SWING 단계익절3(전량): +${pnlPct.toFixed(1)}% — 10% 최종목표 달성`,
          confidence: 0.92,
        });
      } else if (pnlPct >= 6.5) {
        const qty = Math.ceil(chain.total_quantity * 0.35);
        if (qty > 0 && qty < chain.total_quantity) {
          decisions.push({
            action: 'PARTIAL_SELL',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `SWING 단계익절2(35%): +${pnlPct.toFixed(1)}% — 나머지 65% 10% 목표`,
            confidence: 0.88,
          });
        }
      } else if (pnlPct >= 3.5) {
        const qty = Math.ceil(chain.total_quantity * 0.25);
        if (qty > 0 && qty < chain.total_quantity) {
          decisions.push({
            action: 'PARTIAL_SELL',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `SWING 단계익절1(25%): +${pnlPct.toFixed(1)}% — 나머지 75% 6.5% 목표`,
            confidence: 0.85,
          });
        }
      }
    } else if (chain.strategy_mode === 'SNIPER') {
      if (pnlPct >= 8.0) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `SNIPER 단계익절2(전량): +${pnlPct.toFixed(1)}% — 8% 최종목표 달성`,
          confidence: 0.92,
        });
      } else if (pnlPct >= 4.0) {
        const qty = Math.ceil(chain.total_quantity * 0.30);
        if (qty > 0 && qty < chain.total_quantity) {
          decisions.push({
            action: 'PARTIAL_SELL',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `SNIPER 단계익절1(30%): +${pnlPct.toFixed(1)}% — 나머지 70% 8% 목표`,
            confidence: 0.88,
          });
        }
      }
    }
  }

  return decisions;
}
