import { analyzeTechnicals, analyzeIntraday } from '../../analysis/indicators.js';
import { getWinRateConfidenceBoost, winRateSummary } from '../../analysis/win-rate.js';
import { config } from '../../config/index.js';
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
    `, [days, config.isPaper]);

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

    // Quarter-Kelly (0.5% ~ 18% 클램프) — 10% 캡은 과도히 보수적이었음
    const quarterKelly = Math.max(0.005, Math.min(0.18, fullKelly * 0.25));

    logger.info(
      `📊 국내 Kelly (${days}d, ${total}건): 승률 ${(winRate * 100).toFixed(0)}%, 평균수익 +${avgWin.toFixed(1)}%, 평균손실 -${avgLoss.toFixed(1)}% → Q-Kelly ${(quarterKelly * 100).toFixed(1)}%`,
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
  const { mode, livePrices, chartData, openChains, orderableCash, maxPositionKrw, totalAssets, winRates, candidates } = params;
  const strategyParams = resolveStrategyParams(mode, params);
  const aiScoreMap = buildAiScoreMap(params.aiScores);
  const noAiScores = hasNoAiScores(params.aiScores);
  const decisions: TradeDecision[] = [];

  // 종목당 최대 비중: SNIPER=30%, 일반=25% (portfolio-guard 집중도 25%와 정합)
  // 소자산(50만 미만): 80%까지 허용 (1-2종목 집중)
  const maxPosFraction = (totalAssets && totalAssets < 500000) ? 0.80
    : mode === 'SNIPER' ? 0.30 : 0.25;
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

  // ─── 분봉 멀티타임프레임 확인 (상위 5개 후보, 장중에만) ──────────────────
  // 프로 트레이더 기준: 일봉 BUY + 15분봉 비하락 + 1분봉 양수 = 3중 확인
  const intradayBonus = new Map<string, number>();
  const intraday15mDown = new Set<string>();  // 15분봉 하락 종목
  if (isMarketOpen() && candidates.length > 0) {
    const top5 = candidates.slice(0, 5);
    await Promise.allSettled(top5.map(async (cand) => {
      try {
        const minuteCandles = await getMinuteChart(cand.stock_code);
        if (minuteCandles.length >= 5) {
          const intraday = analyzeIntraday(minuteCandles);
          intradayBonus.set(cand.stock_code, intraday.score);
          if (intraday.trend15m === 'DOWN') intraday15mDown.add(cand.stock_code);
          logger.info(`  ⏱️ ${cand.stock_code}: 분봉=${intraday.trend}(${intraday.score}) 15m=${intraday.trend15m} VWAP=${intraday.vwapPosition} vol급등=${intraday.volumeSurge} | ${intraday.reason}`, { component: 'TRACK_B' });
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
  // SCALPING: 최대 2종목 (3→2, 상위 고점수 집중 — 분산 시 승률 희석) / SNIPER: 최대 2종목 / 일반: 최대 4종목
  const maxBuys = mode === 'SCALPING' ? 2 : mode === 'SNIPER' ? 2 : 4;
  const splitCount = strategyParams.splitCount || 2;

  for (const cand of candidates.slice(0, maxBuys)) {
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
    const blendedScore = aiScore > 0 ? techScore * 0.5 + aiScore * 0.5 : techScore;

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

    // 황금비율 v2: 확신도 비례 투입 (portfolio-guard 25% 상한과 정합)
    const hardcodedAllocPct = aiApproved
      ? (mode === 'SNIPER'
          // SNIPER: 단일 최고확신 종목 집중 — 총자산의 25/22/20%
          ? (blendedScore >= 90 ? 0.25 :
             blendedScore >= 85 ? 0.22 : 0.20)
          : (blendedScore >= 90 ? 0.22 :   // 90+: 22% (고확신, effectiveMaxPos 25%에 근접)
             blendedScore >= 85 ? 0.18 :   // 85-89: 18%
             blendedScore >= 80 ? 0.12 :   // 80-84: 12% (데이터 경계구간)
             blendedScore >= 75 ? 0.06 :   // 75-79: 소액 탐색 (데드존 해제, 2026-06 성과 검토)
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
    let baseAllocPct = kellyAllocPct ?? getDbAllocPct(blendedScore) ?? hardcodedAllocPct;
    // 소자산(현금 50만 미만): 배분율 최소 30% (있는 돈으로 1-2종목 집중)
    // 중자산(50만~200만): 배분율 최소 20%
    // orderableCash 기준 (totalAssets는 KIS 장애 시 0이 되므로 신뢰 불가)
    if (orderableCash < 500000) {
      baseAllocPct = Math.max(baseAllocPct, 0.30);
    } else if (orderableCash < 2000000) {
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
    // AI허락 고확신(85점+) → 1차에 72~80% 진입 (물타기 여지 20~28% 확보)
    // AI허락 일반(70-84점) → 1차 65~75%
    // AI 미허락 탐색 → 1차 100% (소액이므로 분할 의미 없음)
    const firstEntryRatio = mode === 'SNIPER' ? 1.0   // 저격수: 한 번에 풀 포지션
      : !aiApproved ? 1.0
      : blendedScore >= 85 ? (allocationBoostFirstEntry ? 0.80 : 0.72)  // 72~80% 1차 진입 (물타기 여지 20~28%)
      : splitCount <= 1 ? 1.0
      : splitCount <= 2 ? (allocationBoostFirstEntry ? 0.78 : 0.70) : (allocationBoostFirstEntry ? 0.75 : 0.65);
    // AI 포지션 배율 제거 — AI 90점+ 승률 14.3% (2026-06 성과 검토 결과, 과신 방지)
    const aiPosMultiplier = 1.0;
    const targetKrw = totalAssets
      ? Math.round(totalAssets * baseAllocPct * modeScale * winRateMultiplier * priorityBonus * firstEntryRatio * aiPosMultiplier * signalMultiplier)
      : Math.round(effectiveMaxPos * firstEntryRatio * aiPosMultiplier * signalMultiplier);

    // AI 고확신: 포지션 한도 확대 (최대 총자산 25% 캡 — portfolio-guard 집중도와 일치)
    // 소자산(50만 미만)은 maxPosFraction=80%이므로 별도 상한 적용 안 함
    const concentrationCap = (totalAssets && totalAssets < 500000)
      ? totalAssets * 0.80
      : totalAssets ? totalAssets * 0.25 : Infinity;
    const aiMaxPos = aiPosMultiplier > 1.0 && totalAssets
      ? Math.min(effectiveMaxPos * aiPosMultiplier, concentrationCap)
      : effectiveMaxPos;
    // 상한: aiMaxPos (AI확신도 반영 종목당 한도), 남은 현금의 95%까지 사용 (현금 최대 활용)
    const positionSize = Math.min(targetKrw, aiMaxPos, remainingCash * 0.95);
    // 소자산 모드: 현금 50만 미만이면 남은 현금의 80%를 직접 사용 (배분율/maxPos 무시)
    // totalAssets가 KIS 장애 등으로 0이 되면 effectiveMaxPos도 0이 되므로
    // 실제 잔고(orderableCash) 기준으로 판단
    const isSmallAccount = orderableCash < 500000;
    const effectivePositionSize = isSmallAccount
      ? Math.round(remainingCash * 0.80)   // 있는 돈의 80% 직접 사용 (maxPos 캡 제거)
      : positionSize;
    // 최소 매수금액: 총자산 비례 동적 계산 (고정 금액 제거)
    const minPositionKrw = totalAssets
      ? Math.max(50000, Math.round(totalAssets * (aiApproved ? 0.04 : 0.025)))
      : Math.max(50000, Math.round(orderableCash * (aiApproved ? 0.08 : 0.05)));
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
    decisions.push({
      action: 'BUY',
      stock_code: cand.stock_code,
      quantity,
      price_type: 'MARKET',
      limit_price: cand.price.currentPrice,
      reasoning: `기술적 매수: score=${cand.tech.score}(blend=${blendedScore.toFixed(0)})${cand.candleBonus > 0 ? `+${cand.candleBonus}캔들` : ''}${idBonus !== 0 ? `${idBonus > 0 ? '+' : ''}${idBonus}분봉` : ''} RSI=${cand.tech.rsi14.toFixed(0)} MACD=${cand.tech.macdCrossover} ADX=${cand.tech.adx14.toFixed(0)}(${cand.tech.trendStrength}) vol=${cand.tech.volumeRatio.toFixed(2)}x${cand.tech.goldenCross ? ' 골든크로스' : ''}${isPriority ? ' [우선테마]' : ''}${allocStr}${winRateSummary(cand.stock_code, winRates?.get(cand.stock_code))}`,
      confidence: Math.min(0.95, Math.max(0.5, cand.tech.score / 100 + getWinRateConfidenceBoost(winRates?.get(cand.stock_code)) + (cand.candleBonus > 0 ? 0.05 : 0))),
      ai_score: aiScore > 0 ? aiScore : cand.tech.score, // 점수 기반 TP/SL 계산용
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
      const addSize = Math.min(Math.round(remainingCash * 0.50), effectiveMaxPos);
      const minAddSize = Math.max(50000, Math.round((totalAssets ?? orderableCash) * 0.03));
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
