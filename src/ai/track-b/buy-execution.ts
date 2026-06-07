import { analyzeTechnicals, analyzeIntraday } from '../../analysis/indicators.js';
import { computeFingerprint, getPatternFeedback, fingerprintKey } from '../../analysis/entry-fingerprint.js';
import { getWinRateConfidenceBoost, winRateSummary } from '../../analysis/win-rate.js';
import { getCtxIsPaper } from '../../config/context.js';
import { getDynamicDomesticTpSl } from '../../config/constants.js';
import { getPool } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getMinuteChart, isMarketOpen } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { generateAveragingDecisions } from './averaging-down.js';
import { PRIORITY_SECTOR_CODES } from './trading-rules.js';
import { type TechnicalFallbackParams, type BuyCandidate, resolveStrategyParams, buildAiScoreMap, hasNoAiScores } from './technical-fallback-types.js';

// ── 국내 주식 Kelly 사이징 (해외 kelly.ts 패턴 재사용) ──
interface DomesticKellyResult {
  kellyPct: number;   // Quarter-Kelly %
  winRate: number;
  avgWin: number;
  avgLoss: number;
  sampleCount: number;
}

async function calcDomesticKelly(days: number = 30): Promise<DomesticKellyResult | null> {
  try {
    const { rows } = await getPool().query(`
      SELECT avg_buy_price,
        (SELECT filled_price FROM orders WHERE chain_id = tc.id AND side = 'SELL' ORDER BY created_at DESC LIMIT 1) as sell_price
      FROM transaction_chains tc
      WHERE status = 'CLOSED'
        AND closed_at >= NOW() - ($1 * INTERVAL '1 day')
        AND avg_buy_price > 0
        AND is_paper = $2
    `, [days, getCtxIsPaper()]);

    if (rows.length < 10) return null; // 최소 10건

    let wins = 0, losses = 0, totalWinPct = 0, totalLossPct = 0;
    for (const r of rows) {
      const buyPrice = Number(r.avg_buy_price);
      const sellPrice = Number(r.sell_price ?? buyPrice);
      const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
      if (pnlPct > 0) { wins++; totalWinPct += pnlPct; }
      else { losses++; totalLossPct += Math.abs(pnlPct); }
    }

    const total = wins + losses;
    if (total < 10) return null;

    const winRate = wins / total;
    const avgWin = wins > 0 ? totalWinPct / wins : 3.0;
    const avgLoss = losses > 0 ? totalLossPct / losses : 3.0;

    // Kelly Criterion: f = (b×p - q) / b
    const b = avgLoss > 0 ? avgWin / avgLoss : 1.0;
    const q = 1 - winRate;
    const fullKelly = (b * winRate - q) / b;

    // Kelly 음수 = "배팅하지 마라" → 하드코딩 비율로 폴백 (null 반환)
    // 승률 30% 미만이면 Kelly 비활성화 (학습 단계에서 소액 분산 방지)
    if (fullKelly <= 0 || winRate < 0.30) {
      logger.info(
        `📊 국내 Kelly (${days}d, ${total}건): 승률 ${(winRate * 100).toFixed(0)}%, fullKelly=${(fullKelly * 100).toFixed(1)}% → 음수/저승률 → 하드코딩 비율 사용`,
        { component: 'TRACK_B' },
      );
      return null; // 하드코딩 allocPct로 폴백
    }

    // 적응형 Kelly: 승률+샘플 기반으로 Quarter↔Half 자동 전환
    const kellyFraction = (winRate >= 0.55 && total >= 20) ? 0.50 : 0.25;
    const quarterKelly = Math.max(0.03, Math.min(0.18, fullKelly * kellyFraction));

    logger.info(
      `📊 국내 Kelly (${days}d, ${total}건): 승률 ${(winRate * 100).toFixed(0)}%, 평균수익 +${avgWin.toFixed(1)}%, 평균손실 -${avgLoss.toFixed(1)}% → ${kellyFraction === 0.5 ? 'Half' : 'Quarter'}-Kelly ${(quarterKelly * 100).toFixed(1)}%`,
      { component: 'TRACK_B' },
    );

    return { kellyPct: quarterKelly, winRate, avgWin, avgLoss, sampleCount: total };
  } catch {
    return null;
  }
}

/**
 * 매수 실행: 후보 정렬 + 분봉 MTF + 교체매매 + 포지션사이징 + 매수 + 현금소진 + 물타기
 */
export async function executeBuyDecisions(params: TechnicalFallbackParams & { candidates: BuyCandidate[] }): Promise<TradeDecision[]> {
  const { mode, livePrices, chartData, openChains, orderableCash, maxPositionKrw, totalAssets, winRates, candidates, macroSizingMult: _macroMult } = params;
  const macroSizingMult = _macroMult ?? 1.0;
  const strategyParams = resolveStrategyParams(mode, params);
  const aiScoreMap = buildAiScoreMap(params.aiScores);
  const noAiScores = hasNoAiScores(params.aiScores);
  const decisions: TradeDecision[] = [];

  // 종목당 최대 비중: 확신도 기반 동적 캡 — 장 좋고 확신 높으면 적극 집중
  // 소자산: 3종목 분산 불가 시 80%까지 집중 허용
  // 기준: effectiveMaxPos(=totalAssets×25%)로 1주 최소가(1만원) 3개 이상 살 수 없으면 소자산
  const canDiversify3 = (totalAssets ?? 0) > 0 && ((totalAssets ?? 0) * 0.25 >= 30_000);
  // Hard Cap 25% — 일일손실 2.5% 방어 (소자산은 80% 집중 허용)
  const maxPosFraction = (!canDiversify3) ? 0.80 : 0.25;
  const effectiveMaxPos = totalAssets
    ? Math.min(maxPositionKrw, Math.round(totalAssets * maxPosFraction))
    : maxPositionKrw;

  const allocationBoostFirstEntry = true;

  // DB에서 점수 티어별 실거래 역산 비율 로드 (없으면 하드코딩 fallback)
  let scoreTierParams: Array<{ tier_min: number; tier_max: number; alloc_pct: number; sample_count: number }> = [];
  try {
    const { rows } = await getPool().query(
      `SELECT tier_min, tier_max, alloc_pct::float, sample_count FROM score_tier_params ORDER BY tier_min`,
    );
    scoreTierParams = rows;
  } catch { /* DB 없으면 하드코딩 사용 */ }

  // Kelly 사이징: 30일 롤링 (10건 미만이면 null → 기존 하드코딩 폴백)
  const kellyResult = await calcDomesticKelly(30);

  // AI 스코어 + 기술적 점수 합산으로 정렬
  candidates.sort((a, b) => {
    const aTotal = (aiScoreMap.get(a.stock_code) ?? 0) + a.tech.score;
    const bTotal = (aiScoreMap.get(b.stock_code) ?? 0) + b.tech.score;
    return bTotal - aTotal;
  });

  // ─── 분봉 멀티타임프레임 확인 (상위 10개 후보, 장중에만) ──────────────────
  // 프로 트레이더 기준: 일봉 BUY + 15분봉 비하락 + 1분봉 양수 + VWAP 위치 = 4중 확인
  const intradayBonus = new Map<string, number>();
  const intraday15mDown = new Set<string>();  // 15분봉 하락 종목
  const intradayVwapBelow = new Set<string>(); // VWAP 아래 종목 (싸게 사기 보너스)
  if (isMarketOpen() && candidates.length > 0) {
    const topN = candidates.slice(0, 10); // 5→10개로 확대 (더 많은 종목 분봉 확인)
    await Promise.allSettled(topN.map(async (cand) => {
      try {
        const minuteCandles = await getMinuteChart(cand.stock_code);
        if (minuteCandles.length >= 5) {
          const intraday = analyzeIntraday(minuteCandles);
          // VWAP 아래서 사면 유리 → 보너스 +5, 위에서 사면 페널티 -3
          const vwapAdj = intraday.vwapPosition === 'BELOW' ? 5
            : intraday.vwapPosition === 'ABOVE' ? -3 : 0;
          intradayBonus.set(cand.stock_code, intraday.score + vwapAdj);
          if (intraday.trend15m === 'DOWN') intraday15mDown.add(cand.stock_code);
          if (intraday.vwapPosition === 'BELOW') {
            intradayVwapBelow.add(cand.stock_code);
          }
          logger.info(`  ⏱️ ${cand.stock_code}: 분봉=${intraday.trend}(${intraday.score}) 15m=${intraday.trend15m} VWAP=${intraday.vwapPosition}(${vwapAdj >= 0 ? '+' : ''}${vwapAdj}) vol급등=${intraday.volumeSurge} | ${intraday.reason}`, { component: 'TRACK_B' });
        }
      } catch {
        // 분봉 실패 시 무시 — 일봉 분석으로 진행
      }
    }));
  }

  // ─── 점수 기반 교체매매: 고점수 신호 왔는데 현금 부족 시 저점수 보유종목 청산 ───
  // 조건: 1위 후보 AI점수 ≥ 80점 AND 현금 < 1차 매수금액 AND 교체 대상 점수 차 ≥ 15점
  if (!params.blockNewBuys && candidates.length > 0 && mode !== 'SCALPING') {
    const topCand = candidates[0];
    const topAiScore = aiScoreMap.get(topCand.stock_code) ?? 0;
    const topScore = topAiScore + topCand.tech.score;
    const needCash = Math.min(effectiveMaxPos / (strategyParams.splitCount || 2), orderableCash + 1);
    const isHighConvictionCandidate = topAiScore >= 80 || (topCand.tech.score >= 70 && topAiScore >= (strategyParams.buyThreshold ?? 58));

    if (isHighConvictionCandidate && orderableCash < needCash) {
      // 교체 대상: 파킹 ETF 제외, 수익 중인 종목 우선 (손실 실현 최소화)
      // 점수가 가장 낮은 종목 선택
      const tradingChains = openChains.filter(
        (c) => Number(c.total_quantity) > 0,
      );

      if (tradingChains.length > 0) {
        // 보유 종목별 현재 AI 점수 조회
        const chainScored = tradingChains.map((c) => ({
          chain: c,
          aiScore: aiScoreMap.get(c.stock_code) ?? 0,
          techScore: (() => {
            const candles = chartData.get(c.stock_code);
            return analyzeTechnicals(candles ?? [])?.score ?? 0;
          })(),
        }));

        // 점수 낮은 순 정렬 → 가장 낮은 종목
        chainScored.sort((a, b) => (a.aiScore + a.techScore) - (b.aiScore + b.techScore));
        const weakest = chainScored[0];
        const weakScore = weakest.aiScore + weakest.techScore;
        const scoreDiff = topScore - weakScore;

        // 교체 조건: 점수 차 15점 이상 + 대상 종목이 현금 부족 해소에 충분한 보유량
        if (scoreDiff >= 15) {
          const price = livePrices.get(weakest.chain.stock_code);
          const qty = Number(weakest.chain.total_quantity ?? 0);
          const pnlPct = price && weakest.chain.avg_buy_price
            ? ((price.currentPrice - Number(weakest.chain.avg_buy_price)) / Number(weakest.chain.avg_buy_price)) * 100
            : 0;

          // 손실 중인 종목은 -3% 이내일 때만 교체 허용 (깊은 손실 실현 방지)
          const lossOk = pnlPct >= -3.0;

          if (lossOk && qty > 0 && price) {
            logger.info(
              `🔄 교체매매: ${weakest.chain.stock_code}(점수${weakScore}) → ${topCand.stock_code}(점수${topScore}) 차이=${scoreDiff}점 수익률=${pnlPct.toFixed(1)}%`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: 'SELL',
              stock_code: weakest.chain.stock_code,
              quantity: qty,
              price_type: 'MARKET',
              limit_price: price.currentPrice,
              reasoning: `교체매매: 점수${weakScore}점 → 고확신${topScore}점(${topCand.stock_code}) 차이=${scoreDiff}점, 현금확보 후 재매수`,
              confidence: 0.7,
            });
          } else {
            logger.info(
              `⏭️ 교체매매 보류: ${weakest.chain.stock_code} 손실${pnlPct.toFixed(1)}% > -3% 한도 초과`,
              { component: 'TRACK_B' },
            );
          }
        }
      }
    }
  }

  // 현금 여유 확인하면서 매수 결정
  let remainingCash = orderableCash;
  // SCALPING: 최대 2종목 / SNIPER: 최대 2종목 / 일반: 최대 3종목 (4→3, 소액분산 방지)
  const maxBuys = mode === 'SCALPING' ? 2 : mode === 'SNIPER' ? 2 : 3;
  const splitCount = strategyParams.splitCount || 2;

  for (const cand of candidates.slice(0, maxBuys)) {
    // ── BREAKOUT 전용 사이징 + 태깅 ──────────────────────────────────────
    if (mode === 'BREAKOUT' && cand.breakoutSignal) {
      const brkSig = cand.breakoutSignal;
      // Williams: 소형 포지션(8%), 나머지: 중형(15%)
      const isWilliams = brkSig.subStrategy === 'WILLIAMS_VOLATILITY';
      const breakoutAllocPct = isWilliams ? 0.08 : 0.15;
      const brkTargetKrw = totalAssets
        ? Math.round(totalAssets * breakoutAllocPct * (macroSizingMult ?? 1.0))
        : Math.round(effectiveMaxPos * 0.5);
      const brkPositionSize = Math.min(brkTargetKrw, effectiveMaxPos, remainingCash * 0.95);
      const brkMinKrw = Math.max(10_000, Math.round((totalAssets ?? orderableCash) * 0.03));
      if (brkPositionSize < brkMinKrw) {
        logger.info(`  ❌ ${cand.stock_code}: BREAKOUT 포지션 ${Math.round(brkPositionSize).toLocaleString()}원 < 최소 ${brkMinKrw.toLocaleString()}원 → 스킵`, { component: 'TRACK_B' });
        continue;
      }
      let brkQty = Math.floor(brkPositionSize / cand.price.currentPrice);
      if (brkQty <= 0 && remainingCash >= cand.price.currentPrice) brkQty = 1;
      if (brkQty <= 0) continue;

      decisions.push({
        action: 'BUY',
        stock_code: cand.stock_code,
        quantity: brkQty,
        price_type: 'MARKET',
        limit_price: cand.price.currentPrice,
        reasoning: `BREAKOUT [${brkSig.subStrategy}]: ${brkSig.reason} vol=${brkSig.details.volumeRatio.toFixed(1)}x conf=${brkSig.confidence.toFixed(2)} [${Math.round(brkPositionSize/10000)}만원/${(breakoutAllocPct*100).toFixed(0)}%]`,
        confidence: brkSig.confidence,
        strategy_mode: 'BREAKOUT',
        trigger_source: `BREAKOUT_${brkSig.subStrategy}`,
      });
      remainingCash -= brkQty * cand.price.currentPrice;
      continue;
    }

    // ── 멀티타임프레임 인트라데이 게이트 (프로 트레이더 기준 강화) ──────────
    // AI 없는 기술 단독 진입은 분봉 양수 필수 (불량 진입 원천 차단)
    const idBonus = intradayBonus.get(cand.stock_code) ?? 0;
    const _idAiScore = aiScoreMap.get(cand.stock_code) ?? 0;
    // 15분봉 하락 추세 패널티: 15분 단위로 하락 중이면 -10 추가 감산
    const id15mPenalty = intraday15mDown.has(cand.stock_code) ? -10 : 0;
    const effectiveIdBonus = idBonus + id15mPenalty;
    // AI 확신도별 통과 기준 (높을수록 인트라데이 약세 허용)
    const idPassThreshold = _idAiScore >= 85 ? -20 : _idAiScore >= 80 ? -10 : _idAiScore >= (strategyParams.buyThreshold ?? 72) ? -3 : 0;
    if (effectiveIdBonus < idPassThreshold) {
      logger.info(`  ⏸️ ${cand.stock_code}: 분봉게이트 미달(${idBonus}${id15mPenalty < 0 ? `+15m${id15mPenalty}` : ''}=${effectiveIdBonus} < ${idPassThreshold}, AI=${_idAiScore}) → 진입 보류`, { component: 'TRACK_B' });
      continue;
    }

    // 호가 매도벽 차단 (pipeline.ts에서 전달된 orderbookBlockedCodes)
    if (params.orderbookBlockedCodes?.has(cand.stock_code)) {
      logger.info(`  🚫 ${cand.stock_code}: 호가 매도벽(bid/ask≤0.5) → 진입 차단`, { component: 'TRACK_B' });
      continue;
    }

    // ── 시그널 최종 게이트: 체결강도 극약세 시 진입 보류 ──────────────────
    const signals = params.marketSignals?.get(cand.stock_code);
    if (signals?.tradingIntensity) {
      const intensity = signals.tradingIntensity.intensity;
      // 체결강도 < 80: 매도세 압도적 → AI 90+ 아닌 한 진입 보류
      if (intensity > 0 && intensity < 80 && _idAiScore < 90) {
        logger.info(`  📡 ${cand.stock_code}: 체결강도 ${intensity.toFixed(0)} < 80 (매도세 우위) → 진입 보류`, { component: 'TRACK_B' });
        continue;
      }
    }

    const isPriority = PRIORITY_SECTOR_CODES.has(cand.stock_code);
    const aiScore = aiScoreMap.get(cand.stock_code) ?? 0;

    // ── 점수 기반 목표 투자비율 계산 (총자산 대비 %) ──────────────────────
    // 기술점수(0~100) + AI점수를 실제 투자비율로 직접 변환
    // 기준: 60점=8%, 70점=12%, 80점=16%, 90점+=20%
    // DEFENSE/SCALPING은 절반 비율 적용 (보수 운용)
    const techScore = Math.min(100, cand.tech.score + (cand.candleBonus ?? 0) * 0.5);
    let blendedScore = aiScore > 0 ? techScore * 0.5 + aiScore * 0.5 : techScore;

    // ── 핑거프린트 패턴 피드백: 과거 동일 패턴 승률 기반 점수 보정 ──────────
    const smaAlign = cand.tech.sma5 > cand.tech.sma20 && cand.tech.sma20 > cand.tech.sma60 ? 'full_bull'
      : cand.tech.sma5 > cand.tech.sma20 ? 'partial_bull'
      : cand.tech.sma5 < cand.tech.sma20 && cand.tech.sma20 < cand.tech.sma60 ? 'full_bear'
      : cand.tech.sma5 < cand.tech.sma20 ? 'partial_bear' : 'neutral';
    const fp = computeFingerprint({
      rsi: cand.tech.rsi14,
      volumeRatio: cand.tech.volumeRatio,
      smaAlignment: smaAlign,
      regime: cand.regimeRoute?.regime,
      adxStrength: cand.tech.trendStrength,
      macdState: cand.tech.macdCrossover,
    });
    const fpKey = fingerprintKey(fp);
    const patternFb = await getPatternFeedback(fp);
    if (patternFb.scoreAdj !== 0) {
      blendedScore = Math.max(0, Math.min(100, blendedScore + patternFb.scoreAdj));
      logger.info(`  🔬 ${cand.stock_code}: 패턴피드백 [${fpKey}] ${patternFb.reason}→ blend=${blendedScore.toFixed(0)}`, { component: 'TRACK_B' });
    }

    // DB 실거래 역산 비율 사용 (샘플 10건 이상인 티어만), 부족하면 하드코딩 fallback
    const getDbAllocPct = (score: number): number | null => {
      const tier = scoreTierParams.find((t) => score >= t.tier_min && score <= t.tier_max);
      if (!tier || tier.sample_count < 10) return null;
      return tier.alloc_pct;
    };

    // ── AI 허락 여부로 투자비율 결정 ──────────────────────────────────────
    // AI가 buyThreshold 이상 승인 → 점수 비례 풀 비율
    // 기술지표만 통과(AI 미허락) → 소액 탐색(4-5%)으로 제한
    const aiApproved = aiScore >= strategyParams.buyThreshold;

    // 황금비율 v2: 확신도 비례 투입 (동적 maxPosFraction과 정합)
    const hardcodedAllocPct = aiApproved
      ? (mode === 'SNIPER'
          // SNIPER: 단일 최고확신 종목 집중 — Hard Cap 25% 준수
          ? (blendedScore >= 90 ? 0.25 :
             blendedScore >= 85 ? 0.22 : 0.18)
          : (blendedScore >= 90 ? 0.25 :   // 90+: 25% (Hard Cap, 일일손실 2.5% 방어)
             blendedScore >= 85 ? 0.22 :   // 85-89: 22%
             blendedScore >= 80 ? 0.15 :   // 80-84: 15%
             blendedScore >= 75 ? 0.08 :   // 75-79: 소액 탐색
             blendedScore >= 70 ? 0.14 : 0.10))
      : (noAiScores || aiScore === 0)
        // AI 부재(전체 미실행 또는 개별종목 AI=0) → 기술지표만으로 판단, 배분 상향
        ? (blendedScore >= 80 ? 0.18 : blendedScore >= 70 ? 0.14 : blendedScore >= 62 ? 0.10 : 0.06)
        // AI 있지만 이 종목은 미허락 → 소액 탐색
        : (blendedScore >= 80 ? 0.14 : blendedScore >= 70 ? 0.10 : 0.06);
    // Kelly 사이징 우선: 10건+ 데이터 있으면 Kelly 기반, 없으면 기존 하드코딩
    const kellyAllocPct = kellyResult
      ? kellyResult.kellyPct * (blendedScore >= 85 ? 1.5 : blendedScore >= 70 ? 1.2 : 1.0) // 점수 비례 스케일
      : null;
    const dbAllocPct = getDbAllocPct(blendedScore);
    let baseAllocPct = kellyAllocPct ?? dbAllocPct ?? hardcodedAllocPct;
    // Kelly/DB 데이터 존재 시: 하드코딩의 50%까지 축소 허용 (리스크 관리 우선)
    // 데이터 없으면(폴백): 하드코딩 그대로
    if (kellyAllocPct != null || dbAllocPct != null) {
      baseAllocPct = Math.max(baseAllocPct, hardcodedAllocPct * 0.50);
    }
    // 소자산: 3종목 분산 불가 시 배분율 최소 30% (1-2종목 집중)
    // 중자산: 6종목 이하 시 배분율 최소 20%
    // 비율 기반: 분산 가능 종목 수로 판단 (고정금액 제거)
    if (!canDiversify3) {
      baseAllocPct = Math.max(baseAllocPct, 0.30);
    } else if ((totalAssets ?? 0) > 0 && (totalAssets ?? 0) * 0.15 < 30_000) {
      // 15% 비중으로 1주(3만원) 못 사면 중소자산 → 20% 최소 배분
      baseAllocPct = Math.max(baseAllocPct, 0.20);
    }
    const modeScale = mode === 'SCALPING' ? 0.5 : mode === 'DEFENSE' ? 0.6 : 1.0;

    // 승률 기반 보정: 실거래 데이터 기반으로 비율 조정
    const wr = winRates?.get(cand.stock_code);
    const winRateMultiplier = wr && wr.sampleCount >= 3
      ? (wr.winRate >= 0.80 ? 1.30 : wr.winRate >= 0.65 ? 1.15 : wr.winRate <= 0.35 ? 0.65 : 1.0)
      : 1.0;
    if (winRateMultiplier !== 1.0) {
      logger.info(`  📈 ${cand.stock_code}: 승률배율 ×${winRateMultiplier} (승률${wr ? (wr.winRate * 100).toFixed(0) : 0}%/${wr?.sampleCount ?? 0}건)`, { component: 'TRACK_B' });
    }

    // 우선 테마 보정
    const priorityBonus = PRIORITY_SECTOR_CODES.has(cand.stock_code) ? 1.1 : 1.0;

    // 시그널 기반 포지션 보정: 체결강도 강세 + 스마트머니 유입 → 확대, 공매도 → 축소
    const signalMultiplier = (() => {
      if (!signals) return 1.0;
      let mult = 1.0;
      const ti = signals.tradingIntensity;
      const inv = signals.intradayInvestor;
      const ss = signals.shortSelling;
      if (ti && ti.intensity >= 120) mult += 0.10;      // 체결강도 매수 우위 → +10%
      if (inv && inv.foreignNetEstMil > 0 && inv.institutionNetEstMil > 0) mult += 0.10; // 동시 순매수
      if (ss && ss.shortRatio > 5) mult -= 0.10;         // 공매도 높으면 -10%
      return Math.max(0.7, Math.min(1.3, mult));
    })();

    // 목표 금액 = 총자산 × 비율 × 보정들
    // 고확신(90+) → 1차 90% (확률싸움: 확신 높으면 적극 투입)
    // 고확신(85+) → 1차 82~85%
    // 일반(70-84점) → 1차 70~78%
    // AI 미허락 탐색 → 1차 100% (소액이므로 분할 의미 없음)
    const firstEntryRatio = mode === 'SNIPER' ? 1.0   // 저격수: 한 번에 풀 포지션
      : !aiApproved ? 1.0
      : blendedScore >= 90 ? 0.90  // 최고확신: 90% 진입 (물타기 10% 여지)
      : blendedScore >= 85 ? (allocationBoostFirstEntry ? 0.85 : 0.82)
      : splitCount <= 1 ? 1.0
      : splitCount <= 2 ? (allocationBoostFirstEntry ? 0.78 : 0.70) : (allocationBoostFirstEntry ? 0.75 : 0.65);
    const aiPosMultiplier = 1.0;

    // ── TP/SL 리스크 기반 사이징 (해외 스타일) ──────────────────────────────
    // position = riskBudget / |stopLossPct| — SL이 작으면 큰 포지션, SL이 크면 작은 포지션
    // 기존 비율 기반(targetKrwAlloc)과 리스크 기반(targetKrwRisk) 중 큰 값 사용
    const tpSlHints = getDynamicDomesticTpSl({
      score: blendedScore,
      rsi: cand.tech.rsi14,
      adx: cand.tech.adx14,
      atrPct: cand.tech.atrPct,
      isMomentum: cand.tech.sma5 > cand.tech.sma20 && cand.tech.adx14 > 22,
      volumeRatio: cand.tech.volumeRatio,
      pullbackSignal: cand.tech.sma20 > 0 && cand.price.currentPrice >= cand.tech.sma20 * 0.98,
      // 자기학습 피드백: strategy_config 학습 TP/SL → 30% 블렌딩
      learnedTp: strategyParams.takeProfitPct,
      learnedSl: strategyParams.stopLossPct,
    });
    const riskPct = blendedScore >= 85 ? 0.025 : blendedScore >= 70 ? 0.02 : 0.015; // 총자산 대비 리스크 예산
    const absSl = Math.abs(tpSlHints.stopLossPct) / 100;
    const targetKrwRisk = totalAssets && absSl > 0
      ? Math.round((totalAssets * riskPct / absSl) * modeScale * macroSizingMult * signalMultiplier)
      : 0;
    const targetKrwAlloc = totalAssets
      ? Math.round(totalAssets * baseAllocPct * modeScale * macroSizingMult * winRateMultiplier * priorityBonus * firstEntryRatio * aiPosMultiplier * signalMultiplier)
      : Math.round(effectiveMaxPos * firstEntryRatio * macroSizingMult * aiPosMultiplier * signalMultiplier);
    // 두 방식 중 큰 값 사용 — 소액일수록 리스크 기반이 더 큰 포지션 산출
    const targetKrw = Math.max(targetKrwAlloc, targetKrwRisk);
    if (targetKrwRisk > targetKrwAlloc && targetKrwRisk > 0) {
      logger.info(`  📐 ${cand.stock_code}: TP/SL 리스크사이징 ${Math.round(targetKrwRisk/10000)}만 > 비율사이징 ${Math.round(targetKrwAlloc/10000)}만 (SL=${tpSlHints.stopLossPct}% risk=${(riskPct*100).toFixed(1)}%)`, { component: 'TRACK_B' });
    }

    // AI 고확신: 포지션 한도 확대 (최대 총자산 25% 캡 — portfolio-guard 집중도와 일치)
    // 소자산(분산 불가)은 maxPosFraction=80%이므로 별도 상한 적용 안 함
    const concentrationCap = !canDiversify3
      ? (totalAssets ? totalAssets * 0.80 : Infinity)
      : totalAssets ? totalAssets * 0.25 : Infinity;
    const aiMaxPos = aiPosMultiplier > 1.0 && totalAssets
      ? Math.min(effectiveMaxPos * aiPosMultiplier, concentrationCap)
      : effectiveMaxPos;
    // 상한: aiMaxPos (AI확신도 반영 종목당 한도), 남은 현금의 95%까지 사용 (현금 최대 활용)
    const positionSize = Math.min(targetKrw, aiMaxPos, remainingCash * 0.95);
    // 소자산 모드: 분산 불가 시에도 비율 계산 반영 (positionSize vs 현금 80% 중 작은 값)
    // Kelly/점수가 축소 시그널 → positionSize가 줄어들면 그대로 존중
    const effectivePositionSize = !canDiversify3
      ? Math.round(Math.min(positionSize, remainingCash * 0.80))
      : positionSize;
    // 최소 매수금액: 총자산 비례 동적 계산 (절대 최소 1만원)
    const minPositionKrw = totalAssets
      ? Math.max(10_000, Math.round(totalAssets * (aiApproved ? 0.04 : 0.025)))
      : Math.max(10_000, Math.round(orderableCash * (aiApproved ? 0.08 : 0.05)));
    if (effectivePositionSize < minPositionKrw) {
      logger.info(`  ❌ ${cand.stock_code}: 포지션크기 ${Math.round(effectivePositionSize).toLocaleString()}원 < 최소 ${minPositionKrw.toLocaleString()}원 (blend=${blendedScore.toFixed(0)} alloc=${(baseAllocPct*100).toFixed(0)}% cash=${Math.round(remainingCash).toLocaleString()}) → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    let quantity = Math.floor(effectivePositionSize / cand.price.currentPrice);
    if (quantity <= 0) {
      // 고가주(1주 > positionSize): 현금이 충분하면 최소 1주 매수
      if (remainingCash >= cand.price.currentPrice) {
        quantity = 1;
        logger.info(`  💡 ${cand.stock_code}: positionSize(${Math.round(effectivePositionSize / 10000)}만원) < 주가(${cand.price.currentPrice.toLocaleString()}원) → 최소 1주 매수`, { component: 'TRACK_B' });
      } else {
        logger.info(`  ❌ ${cand.stock_code}: 주가 ${cand.price.currentPrice.toLocaleString()}원 > 잔여현금 ${Math.round(remainingCash).toLocaleString()}원 → 매수불가`, { component: 'TRACK_B' });
        continue;
      }
    }

    const allocStr = ` [비율${(baseAllocPct * modeScale * firstEntryRatio * 100).toFixed(0)}%→${Math.round(effectivePositionSize / 10000)}만원]`;
    const scalpTag = cand.isScalpOverride ? ' [🎯ScalpRadar]' : '';
    decisions.push({
      action: 'BUY',
      stock_code: cand.stock_code,
      quantity,
      price_type: 'MARKET',
      limit_price: cand.price.currentPrice,
      reasoning: `${cand.isScalpOverride ? '🎯 ScalpRadar 스캘핑' : '기술적'} 매수: score=${cand.tech.score}(blend=${blendedScore.toFixed(0)}) cat=${cand.tech.catTrend}/${cand.tech.catMomentum}/${cand.tech.catVolatility}/${cand.tech.catVolume}(${cand.tech.catPositive}/4)${cand.candleBonus > 0 ? `+${cand.candleBonus}캔들` : ''}${idBonus !== 0 ? `${idBonus > 0 ? '+' : ''}${idBonus}분봉` : ''} RSI=${cand.tech.rsi14.toFixed(0)} MACD=${cand.tech.macdCrossover} ADX=${cand.tech.adx14.toFixed(0)}(${cand.tech.trendStrength}) vol=${cand.tech.volumeRatio.toFixed(2)}x SMA=${smaAlign}${cand.tech.goldenCross ? ' 골든크로스' : ''}${isPriority ? ' [우선테마]' : ''}${allocStr}${patternFb.scoreAdj !== 0 ? ` [패턴${patternFb.scoreAdj > 0 ? '+' : ''}${patternFb.scoreAdj}]` : ''}${winRateSummary(cand.stock_code, winRates?.get(cand.stock_code))} fp=${fpKey}${scalpTag}`,
      confidence: Math.min(0.95, Math.max(0.5, cand.tech.score / 100 + getWinRateConfidenceBoost(winRates?.get(cand.stock_code)) + (cand.candleBonus > 0 ? 0.05 : 0))),
      ai_score: aiScore > 0 ? aiScore : cand.tech.score,
      // ScalpRadar 감지 종목: SCALPING 모드로 체인 생성 → TP/SL + forceClose 자동 적용
      ...(cand.isScalpOverride ? { strategy_mode: 'SCALPING', trigger_source: 'SCALP_RADAR' } : {}),
    });

    remainingCash -= quantity * cand.price.currentPrice;
  }

  // 2-b. 현금 추가 소진 패스: 매수 후 남은 현금이 총자산 15% 이상 & AI허락 후보 더 있으면 추가 진입
  // (1차 매수에서 firstEntryRatio로 아낀 여지 + 아직 안 산 후보 종목에 배분)
  // SNIPER: 최대 2종목 제한이므로 추가 소진 패스 건너뜀
  if (totalAssets && remainingCash >= totalAssets * 0.15 && mode !== 'SCALPING' && mode !== 'SNIPER') {
    const alreadyBuying = new Set(decisions.filter(d => d.action === 'BUY').map(d => d.stock_code));
    // 아직 매수 결정 안 된 AI허락 후보만 — 이미 사이클 내 매수한 종목 중복 제외
    const extraCandidates = candidates.filter(c => {
      const score = aiScoreMap.get(c.stock_code) ?? 0;
      return !alreadyBuying.has(c.stock_code) && score >= strategyParams.buyThreshold;
    });
    // 이미 매수 결정한 AI허락 종목에 물타기가 아닌 추가 비중 투입
    for (const cand of extraCandidates.slice(0, 2)) {
      // 확률싸움: AI 고득점 후보 많으면 잔여현금 75% 투입 (기존 50%)
      const extraAiScore = aiScoreMap.get(cand.stock_code) ?? 0;
      const surplusPct = extraAiScore >= 85 ? 0.75 : 0.50;
      const addSize = Math.min(Math.round(remainingCash * surplusPct), effectiveMaxPos);
      const minAddSize = Math.max(10_000, Math.round((totalAssets ?? orderableCash) * 0.03));
      if (addSize < minAddSize) continue;
      const qty = Math.floor(addSize / cand.price.currentPrice);
      if (qty <= 0) continue;
      const aiScoreEx = aiScoreMap.get(cand.stock_code) ?? 0;
      logger.info(`  💰 현금추가투입: ${cand.stock_code} +${Math.round(addSize / 10000)}만원 (남은현금 ${Math.round(remainingCash / 10000)}만원)`, { component: 'TRACK_B' });
      decisions.push({
        action: 'BUY',
        stock_code: cand.stock_code,
        quantity: qty,
        price_type: 'MARKET',
        limit_price: cand.price.currentPrice,
        reasoning: `현금추가투입: AI${aiScoreEx}점 고확신 추가매수 (잔여현금 소진)`,
        confidence: 0.75,
        ai_score: aiScoreEx,
      });
      remainingCash -= qty * cand.price.currentPrice;
    }
  }

  // 3. 보유 종목 물타기 판단
  const avgDownDecisions = await generateAveragingDecisions(params, remainingCash, effectiveMaxPos, splitCount);
  decisions.push(...avgDownDecisions);

  return decisions;
}
