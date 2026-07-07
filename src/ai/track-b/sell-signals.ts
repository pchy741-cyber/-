import { analyzeTechnicals } from '../../analysis/indicators.js';
import { BEAR_ADAPTIVE, getDynamicDomesticTpSl, STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { getLearnedParameters } from '../../automation/self-learning/index.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getTimeWeightedStop } from '../../risk/entry-timing-guard.js';
import { logger } from '../../utils/logger.js';
import { getOverride } from '../ai-overrides.js';
import { shouldMomentumHold, resetMomentumHoldIfNewHigh } from './momentum-hold.js';
import {
  buildAiScoreMap,
  getKstScalpTime,
  resolveStrategyParams,
  type TechnicalFallbackParams,
} from './technical-fallback-types.js';

// 가격 연속 미수신 카운터 (1회 API 장애로 정상 포지션 강제청산 방지)
const _priceMissCounter = new Map<string, number>();

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
  chains: Array<{ stock_code: string; avg_buy_price: number | string | null; peak_price_since_open?: number | null; is_paper?: boolean }>,
  isPaper?: boolean,
): void {
  // 🛡️ is_paper 구분하여 올바른 맵에만 복원 (크로스오염 방지)
  if (!_preTpPeakMap.has('live')) _preTpPeakMap.set('live', new Map());
  if (!_preTpPeakMap.has('paper')) _preTpPeakMap.set('paper', new Map());
  const targetKey = isPaper != null ? (isPaper ? 'paper' : 'live') : null;
  const liveMap = _preTpPeakMap.get('live')!;
  const paperMap = _preTpPeakMap.get('paper')!;
  for (const c of chains) {
    const avg = Number(c.avg_buy_price ?? 0);
    const peak = Number(c.peak_price_since_open ?? 0);
    if (avg > 0 && peak > 0) {
      const peakPnlPct = ((peak - avg) / avg) * 100;
      if (peakPnlPct > 0) {
        if (targetKey === 'paper') paperMap.set(c.stock_code, peakPnlPct);
        else if (targetKey === 'live') liveMap.set(c.stock_code, peakPnlPct);
        else {
          // 호환성: isPaper 미전달 시 양쪽 복원
          liveMap.set(c.stock_code, peakPnlPct);
          paperMap.set(c.stock_code, peakPnlPct);
        }
      }
    }
  }
  const totalRestored = liveMap.size + paperMap.size;
  if (totalRestored > 0) {
    logger.info(
      `📈 Pre-TP peak 복원: live=${liveMap.size}, paper=${paperMap.size}종목`,
      { component: 'TRACK_B' },
    );
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
const STRONG_SELL_COOLDOWN_MS = 15 * 60_000; // 15 minutes

// 초대형주: 반전매도 면제 (며칠 만에 회복하는 경우 있음)
const REVERSAL_MEGA_CAPS: ReadonlySet<string> = new Set([
  '005930',
  '000660',
  '005380',
  '000270',
  '035420',
  '068270',
  '005490',
  '051910',
  '207940',
  '000720',
]);

// 자기학습 TP/SL 캐시 (3분 TTL — 매 사이클 DB 조회 방지)
// Paper/Live 분리: 모드별 독립 캐시 (크로스오염 방지)
const _learnedCacheMap = new Map<string, { tp?: number; sl?: number; expiresAt: number }>();
async function _getLearnedTpSl(): Promise<{ tp?: number; sl?: number } | null> {
  const isPaper = getCtxIsPaper();
  const cacheKey = isPaper ? 'paper' : 'live';
  const cached = _learnedCacheMap.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached;
  try {
    const { rows } = await getPool().query(
      `SELECT take_profit_pct::float, stop_loss_pct::float FROM strategy_config WHERE is_active = true AND is_paper = $1 LIMIT 1`,
      [isPaper],
    );
    const r = rows[0];
    const entry = { tp: r?.take_profit_pct, sl: r?.stop_loss_pct, expiresAt: Date.now() + 180_000 }; // 3 min cache TTL
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

  // ── 인메모리 맵 클린업 — 닫힌 포지션 잔여 엔트리 + 만료 쿨다운 제거 ──
  const openCodes = new Set(openChains.map((c) => c.stock_code));
  const peakMap = _getPeakMap();
  for (const code of peakMap.keys()) {
    if (!openCodes.has(code)) peakMap.delete(code);
  }
  const ssCooldownMap = _getStrongSellCooldown();
  const nowMs = Date.now();
  for (const [code, ts] of ssCooldownMap) {
    if (nowMs - ts > STRONG_SELL_COOLDOWN_MS * 2) ssCooldownMap.delete(code);
  }
  const decisions: TradeDecision[] = [];

  // 학습된 TrailingStop 배수 로드 (sniperType별 최적 drop 비율)
  const learnedParams = await getLearnedParameters().catch((): { trailingStopMultipliers: Record<string, number> } => ({
    trailingStopMultipliers: {},
  }));

  // ── analyzeTechnicals 캐시 (사이클당 종목별 1회만 계산) ──
  // 기존: 러너판정/동적TP/SL/매도체크/기술매도 = 종목당 최대 4회 중복 호출
  // 수정: 종목당 1회 계산 후 캐시 재사용 → ~75% 연산 절감
  const _techCache = new Map<string, ReturnType<typeof analyzeTechnicals> | null>();
  function getCachedTech(stockCode: string): ReturnType<typeof analyzeTechnicals> | null {
    if (_techCache.has(stockCode)) return _techCache.get(stockCode)!;
    const candles = chartData.get(stockCode);
    const tech = candles && candles.length >= 20 ? analyzeTechnicals(candles) : null;
    _techCache.set(stockCode, tech);
    return tech;
  }

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
  // penalty=1(조정장, mult=0.8)도 포함 — < 0.8은 조정장을 누락함
  const isDowntrendMode = (params.macroSizingMult ?? 1.0) <= 0.8;

  // 1. 보유 종목 매도 판단 (손절/익절)
  // 각 체인은 독립 평가 — 같은 종목이라도 avg_buy_price/strategy가 다를 수 있음
  const processedSellChains = new Set<string>(); // chain.id 기반 중복 방지
  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price) {
      // 🚨 안전망: 가격 데이터 누락 → 연속 3회 이상 시에만 긴급 청산
      // (1회 API 장애로 정상 포지션 청산 방지)
      if (chain.avg_buy_price && chain.total_quantity > 0) {
        const missKey = `price_miss_${chain.stock_code}`;
        const missCount = (_priceMissCounter.get(missKey) ?? 0) + 1;
        _priceMissCounter.set(missKey, missCount);
        if (missCount >= 3) {
          logger.error(`🚨 국내 비상매도: ${chain.stock_code} 연속 ${missCount}회 가격 누락 → 긴급 청산 (보유 ${chain.total_quantity}주)`, { component: 'SELL_SIG' });
          decisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `🚨 긴급청산: 연속 ${missCount}회 가격 데이터 수신 실패 — 손실 방지 (매입가 ${Number(chain.avg_buy_price).toLocaleString()}원)`,
            confidence: 0.99,
          });
          processedSellChains.add(chain.id);
          _priceMissCounter.delete(missKey); // 청산 후 카운터 리셋
        } else {
          logger.warn(`⚠️ ${chain.stock_code} 가격 누락 ${missCount}/3회 — 다음 사이클 재시도`, { component: 'SELL_SIG' });
        }
      }
      continue;
    }
    // 가격 정상 수신 → 카운터 리셋
    _priceMissCounter.delete(`price_miss_${chain.stock_code}`);

    const avgBuy = Number(chain.avg_buy_price);
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // 이미 이 체인에 대해 결정이 내려졌으면 스킵
    if (processedSellChains.has(chain.id)) continue;

    // ── 시간손절: maxHoldingDays 초과 시 강제 청산 (v11: 전수조사 — 미구현 버그 수정) ──
    {
      const modeParams = STRATEGY_PARAMS[chain.strategy_mode as StrategyMode];
      const maxDays = modeParams?.maxHoldingDays ?? 15;
      const openedMs = chain.opened_at ? new Date(chain.opened_at).getTime() : 0;
      const holdingDays = openedMs > 0 ? (Date.now() - openedMs) / 86_400_000 : 0;
      if (holdingDays > maxDays && chain.total_quantity > 0) {
        logger.info(
          `⏰ 시간손절: ${chain.stock_code} ${holdingDays.toFixed(1)}일 > ${maxDays}일 pnl=${pnlPct.toFixed(1)}%`,
          { component: 'SELL_SIGNALS' },
        );
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `시간손절(${holdingDays.toFixed(0)}d>${maxDays}d): pnl=${pnlPct.toFixed(1)}%`,
          confidence: 0.85,
        });
        processedSellChains.add(chain.id);
        continue;
      }
    }

    // ── v16.1 러너 모멘텀 감지 (강화: 거래량+ADX+RSI+정배열+MACD 복합) ──
    const _rTech = getCachedTech(chain.stock_code);
    const isRunner = (() => {
      if (!_rTech) return false;
      let s = 0;
      if (_rTech.volumeRatio >= 2.0) s++;     // v16.2: 1.5→2.0 복원 (1.5x는 평범한 거래량)
      if (_rTech.volumeRatio >= 3.0) s++;     // v16.2: 2.5→3.0 (진짜 폭발만 추가 가산)
      if (_rTech.adx14 >= 25) s++;
      if (_rTech.rsi14 >= 45 && _rTech.rsi14 <= 78) s++;  // v20: 75→78 (강한 모멘텀 러너 RSI 78까지 허용)
      if (price.currentPrice > _rTech.sma5 && _rTech.sma5 > _rTech.sma20) s++;
      if (_rTech.macdCrossover === 'BULLISH') s++;
      return s >= 2; // v16.2: 항상 2개+ 조건 필요 (5%+ 1개 조건=거짓양성 과다)
    })();
    if (isRunner && pnlPct >= 1.5) {  // v16.1: 2.0→1.5 (더 빠른 러너 감지)
      logger.info(
        `🚀 러너 감지: ${chain.stock_code} +${pnlPct.toFixed(1)}% vol=${_rTech!.volumeRatio.toFixed(1)}x ADX=${_rTech!.adx14.toFixed(0)} RSI=${_rTech!.rsi14.toFixed(0)} MACD=${_rTech!.macdCrossover} → 익절 지연`,
        { component: 'TRACK_B' },
      );
    }

    // ── BreakEvenGuard: +2.0% 도달 시 SL 상향 ────────────
    // ③b: SWING BreakEvenGuard OFF — 부분익절 후 트레일 즉시활성(0%) 폐지
    // 근거: +2% 도달 → SL=0% → 정상 눌림에서 BE 청산 → 보유기간 2시간 수렴
    // SWING은 원래 SL(-2.2%) 유지, 기타 전략만 -0.3% 적용
    const beTargetSl = chain.strategy_mode === 'SWING' ? null : -0.3;
    if (
      beTargetSl != null && // ③b: SWING은 null → BreakEvenGuard 비활성
      chain.strategy_mode !== 'SCALPING' &&
      chain.status !== 'PROFIT_TAKING' &&
      pnlPct >= 2.0 &&
      chain.stop_loss_pct != null &&
      Number(chain.stop_loss_pct) < beTargetSl
    ) {
      try {
        const { rowCount } = await getPool().query(
          // updated_at 컬럼 없음 (전수조사 C1) — stop_loss_pct만 갱신
          `UPDATE transaction_chains SET stop_loss_pct = $2 WHERE id = $1 AND stop_loss_pct < $2`,
          [chain.id, beTargetSl],
        );
        if (rowCount && rowCount > 0) {
          (chain as Record<string, unknown>).stop_loss_pct = beTargetSl;
          logger.info(
            `🛡️ BreakEvenGuard: ${chain.stock_code} SL → ${beTargetSl}% [pnl +${pnlPct.toFixed(1)}%, ${chain.strategy_mode}]`,
            { component: 'TRACK_B' },
          );
        }
      } catch (e) {
        logger.warn(`BreakEvenGuard DB 실패 (${chain.stock_code}): ${(e as Error).message}`, { component: 'TRACK_B' });
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // ── 포트폴리오 수익 보호: 하락장 감지 시 수익권 종목 선제 청산 ──
    // 포트폴리오 전체 수익 +2% 이상 + RISK_OFF/하락장(macroSizingMult<0.8) + 이 종목 수익권
    // → 개별 TP 미도달이라도 즉시 청산 (수익 반납 방지)
    // v10.3: 개별 종목 최소 +2.0% 이상만 선제 청산 (기존 +0.5%는 수수료 차감 후 실질 손실)
    if (
      portfolioPnlPct >= 2.0 &&
      // v10.11.4: < 0.8 → <= 0.8 (isDowntrendMode 정의와 통일 — 조정장(0.8) 포함)
      (params.macroSizingMult ?? 1.0) <= 0.8 &&
      pnlPct >= 2.0 &&
      chain.total_quantity > 0 &&
      !isRunner
    ) {
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
      const _isMegaCap = REVERSAL_MEGA_CAPS.has(chain.stock_code);
      const _isReversalEligible =
        !_isMegaCap &&
        !isRunner && // 러너는 일시 조정이 정상 — 반전매도 면제
        chain.status !== 'PROFIT_TAKING' &&
        chain.strategy_mode !== 'SCALPING' &&
        ['BREAKOUT', 'DARVAS', 'SWING', 'BOTTOM_FISHING'].includes(chain.strategy_mode ?? '');

      if (_isReversalEligible) {
        const _revPeakMap = _getPeakMap();
        const _revPrevPeak = _revPeakMap.get(chain.stock_code) ?? pnlPct;
        const _revCurPeak = Math.max(_revPrevPeak, pnlPct);
        _revPeakMap.set(chain.stock_code, _revCurPeak);

        const REVERSAL_ACTIVATE_PCT = 3.0; // v12.1: 1.5→3.0 (정상 조정 구간에서 과민 반응 방지)
        if (_revCurPeak >= REVERSAL_ACTIVATE_PCT) {
          const _revDropFromPeak = pnlPct - _revCurPeak;
          const _revChart = chartData.get(chain.stock_code);
          const _revTech = _revChart && _revChart.length >= 20 ? analyzeTechnicals(_revChart) : null;
          const _revRsi = _revTech?.rsi14 ?? 50;
          const _revAboveSma20 = _revTech ? price.currentPrice > _revTech.sma20 : true;

          // RSI < 45 + MA20 이탈: 강한 하락 반전 → 민감하게
          // 그 외: 느슨하게 (잠깐 눌림일 수 있음)
          const _isStrongReversal = _revRsi < 45 && !_revAboveSma20;
          const _revDropThreshold = _isStrongReversal ? -1.5 : -2.5; // v12.1: 완화 (-1.0/-1.8 → -1.5/-2.5, 정상 눌림 구간 보존)

          if (_revDropFromPeak <= _revDropThreshold && chain.total_quantity > 0) {
            const _sellAll = pnlPct < 0.5 || _isStrongReversal;
            const _revQty = _sellAll ? chain.total_quantity : Math.ceil(chain.total_quantity * 0.6);
            logger.info(
              `🔄 반전매도(v12/${chain.strategy_mode}): ${chain.stock_code} 고점+${_revCurPeak.toFixed(1)}%→현재${pnlPct.toFixed(1)}% (${_revDropFromPeak.toFixed(1)}%) RSI${_revRsi.toFixed(0)} MA20${_revAboveSma20 ? '↑' : '↓'} ${_sellAll ? '전량' : '60%'}`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: _sellAll ? 'SELL' : 'PARTIAL_SELL',
              stock_code: chain.stock_code,
              quantity: _revQty,
              price_type: 'MARKET',
              reasoning: `반전매도(${chain.strategy_mode}): 고점+${_revCurPeak.toFixed(1)}%→현재${pnlPct.toFixed(1)}% (${_revDropFromPeak.toFixed(1)}%) RSI${_revRsi.toFixed(0)} ${_sellAll ? '전량청산' : '60%매도+재매수대기'}`,
              confidence: _isStrongReversal ? 0.9 : 0.82,
            });
            processedSellChains.add(chain.id);
            if (_sellAll) _revPeakMap.delete(chain.stock_code);
            continue;
          }
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // ── TrailingStop: +1.5% 이후 최고점 대비 동적 하락폭 시 전량 매도 ──────
    // BreakEvenGuard(SL=0%)와 연동 2중 수익 보호 체계
    //   · +1.5% 도달 → SL=0%로 상향(BreakEvenGuard) + peak 추적 시작(TrailingStop)
    //   · peak 대비 학습된 drop% 하락 → 전량 시장가 매도 (이익 보존)
    // PROFIT_TAKING 체인도 포함: ScaleOut 후 나머지 50%에도 동일 규칙 적용
    if (chain.strategy_mode !== 'SCALPING') {
      const peakMap = _getPeakMap();
      const prevPeak = peakMap.get(chain.stock_code) ?? pnlPct;
      const curPeak = Math.max(prevPeak, pnlPct);
      peakMap.set(chain.stock_code, curPeak);

      // 신고점 갱신 시 모멘텀홀드 카운트 리셋
      if (curPeak > prevPeak) {
        resetMomentumHoldIfNewHigh(chain.id, curPeak).catch(() => {});
      }

      if (curPeak >= 1.5 && chain.total_quantity > 0) {
        // 학습된 ATR 배수로 sniperType별 drop 비율 동적 조정
        // 기본 -1.0%, 학습 데이터 있으면 해당 sniperType의 최적 배수 적용
        const triggerSrcForTrail = (chain as Record<string, unknown>).trigger_source as string | undefined;
        const sniperTypeMatch = triggerSrcForTrail?.match(/SNIPER[_\s]?(\w+)/);
        const chainSniperType = sniperTypeMatch?.[1] ?? null;
        const learnedMult = chainSniperType ? learnedParams.trailingStopMultipliers[chainSniperType] : undefined;
        // v20: 트레일링 드롭 확대 — 손익비 개선 (이전 -1.8/-3.0 → -2.5/-4.0)
        // 너무 타이트한 트레일 = 정상 눌림에서 조기 매도 → 평균 수익 축소
        // 러너(폭발 모멘텀): -4.0 (넓게 유지), 일반: -2.5 (적정 숨고르기 허용)
        let baseTrailDrop = learnedMult != null ? -Math.max(0.5, Math.min(5.0, learnedMult)) : isRunner ? -4.0 : -2.5;

        // 캔들+볼륨 보정 (근거: VWAP 연구 Sharpe 3.99, 캔들 종가 기준)
        const _trailChartData = chartData?.get(chain.stock_code);
        if (_trailChartData && _trailChartData.length >= 3) {
          const _trailPatterns = (await import('../../analysis/patterns.js')).detectCandlePatterns(_trailChartData);
          const hasBearish = _trailPatterns.some((p: { bullish: boolean; strength: string }) => !p.bullish && p.strength !== 'WEAK');
          const hasBullish = _trailPatterns.some((p: { bullish: boolean; strength: string }) => p.bullish && p.strength !== 'WEAK');
          if (hasBearish) baseTrailDrop *= 0.6; // 약세 캔들 → 40% 타이트
          else if (hasBullish) baseTrailDrop *= 1.2; // 강세 캔들 → 20% 완화
          const _trailTech = getCachedTech(chain.stock_code);
          if (_trailTech) {
            if (_trailTech.volumeRatio < 0.5) baseTrailDrop *= 0.7; // 볼륨 소진
            else if (_trailTech.volumeRatio >= 3.0) baseTrailDrop *= 0.75; // 클라이맥스
            if (_trailTech.rsi14 < 40) baseTrailDrop *= 0.85; // RSI 약세
          }
        }

        // v20: 부분 익절(PROFIT_TAKING) 후 트레일링 완화 — 나머지 포지션 추가 상승 여유
        if (chain.status === 'PROFIT_TAKING') baseTrailDrop -= 2.0;

        // ③a: SWING 마이크로 트레일(waterfall 2b) OFF
        // 근거: 캔들×볼륨 곱셈(-2.5*0.6*0.7=-1.05%)이 인트라데이 노이즈에 걸려 2시간 내 청산
        // SWING은 baseTrailDrop 고정 -2.5(일반)/-4.0(러너), 캔들/볼륨 조임 비적용
        if (chain.strategy_mode === 'SWING') {
          baseTrailDrop = isRunner ? -4.0 : -2.5; // 마이크로 트레일 리셋 — 위 조임 무효화
        }

        // 고점 수익률 비례 숨고르기 허용폭 확장
        const momentumBonus = curPeak >= 15 ? 4.5 : curPeak >= 10 ? 3.0 : curPeak >= 5 ? 1.5 : 0;
        const trailingDrop = Math.max(baseTrailDrop - momentumBonus, -10.0);

        const dropFromPeak = pnlPct - curPeak;
        if (dropFromPeak <= trailingDrop) {
          // 모멘텀 홀드 체크: 추세가 살아있으면 매도 유보
          const mhResult = await shouldMomentumHold({
            tech: getCachedTech(chain.stock_code),
            pnlPct,
            curPeak,
            dropFromPeakAbs: Math.abs(dropFromPeak),
            chainId: chain.id,
            stockCode: chain.stock_code,
            isPaper: chain.is_paper ?? getCtxIsPaper(),
            isRunner,
            currentPrice: price.currentPrice,
          });
          if (mhResult.shouldHold) {
            const _mhMax = curPeak >= 10 ? 9 : curPeak >= 5 ? 7 : 4;
            logger.info(
              `🔋 모멘텀홀드: ${chain.stock_code} TrailingStop 억제 (${mhResult.holdCount}/${_mhMax}) | 고점+${curPeak.toFixed(1)}%→현재+${pnlPct.toFixed(1)}% | ${mhResult.reason}`,
              { component: 'MOMENTUM_HOLD' },
            );
            continue; // 이번 사이클 매도 스킵 → 2분 후 재평가
          }
          const dropLabel = trailingDrop !== -1.0 ? ` (학습배수 ${(-trailingDrop).toFixed(1)}%)` : '';
          logger.info(
            `📉 TrailingStop: ${chain.stock_code} 고점 +${curPeak.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}% (${dropFromPeak.toFixed(1)}%)${dropLabel}`,
            { component: 'TRACK_B' },
          );
          decisions.push({
            action: 'SELL',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `TrailingStop: 고점 +${curPeak.toFixed(1)}% → 현재 +${pnlPct.toFixed(1)}% (고점대비 ${dropFromPeak.toFixed(1)}%${dropLabel})`,
            confidence: 0.9,
          });
          processedSellChains.add(chain.id);
          _getPeakMap().delete(chain.stock_code);
          continue;
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // AI Loop forceHold: Claude Code가 매도 보류 지시 (실적 발표 대기 등)
    // v10.9.4: -5% 고정 → 전략 SL 기준 (기존: 설계 SL -2.5%인데 -5%까지 허용 → 2배 손실)
    const aiForceHold = getOverride<boolean>(`${chain.stock_code}_forceHold`);
    const _chainStrategyParams = STRATEGY_PARAMS[chain.strategy_mode as StrategyMode] ?? strategyParams;
    const forceHoldLimit = _chainStrategyParams.stopLossPct * 1.2; // 전략 SL의 1.2배까지만 허용 (SWING -2.5%→-3%)
    if (aiForceHold && pnlPct > forceHoldLimit) {
      logger.info(`🤖 AI Loop forceHold: ${chain.stock_code} 매도 보류 (pnl=${pnlPct.toFixed(1)}%, limit=${forceHoldLimit.toFixed(1)}%)`, {
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

    // ── LTH (장기보유): 일반 SL/TP 무시 — 하락장 -5% 이하일 때만 탈출 매도 ──
    // 탈출 후 당일 재매수 허용 (pipeline에서 lossBlockedCodes 예외 처리)
    const isLTH = params.longTermHoldCodes?.has(chain.stock_code);
    if (isLTH) {
      const LTH_EXIT_THRESHOLD = -5.0;
      if (isDowntrendMode && pnlPct < LTH_EXIT_THRESHOLD) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `🏛️ LTH 하락장 탈출 (pnl=${pnlPct.toFixed(1)}%, 기준=${LTH_EXIT_THRESHOLD}%) — 재매수 대기`,
          confidence: 0.85,
        });
        processedSellChains.add(chain.id);
      } else {
        // 하락장 미달 또는 일반 SL/TP → 보유 유지
        logger.debug(`🏛️ LTH 보유 유지: ${chain.stock_code} pnl=${pnlPct.toFixed(1)}% downtrend=${isDowntrendMode}`, { component: 'TRACK_B' });
        processedSellChains.add(chain.id);
      }
      continue;
    }

    // v28: SCALPING Paper 부활 — 10:00 이후 강제청산 (Paper만, Live는 일반 TP/SL)
    if (chain.strategy_mode === 'SCALPING' && chain.total_quantity > 0) {
      const { h: scH, m: scM } = getKstScalpTime();
      if (scH >= 10) {
        decisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `SCALPING 강제청산: ${scH}:${String(scM).padStart(2, '0')} ≥ 10:00 (최대보유 1시간)`,
          confidence: 1.0,
        });
        processedSellChains.add(chain.id);
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
        const holdingDays = openedMs > 0 ? Math.floor((nowMs - openedMs) / 86_400_000) : 0; // 1 day in ms
        const { h: wH, m: wM } = getKstScalpTime();

        // 모멘텀 체크: 수익권 + 시가 대비 상승 중이면 이번 사이클은 보류
        // CEO 지적(2026-07-02): eod-bluechip/eod-betting과 동일한 무조건 강제매도 버그 —
        // 갭업 후에도 계속 상승 중인 브레이크아웃 종목까지 기계적으로 매도하던 것 수정
        const risingSinceOpen = price.openPrice > 0 ? price.currentPrice > price.openPrice : false;
        if (pnlPct > 0 && risingSinceOpen) {
          logger.info(
            `📈 BREAKOUT/Williams 익일매도 보류: ${chain.stock_code} 수익권(+${pnlPct.toFixed(1)}%)+시가대비 상승중 → 모멘텀 지속 관찰`,
            { component: 'TRACK_B' },
          );
        } else if (holdingDays >= 1 && wH === 9 && wM <= 10) {
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
        // 쿨다운 중 — STRONG_SELL 부분매도만 스킵, SL/TP 등 나머지 매도 로직은 계속 실행
        // ⚠️ 이전: continue로 전체 스킵 → 손절/트레일링스탑까지 우회되는 치명적 버그
      } else {
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
    }

    // ── 급등 즉시 익절 (Spike Sell): 매수 직후 급등 시 전량 매도 ─────────
    // "사자마자 팍 오르면 바로 팔아야지" — 급등은 빠르게 되돌림 위험 높음
    // 매수 후 60분 이내 + PnL ≥ 3% → 전량 익절 (수수료 후 순수익 ~2.8% 확보)
    // 러너는 면제 — 폭발 모멘텀 종목을 조기에 놓치면 안 됨
    {
      const chainAge = chain.opened_at
        ? (Date.now() - new Date(chain.opened_at).getTime()) / 60_000
        : 9999;
      if (isRunner && chainAge <= 60 && pnlPct >= 3.0 && !processedSellChains.has(chain.id)) {
        logger.info(
          `🚀 러너 급등매도 면제: ${chain.stock_code} +${pnlPct.toFixed(2)}% (${chainAge.toFixed(0)}분)`,
          { component: 'MOMENTUM_HOLD' },
        );
      } else if (
        chainAge <= 60 &&
        pnlPct >= 3.0 &&
        chain.total_quantity > 0 &&
        !processedSellChains.has(chain.id)
      ) {
        logger.info(
          `⚡ 급등즉시익절: ${chain.stock_code} +${pnlPct.toFixed(2)}% (매수 후 ${chainAge.toFixed(0)}분, 전량매도)`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `급등즉시익절: +${pnlPct.toFixed(2)}% (매수${chainAge.toFixed(0)}분후) → 되돌림 전 전량확정`,
          confidence: 0.95,
        });
        processedSellChains.add(chain.id);
        continue;
      }
    }

    // ── 장중 스캘핑 익절 (v11-fix: 1%→2.5% 상향, SWING 7% TP와 충돌 해소) ──
    // v11-fix: 기존 1%는 수수료 0.21% 차감 후 순수익 0.79%밖에 안 됨
    // SWING TP 7%인데 1%에서 전량 청산하면 수익 기회 대부분 상실
    // 2.5%로 상향: 수수료 후 순수익 ~2.3% 확보 + SWING TP까지 여유
    // v16.2: SCALP_TARGET 전용 조기익절 (1.5% — 수수료 0.21% 차감 후 1.3% 순수익)
    {
      const _isScalpTargetChain = (chain.trigger_source ?? '').includes('SCALP_TARGET');
      if (
        _isScalpTargetChain &&
        !isRunner &&
        pnlPct >= 1.5 &&
        chain.total_quantity > 0 &&
        !processedSellChains.has(chain.id)
      ) {
        logger.info(
          `⚡ SCALP_TARGET 익절: ${chain.stock_code} +${pnlPct.toFixed(2)}% (박스권 1.5% 목표)`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `SCALP_TARGET 익절: +${pnlPct.toFixed(2)}% → 박스권 수익확정 (v16.2)`,
          confidence: 0.9,
        });
        processedSellChains.add(chain.id);
        continue;
      }
    }
    // 일반 장중스캘핑 익절 (SCALP_TARGET 외 비추세 체인)
    {
      const _isIntradayScalpWindow =
        (_scalpH === 10 && _scalpM >= 30) || (_scalpH >= 11 && _scalpH <= 13) || (_scalpH === 14 && _scalpM < 30);
      const _isTrendLeaderChain =
        (chain.trigger_source ?? '').includes('CHART_DOCTOR') ||
        (chain.trigger_source ?? '').includes('MINERVINI') ||
        (chain.trigger_source ?? '').includes('SNIPER') ||
        (chain.trigger_source ?? '').includes('TREND_LEADER');
      if (
        _isIntradayScalpWindow &&
        !_isTrendLeaderChain &&
        !isRunner &&
        chain.strategy_mode !== 'SCALPING' &&
        pnlPct >= 2.5 &&
        chain.total_quantity > 0 &&
        !processedSellChains.has(chain.id)
      ) {
        logger.info(
          `💰 장중스캘핑익절: ${chain.stock_code} +${pnlPct.toFixed(2)}% (10:30~14:30 비추세체인, 임계 2.5%)`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `장중스캘핑익절: +${pnlPct.toFixed(2)}% → 수익확정`,
          confidence: 0.9,
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
      ? (Date.now() - new Date(chain.opened_at).getTime()) / 3_600_000 // 1 hour in ms
      : 999;
    const isNearClose = _scalpH === 15 && _scalpM < 25;
    if (
      isNearClose &&
      chain.strategy_mode !== 'SCALPING' &&
      chain.strategy_mode !== 'BREAKOUT' &&
      !isRunner &&
      holdHrsForClose < 6 &&
      chain.total_quantity > 0
    ) {
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

    const rawAiScore = aiScoreMap.get(chain.stock_code) ?? 0;
    const realtimeAiScore = Number.isFinite(rawAiScore) ? rawAiScore : 0;

    // ── 실시간 다팩터 동적 TP/SL (해외 calcDynamicTpSl과 동등) ──
    // 매 사이클마다 현재 기술지표로 재계산 (진입 시점 고정값 X)
    let effectiveTp: number;
    let effectiveSl: number;

    const holdTech = getCachedTech(chain.stock_code);

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
      foreignNetBuy: sig ? (sig as unknown as Record<string, unknown>).foreignNetBuy === true : undefined,
      institutionNetBuy: sig ? (sig as unknown as Record<string, unknown>).institutionNetBuy === true : undefined,
      learnedTp: learned?.tp,
      learnedSl: learned?.sl,
    });

    // chain TP = CEO 설정 상한선 (dynTp가 더 높아도 chain TP 초과 방지)
    // SL = 더 타이트한 쪽 (손실 최소화)
    const chainTp = chain.target_profit_pct ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.takeProfitPct ?? 7;
    const chainSl = chain.stop_loss_pct ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.stopLossPct ?? -3;
    effectiveTp = Math.min(Number(chainTp), dyn.takeProfitPct); // chain TP 상한 — 설정값 초과 방지
    effectiveSl = Math.max(Number(chainSl), dyn.stopLossPct); // 더 타이트한 SL (음수이므로 max = 덜 부정적 = 타이트)

    // 하락장 적응형 모드: TP/SL 축소 (근거: R:R 1.5:1, 승률 45%+ 양의 기대값)
    if (isDowntrendMode && chain.strategy_mode !== 'DIVIDEND') {
      effectiveTp = Math.min(effectiveTp, BEAR_ADAPTIVE.TAKE_PROFIT_PCT);
      effectiveSl = Math.max(effectiveSl, BEAR_ADAPTIVE.STOP_LOSS_PCT);
    }

    // AI 약세 전환 + 수익 구간 → 빠른 수익 확정
    // v20: <55→<45 (AI 점수 55 미만 = 중립~약세 → 과도한 조기 익절 방지, 45 미만만 실제 약세)
    if (realtimeAiScore > 0 && realtimeAiScore < 45 && pnlPct > 1.0 && !isRunner) {
      // 러너: AI 약세에도 기술적 모멘텀 우선
      effectiveTp = Math.min(effectiveTp, Math.max(pnlPct - 0.5, 1.0));
    }

    // ── ScaleOut 1차 익절: 러너=+5.0%/35%, 일반=+3.0%/50% ────────────────────
    // BreakEvenGuard + TrailingStop과 연동 3중 수익 보호:
    //   +1.5%: SL → 본절(BEG) + peak 추적 시작(Trailing)
    //   +3~5%: 35~50% 익절(ScaleOut) → 나머지에 BEG+Trailing 계속 적용
    // 러너: 강한 모멘텀 종목은 ScaleOut 지연 + 비율 축소 → 수익 극대화
    const _scaleOutPct = isRunner ? 5.0 : 3.0;
    // v12.1: 확신도 기반 동적 스케일아웃 (기존: 정적 35%/50%)
    // 고점수 → 적게 팔아 런 유지, 저점수 → 많이 팔아 수익 확보
    const _scaleOutRatio = isRunner
      ? 0.25
      : realtimeAiScore >= 90 ? 0.20
      : realtimeAiScore >= 80 ? 0.30
      : realtimeAiScore >= 70 ? 0.40
      : 0.50;
    if (
      chain.status !== 'PROFIT_TAKING' &&
      !isDowntrendMode &&
      pnlPct >= _scaleOutPct &&
      chain.total_quantity > 0 &&
      !processedSellChains.has(chain.id)
    ) {
      const scaleQty = Math.ceil(chain.total_quantity * _scaleOutRatio);
      if (scaleQty > 0 && scaleQty < chain.total_quantity) {
        logger.info(
          `💰 ScaleOut 1차(${Math.round(_scaleOutRatio * 100)}%${isRunner ? '/러너' : ''}): ${chain.stock_code} +${pnlPct.toFixed(1)}% → ${scaleQty}주 익절`,
          { component: 'TRACK_B' },
        );
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: scaleQty,
          price_type: 'MARKET',
          reasoning: `ScaleOut 1차(${Math.round(_scaleOutRatio * 100)}%${isRunner ? '/러너' : ''}): +${pnlPct.toFixed(1)}% 도달 → 나머지 ${Math.round((1 - _scaleOutRatio) * 100)}% BreakEven+Trailing 대기`,
          confidence: 0.9,
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
      // v12.1: 확신도 기반 1단계 익절 비율 (기존: 러너25%/일반35%)
      const _stage1Ratio = isRunner
        ? 0.15 // 러너: 15%만 익절 → 85% 런 유지
        : realtimeAiScore >= 90 ? 0.15
        : realtimeAiScore >= 80 ? 0.25
        : 0.35;
      const sellQty = Math.ceil(chain.total_quantity * _stage1Ratio);
      if (sellQty > 0 && sellQty < chain.total_quantity) {
        decisions.push({
          action: 'PARTIAL_SELL',
          stock_code: chain.stock_code,
          quantity: sellQty,
          price_type: 'MARKET',
          reasoning: `1단계 익절(${Math.round(_stage1Ratio * 100)}%${isRunner ? '/러너' : ''}): +${pnlPct.toFixed(1)}% 도달 (목표 ${effectiveTp.toFixed(1)}% AI${realtimeAiScore}점) → 나머지 ${Math.round((1 - _stage1Ratio) * 100)}% 트레일링 대기`,
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
    const sellTech = getCachedTech(chain.stock_code);

    // 2~3단계: PROFIT_TAKING 상태에서 추가 익절 + 트레일링 스톱
    if (chain.status === 'PROFIT_TAKING') {
      // peak_price가 DB에 없으면 트레일링 기준 없음 → 손실 구간에서 오발동 방지
      if (!(chain as Record<string, unknown>).peak_price && pnlPct < 0) {
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
      const origQty = avgBuy > 0 ? Math.round(Number(chain.total_invested) / avgBuy) : chain.total_quantity;
      const remainRatio = origQty > 0 ? chain.total_quantity / origQty : 1;
      const _stage2Offset = isRunner ? 6.0 : 3.0; // 러너: TP+6%, 일반: TP+3%
      if (remainRatio > 0.6 && pnlPct >= effectiveTp + _stage2Offset) {
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
      const stage3Target = effectiveTp + (isRunner ? 13.0 : 8.0); // 러너: TP+13%, 일반: TP+8%
      const isTargetReached = pnlPct >= stage3Target;
      if (isTargetReached) {
        decisions.push({
          action: 'SELL',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `3단계 익절(잔여전량): +${pnlPct.toFixed(1)}% 최종목표(+${stage3Target.toFixed(1)}%) 달성`,
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
    if (chain.opened_at && chain.status !== 'PROFIT_TAKING') {
      const holdingHours = (Date.now() - new Date(chain.opened_at).getTime()) / 3_600_000; // 1 hour in ms
      // MA20 이탈 판정: 현재가 vs SMA20 (sellTech에 close 없으므로 livePrices 사용)
      const belowMa20 = sellTech ? price.currentPrice < sellTech.sma20 : false;

      const twStop = getTimeWeightedStop({
        holdingHours,
        pnlPct,
        baseSlPct: effectiveSl,
        belowMa20,
      });

      logger.debug(`⏱️ TWStop ${chain.stock_code}: ${twStop.action} (${twStop.reason})`, { component: 'TRACK_B' });

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

      // ③c: SWING 시간 기반 익절 보류 — BREAK_EVEN/TRAIL_TIGHTEN은 SWING에서 비활성
      // 근거: Phase2 본절(24-48h +3%→SL -1%), Phase3 트레일(48h+ +2%→trail)이
      //       15일 보유 설계를 2-3일 내 청산으로 단축. 방어 라인(SL/구조적SL)은 유지
      if (twStop.action === 'BREAK_EVEN' && chain.strategy_mode !== 'SWING') {
        effectiveSl = Math.max(effectiveSl, twStop.effectiveSlPct);
      }

      if (twStop.action === 'TRAIL_TIGHTEN' && chain.strategy_mode !== 'SWING') {
        effectiveSl = Math.max(effectiveSl, twStop.effectiveSlPct);
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // 손절 (ATR 동적 손절 vs 전략 고정 손절 — 더 보수적인 쪽 적용)
    // Phase 1 HOLD 중에는 ATR dynamicStop 비활성화 (구조적 SL만 허용 — 초기 휩소 방어)
    const dynamicStop = twStopIsPhase1Hold
      ? effectiveSl // Phase 1: ATR 무시, effectiveSl(=baseSlPct×1.5)만 사용
      : sellTech
        ? sellTech.dynamicStopLossPct
        : effectiveSl;
    // AI 80점+ 고확신 종목은 손절 기준 1.2배 넓히기 (일시적 노이즈로 조기손절 방지)
    const stopWidenMultiplier = realtimeAiScore >= 80 ? 1.2 : 1.0;
    // 시그널 보정: 체결강도 < 80(매도세 압도) → 손절 타이트닝 (0.85x), 체결강도 > 120(매수세) → 1.1x 완화
    const sigIntensity = marketSignals?.get(chain.stock_code)?.tradingIntensity?.intensity ?? 0;
    const signalStopMult = sigIntensity > 0 ? (sigIntensity < 80 ? 0.85 : sigIntensity >= 120 ? 1.1 : 1.0) : 1.0;
    // v10.11.4: -8% → -6% (risk-guard.ts HARD_FLOOR=-6%과 통일)
    // 기존: sell-signals -8%, risk-guard -6% → 두 시스템 불일치로 보호 사각지대
    const effectiveStop = Math.max(-6.0, Math.max(effectiveSl, dynamicStop) * stopWidenMultiplier * signalStopMult);
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
    {
      const tech = getCachedTech(chain.stock_code);
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

    // v10.9.4: maxHoldingDays 강제 적용 (PROFIT_TAKING 포함)
    // 기존: PROFIT_TAKING 상태면 maxHoldingDays 미적용 → 무한 보유 가능
    if (!processedSellChains.has(chain.id) && chain.opened_at) {
      const _maxDays = _chainStrategyParams?.maxHoldingDays ?? STRATEGY_PARAMS[chain.strategy_mode as StrategyMode]?.maxHoldingDays ?? 15;
      const _holdingMs = Date.now() - new Date(chain.opened_at).getTime();
      const _holdingDays = _holdingMs / 86_400_000;
      if (_maxDays > 0 && _holdingDays >= _maxDays) {
        decisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `최대보유기간 초과: ${_holdingDays.toFixed(1)}일/${_maxDays}일 (pnl=${pnlPct.toFixed(1)}%, ${chain.status})`,
          confidence: 0.9,
        });
        processedSellChains.add(chain.id);
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
  /** v10.11.2: 이미 매도 결정된 종목 코드 — 중복 매도 방지 (145% 수량 버그 해소) */
  alreadySoldCodes?: ReadonlySet<string>,
): TradeDecision[] {
  const decisions: TradeDecision[] = [];

  for (const chain of openChains) {
    const price = livePrices.get(chain.stock_code);
    if (!price || !chain.avg_buy_price || chain.total_quantity <= 0) continue;
    if (chain.status === 'PROFIT_TAKING') continue;
    // v10.11.2: generateSellDecisions에서 이미 매도 결정된 종목 스킵 (145% 수량 버그 방지)
    if (alreadySoldCodes?.has(chain.stock_code)) continue;

    const avgBuy = Number(chain.avg_buy_price);
    if (avgBuy <= 0) continue;
    const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

    // v10.11.4: SWING TP=7%이므로 단계익절은 TP 미만에서만 동작
    // stage1=2.5%/20%, stage2=5.0%/30%, 전량은 generateSellDecisions TP에 위임
    if (chain.strategy_mode === 'SWING') {
      if (pnlPct >= 5.0) {
        const qty = Math.ceil(chain.total_quantity * 0.50);
        if (qty > 0 && qty < chain.total_quantity) {
          decisions.push({
            action: 'PARTIAL_SELL',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `SWING 단계익절2(50%): +${pnlPct.toFixed(1)}% — 나머지 50% TP(7%) 대기`,
            confidence: 0.88,
          });
        }
      } else if (pnlPct >= 2.5) {
        const qty = Math.ceil(chain.total_quantity * 0.40);
        if (qty > 0 && qty < chain.total_quantity) {
          decisions.push({
            action: 'PARTIAL_SELL',
            stock_code: chain.stock_code,
            quantity: qty,
            price_type: 'MARKET',
            reasoning: `SWING 단계익절1(40%): +${pnlPct.toFixed(1)}% — 나머지 60% 5% 목표`,
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
        const qty = Math.ceil(chain.total_quantity * 0.3);
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
