import { analyzeTechnicals, detectStructuralPatterns, volumeProfile } from '../../analysis/indicators.js';
import { winRateSummary } from '../../analysis/win-rate.js';
import { logger } from '../../utils/logger.js';
import { BUY_BLOCKED_CODES, PRIORITY_SECTOR_CODES, MEGA_CAP_PRIORITY_CODES } from './trading-rules.js';
import { type TechnicalFallbackParams, type BuyCandidate, resolveStrategyParams, buildAiScoreMap, hasNoAiScores } from './technical-fallback-types.js';
import { routeByRegime } from './strategy-router.js';

/**
 * 매수 후보 필터링 (차단/잡주/거래량/ADX/RSI/컨플루언스)
 */
export async function filterBuyCandidates(params: TechnicalFallbackParams): Promise<BuyCandidate[]> {
  const { mode, watchlist, livePrices, chartData, openChains, junkStockCodes, lossBlockedCodes, manuallySoldCodes, recentlySoldCodes, winRates, marketSignals } = params;
  const strategyParams = resolveStrategyParams(mode, params);
  const aiScoreMap = buildAiScoreMap(params.aiScores);
  const noAiScores = hasNoAiScores(params.aiScores);
  const feedbackRequirePullback = params.requirePullback ?? false;
  const feedbackMinVolRatio = params.minVolumeRatio ?? 1.0;

  const openStockCodes = new Set(openChains.map((c) => c.stock_code));
  const candidates: BuyCandidate[] = [];

  for (const stock of watchlist) {
    // 대형 우선주 조기 참조 (buyThreshold, minTechScore, ADX 필터 등에서 사용)
    const megaCap = MEGA_CAP_PRIORITY_CODES.get(stock.stock_code);

    // 이미 포지션 있으면 스킵
    if (openStockCodes.has(stock.stock_code)) continue;

    // CEO 지시: 바이오/손실 종목 매수 차단
    if (BUY_BLOCKED_CODES.has(stock.stock_code)) {
      logger.info(`  🚫 ${stock.stock_code}(${stock.stock_name}): 매수 차단 목록 — 스킵`, { component: 'TRACK_B' });
      continue;
    }
    // 14일 이내 손절 쿨다운 종목 재진입 금지 (AI 70+ 시 쿨다운 무시)
    if (lossBlockedCodes?.has(stock.stock_code)) {
      const aiForCooldown = aiScoreMap.get(stock.stock_code) ?? 0;
      if (aiForCooldown < 70) {
        logger.info(`  🚫 ${stock.stock_code}(${stock.stock_name}): 손절 쿨다운 (14일) — 재진입 금지`, { component: 'TRACK_B' });
        continue;
      }
      logger.info(`  🔓 ${stock.stock_code}(${stock.stock_name}): 손절 쿨다운 무시 (AI ${aiForCooldown}점 ≥ 70)`, { component: 'TRACK_B' });
    }
    // 24시간 이내 CEO 수동 매도 종목 재진입 금지
    if (manuallySoldCodes?.has(stock.stock_code)) {
      logger.info(`  🚫 ${stock.stock_code}(${stock.stock_name}): CEO 수동 매도 쿨다운 (24h) — 재진입 금지`, { component: 'TRACK_B' });
      continue;
    }
    // 2시간 이내 매도 종목 재진입 쿨다운 (반복매수 방지)
    if (recentlySoldCodes?.has(stock.stock_code)) {
      logger.info(`  🕐 ${stock.stock_code}(${stock.stock_name}): 매도 후 2h 쿨다운 — 재진입 대기`, { component: 'TRACK_B' });
      continue;
    }

    // ── 잡주/저품질 종목 필터 (3중 게이트) ─────────────────────────────────
    // 1) 저가주: 2,000원 미만 = 유동성 부족 + 잡주/테마주 위험
    const earlyPrice = livePrices.get(stock.stock_code);
    if (earlyPrice && earlyPrice.currentPrice > 0 && earlyPrice.currentPrice < 2000) {
      logger.info(`  🗑️ ${stock.stock_code}(${stock.stock_name}): 저가주(${earlyPrice.currentPrice}원 < 2000) — 잡주 필터`, { component: 'TRACK_B' });
      continue;
    }
    // 2) 외국인/기관 동반 이탈(STRONG_SELL): 스마트머니가 집단 탈출 중
    if (junkStockCodes?.has(stock.stock_code)) {
      logger.info(`  🗑️ ${stock.stock_code}(${stock.stock_name}): 외국인+기관 동반 이탈(STRONG_SELL) — 잡주 필터`, { component: 'TRACK_B' });
      continue;
    }
    // 3) 구조적 패배 종목: 90일 내 승률 < 25%, 5건 이상 표본 — 개미만 계속 잃는 종목
    const stockWr = winRates?.get(stock.stock_code);
    if (stockWr && stockWr.sampleCount >= 5 && stockWr.winRate < 0.25) {
      logger.info(`  🗑️ ${stock.stock_code}(${stock.stock_name}): 패배 이력 승률=${(stockWr.winRate * 100).toFixed(0)}%(${stockWr.sampleCount}건) — 잡주 필터`, { component: 'TRACK_B' });
      continue;
    }
    // ─────────────────────────────────────────────────────────────────────

    const candles = chartData.get(stock.stock_code);
    const price = livePrices.get(stock.stock_code);
    if (!candles || candles.length < 30 || !price || price.currentPrice <= 0) continue;

    const tech = analyzeTechnicals(candles);
    if (!tech) continue;

    // ── 레짐 라우터: 기존 필터 전에 호출 → 통과 시 빠른 진입 경로 ──
    const closes = candles.map(c => c.close);
    const aiScoreForRoute = aiScoreMap.get(stock.stock_code) ?? 0;
    const regimeRoute = routeByRegime(tech, closes, aiScoreForRoute);

    // 강한 불리쉬 캔들 패턴 감지 (망치형·모닝스타·인걸핑 등 — 진입 타이밍 최적)
    const hasBullishCandle = tech.candlePatterns.some((p) => p.bullish && p.strength === 'STRONG');
    const candleBonus = hasBullishCandle ? 12 : tech.candlePatterns.some((p) => p.bullish && p.strength === 'MODERATE') ? 6 : 0;

    // 각 종목 score 로깅 (디버깅용)
    logger.info(`  📊 ${stock.stock_code}: score=${tech.score}${candleBonus > 0 ? `+${candleBonus}캔들` : ''} RSI=${tech.rsi14.toFixed(0)} ADX=${tech.adx14.toFixed(0)}(${tech.trendStrength}) MACD=${tech.macdCrossover} vol=${tech.volumeRatio.toFixed(2)}x 레짐=${regimeRoute.regime}${regimeRoute.routed ? '✓' : ''}`, { component: 'TRACK_B' });

    const aiScore = aiScoreMap.get(stock.stock_code) ?? 0;
    // 대형 우선주: buyThreshold 하향 (삼성전자/SK하이닉스 등은 변동성 낮아 고점수 안 나옴)
    // 레짐 라우터: TREND_BEAR +25, DISTRIBUTION +15
    const buyThreshold = (megaCap
      ? strategyParams.buyThreshold - megaCap.thresholdReduction
      : strategyParams.buyThreshold) + regimeRoute.buyThresholdAdj;

    // ═══════════════════════════════════════════════════════════════════
    // 병렬 게이트 시스템 (직렬 → 병렬 전환)
    // 하드 게이트: 위에서 처리 완료 (blocked, cooldown, 저가주, 잡주)
    // 품질 게이트: 5개 중 N개 (AI 85+: 2개, 기본: 3개)
    // 리스크 게이트: 3개 중 2개
    // ═══════════════════════════════════════════════════════════════════

    const noAiForStock = noAiScores || aiScore === 0;

    // ─── KIS 시장 시그널 추출 ──────────────────────────────────────────
    const signals = marketSignals?.get(stock.stock_code);
    const intensity = signals?.tradingIntensity?.intensity ?? 0;
    const shortRatio = signals?.shortSelling?.shortRatio ?? 0;
    const bidAskRatio = signals?.orderbookDepth?.bidAskRatio ?? 1;
    const foreignNetEst = signals?.intradayInvestor?.foreignNetEstMil ?? 0;
    const instNetEst = signals?.intradayInvestor?.institutionNetEstMil ?? 0;
    const foreignBrokerBuy = signals?.brokerInfo?.foreignBrokerNetBuy ?? false;
    const lendingRatio = signals?.stockLending?.lendingRatio ?? 0;

    // 시그널 보너스 (기술점수에 가산)
    const signalBonus = (
      (intensity >= 120 ? 6 : intensity >= 105 ? 3 : 0) +     // 체결강도 매수 우위
      (foreignNetEst > 0 && instNetEst > 0 ? 5 : 0) +          // 외국인+기관 동시 순매수
      (foreignBrokerBuy ? 3 : 0) +                              // 외국계 증권사 매수
      (shortRatio > 5 ? -4 : 0) +                               // 공매도 비율 높으면 감점
      (lendingRatio > 10 ? -3 : 0) +                            // 대차잔고 높으면 감점
      (bidAskRatio >= 1.5 ? 3 : bidAskRatio <= 0.6 ? -4 : 0)   // 호가 매수벽/매도벽
    );
    if (signals && signalBonus !== 0) {
      logger.info(`  📡 ${stock.stock_code}: 시그널 체결강도=${intensity.toFixed(0)} 공매도=${shortRatio.toFixed(1)}% 호가비=${bidAskRatio.toFixed(2)} 외인추정=${foreignNetEst}M → ${signalBonus > 0 ? '+' : ''}${signalBonus}점`, { component: 'TRACK_B' });
    }

    // ─── 거래량 보정 (시간대 보정) ───────────────────────────────────────
    const kstNow = new Date(Date.now() + 9 * 3600_000);
    const marketMinutes = (kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes()) - 540;
    const totalMarketMinutes = 390;
    const timeElapsedRatio = Math.max(0.15, Math.min(1.0, marketMinutes / totalMarketMinutes));
    const adjustedVolRatio = tech.volumeRatio / timeElapsedRatio;

    // ─── 보너스 계산 (게이트 판단 전 산출) ──────────────────────────────
    const baseMinTechScore = megaCap ? 45 : mode === 'SCALPING' ? 50 : 55;
    const minTechScore = baseMinTechScore;
    const priorityBonus = megaCap
      ? 10 + megaCap.bonus
      : PRIORITY_SECTOR_CODES.has(stock.stock_code) ? 10 : 0;
    const structPatterns = detectStructuralPatterns(candles);
    const structBonus = structPatterns.reduce((sum, p) => sum + p.score, 0);
    if (structPatterns.length > 0) {
      logger.info(`  🔷 ${stock.stock_code}: 구조패턴 [${structPatterns.map(p => p.label).join(', ')}] → ${structBonus > 0 ? '+' : ''}${structBonus}점`, { component: 'TRACK_B' });
    }
    const vpLevels = volumeProfile(candles);
    const curPrice = price.currentPrice;
    const nearSupport = vpLevels.some(l => l.isSupport && Math.abs(l.priceLevel - curPrice) / curPrice < 0.02);
    const nearResistance = vpLevels.some(l => l.isResistance && Math.abs(l.priceLevel - curPrice) / curPrice < 0.015);
    const vpBonus = nearSupport ? 8 : nearResistance ? -6 : 0;
    if (vpBonus !== 0) {
      logger.info(`  📊 ${stock.stock_code}: 볼륨프로파일 ${nearSupport ? '지지선 근처' : '저항선 근처'} → ${vpBonus > 0 ? '+' : ''}${vpBonus}점`, { component: 'TRACK_B' });
    }
    const recentHigh5 = candles.length >= 6 ? Math.max(...candles.slice(1, 6).map(c => c.high)) : 0;
    const truePullbackPattern = tech.sma20 > 0 && recentHigh5 > tech.sma20 * 1.04 &&
      curPrice >= tech.sma20 * 0.98 && curPrice <= tech.sma20 * 1.05;
    const pullbackBonus = truePullbackPattern ? 12 : 0;
    if (truePullbackPattern) {
      logger.info(`  🎯 ${stock.stock_code}: 눌림목 타점 +12점`, { component: 'TRACK_B' });
    }
    const fibBonus = tech.fibResult?.fibScore ?? 0;
    if (fibBonus > 0 && tech.fibResult) {
      const nearLevel = tech.fibResult.levels.find(l => l.isNear);
      if (nearLevel) {
        logger.info(`  📐 ${stock.stock_code}: 피보나치 ${(nearLevel.level * 100).toFixed(1)}% → +${fibBonus}점`, { component: 'TRACK_B' });
      }
    }

    // 승률피드백: 눌림목 필수 구간
    if (feedbackRequirePullback && !truePullbackPattern && fibBonus === 0 && aiScore < 92) {
      logger.info(`  ⏸️ ${stock.stock_code}: 승률피드백 눌림필수 → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    const effectiveTechScore = tech.score + priorityBonus + candleBonus + structBonus + vpBonus + pullbackBonus + fibBonus + signalBonus;
    const isFibSupport = fibBonus >= 10 && tech.macdCrossover !== 'BEARISH';

    // ─── 품질 게이트 (5개 중 N개 통과) ──────────────────────────────────
    const volThreshold = Math.max(
      feedbackMinVolRatio,
      aiScore >= 80 ? 0.5 : aiScore >= buyThreshold ? 0.8 : noAiForStock ? 0.8 : 1.2,
    );
    const qVolume = adjustedVolRatio >= volThreshold || tech.rsi14 < 35 || hasBullishCandle;
    const qTrendStrength = tech.trendStrength !== 'WEAK' || aiScore >= 80 || !!megaCap;
    const qTrendDirection = (() => {
      if (mode === 'SWING' && tech.sma20 < tech.sma60 && aiScore < 85 && tech.rsi14 >= 30) return false;
      if (mode === 'SWING' && tech.sma5 < tech.sma20 && aiScore < 85 && tech.rsi14 >= 35) return false;
      if (mode === 'DEFENSE' && curPrice < tech.sma20 && aiScore < 65 && tech.score < 50) return false;
      return true;
    })();
    const qRsiTiming = (() => {
      const rsiCap = megaCap ? 80 : 75;
      const aiBypassRsi = aiScore >= buyThreshold && tech.rsi14 <= 80;
      if (tech.rsi14 > rsiCap && !aiBypassRsi) return false;
      // RSI 구간별 타이밍 검증
      const oversoldReversalOk = tech.macdHistogram >= 0 || tech.macdCrossover === 'BULLISH' || tech.rsi2 < 15 || hasBullishCandle || tech.stochasticSignal === 'OVERSOLD';
      const isOversold = tech.rsi14 < 30 && oversoldReversalOk;
      const isEarlyBounce = tech.rsi14 >= 30 && tech.rsi14 < 45 && (tech.macdCrossover !== 'BEARISH' || tech.volumeRatio >= 1.3 || hasBullishCandle);
      const isPullback = tech.rsi14 >= 45 && tech.rsi14 <= 65 && tech.macdCrossover !== 'BEARISH' && (
        truePullbackPattern || isFibSupport || tech.macdCrossover === 'BULLISH' || aiScore >= buyThreshold || effectiveTechScore >= minTechScore
      );
      const isMomentum = tech.rsi14 > 65 && tech.rsi14 <= 75 && (aiScore >= buyThreshold || effectiveTechScore >= minTechScore + 5);
      const isHighConviction = (aiScore >= 80 || effectiveTechScore >= minTechScore + 15) && (effectiveTechScore >= minTechScore || aiScore >= buyThreshold);
      return isOversold || isEarlyBounce || isPullback || isMomentum || isHighConviction || isFibSupport;
    })();
    const qConfluence = (() => {
      if (mode === 'SCALPING') return true;
      const hasStrongCatalyst = tech.bollingerBreakout === 'UP' || tech.ttmSqueeze.fireSignal === 'LONG' || tech.vwapCross === 'JUST_ABOVE' || tech.rsi2 < 10;
      if (hasStrongCatalyst) return true;
      const cf = {
        momentum: tech.macdCrossover !== 'BEARISH' || tech.macdHistogram > 0,
        rsi: tech.rsi14 <= 60 || tech.rsi14 < 30,
        volume: adjustedVolRatio >= 1.2,
        vwap: tech.vwapPosition === 'ABOVE' || tech.vwapPullback,
        pattern: hasBullishCandle || tech.candlePatterns.some(p => p.bullish && p.strength !== 'WEAK'),
        trend: tech.trendStrength !== 'WEAK',
      };
      const cfCount = Object.values(cf).filter(Boolean).length;
      const noAiForCf = noAiScores || aiScore === 0;
      const minCf = aiScore >= 85 ? 1 : aiScore >= 70 ? 2 : noAiForCf ? 2 : 2;
      return cfCount >= minCf;
    })();

    // 시그널 수급 게이트: 체결강도 OR 외국인/기관 추정매수 OR 외국계브로커
    const qSignalFlow = !signals ? true : ( // 시그널 데이터 없으면 통과 (graceful)
      intensity >= 100 || foreignNetEst > 0 || instNetEst > 0 || foreignBrokerBuy
    );

    const qualityChecks = [qVolume, qTrendStrength, qTrendDirection, qRsiTiming, qConfluence, qSignalFlow];
    const qualityPassed = qualityChecks.filter(Boolean).length;
    const minQuality = aiScore >= 85 ? 1 : aiScore >= 70 ? 2 : 3;

    if (qualityPassed < minQuality) {
      logger.info(`  🔍 ${stock.stock_code}: 품질게이트 ${qualityPassed}/${minQuality} 미달 [vol=${qVolume} trend=${qTrendStrength} dir=${qTrendDirection} rsi=${qRsiTiming} cf=${qConfluence} sig=${qSignalFlow}] → 스킵`, { component: 'TRACK_B' });
      continue;
    }

    // ─── 리스크 게이트 (4개 중 2개 통과) ────────────────────────────────
    const rHighChase = (() => {
      if (aiScore >= 95) return true;
      const todayRange = candles[0].high - candles[0].low;
      let priceInRange: number;
      // v2: 고정 100원 → 현재가의 0.3% (10만원 주식=300원, 5천원 주식=15원)
      if (todayRange > curPrice * 0.003) {
        priceInRange = (curPrice - candles[0].low) / todayRange;
      } else {
        const prevClose = Number(candles[1]?.close ?? candles[0].close);
        const gapPct = prevClose > 0 ? (curPrice - prevClose) / prevClose * 100 : 0;
        priceInRange = gapPct >= 2.0 ? 0.90 : gapPct >= 1.0 ? 0.72 : 0.45;
      }
      const hasStrongMomentum = tech.bollingerBreakout === 'UP' || tech.ttmSqueeze.fireSignal === 'LONG' || tech.volumeRatio >= 2.5;
      return priceInRange <= 0.80 || hasStrongMomentum;
    })();
    const rTechScore = effectiveTechScore >= minTechScore || (aiScore >= 85 && effectiveTechScore >= 45);
    const rVolumeProfile = !nearResistance; // 저항선 근처가 아니면 통과
    // 공매도/대차 리스크: 공매도 비율 8%+ 또는 대차잔고 15%+ → 하방 압력 경고
    const rShortPressure = !signals ? true : (shortRatio < 8 && lendingRatio < 15);

    const riskChecks = [rHighChase, rTechScore, rVolumeProfile, rShortPressure];
    const riskPassed = riskChecks.filter(Boolean).length;
    const minRisk = regimeRoute?.regime === 'TREND_BULL' ? 1 : 2;
    if (riskPassed < minRisk) {
      logger.info(`  ⚠️ ${stock.stock_code}: 리스크게이트 ${riskPassed}/${minRisk} 미달 [chase=${rHighChase} tech=${rTechScore} vp=${rVolumeProfile} short=${rShortPressure}] → 스킵`, { component: 'TRACK_B' });
      continue;
    }
    // ═══════════════════════════════════════════════════════════════════

    // ── 레짐 라우터 빠른 진입 경로: routed=true이면 기존 필터 통과로 간주 ──
    if (regimeRoute.routed && mode !== 'SCALPING') {
      // 최소 기술점수 확인만 (절대하한)
      const routeMinScore = 30;
      if (tech.score + candleBonus >= routeMinScore) {
        candidates.push({ stock_code: stock.stock_code, tech, price, candleBonus, regimeRoute });
        logger.info(`  ✅ ${stock.stock_code}: 레짐라우터 진입 [${regimeRoute.reason}] score=${tech.score}`, { component: 'TRACK_B' });
        continue;
      }
    }

    // SCALPING 신규 매수: opening-bell-job(allowScalpingBuys=true)만 허용, Track B 일반 루프는 스킵
    if (mode === 'SCALPING' && !params.allowScalpingBuys) continue;
    // ───────────────────────────────────────────────────────────────────
    // 진입 사유 구성 (병렬 게이트 기반)
    const entryTags = [
      tech.rsi14 < 30 ? '과매도반등' : tech.rsi14 < 45 ? '반등초기' : truePullbackPattern ? '🎯눌림목타점' : isFibSupport ? '📐피보나치지지' : `기술${effectiveTechScore}점`,
      tech.bollingerBreakout === 'UP' ? '🎯BB스퀴즈돌파' : tech.bollingerSqueeze ? '🔃BB응축중' : '',
      tech.vwapCross === 'JUST_ABOVE' ? '⚡VWAP돌파' : tech.vwapPullback ? '🔁VWAP풀백' : '',
      tech.ttmSqueeze.fireSignal === 'LONG' ? `🚀TTM발사(${tech.ttmSqueeze.consecutiveSqueezeOn}봉)` : '',
      tech.rsi2 < 15 ? `📉RSI2(${tech.rsi2.toFixed(0)})` : '',
      regimeRoute.routed ? `레짐${regimeRoute.regime}` : '',
    ].filter(Boolean);
    const entryReason = entryTags.join('+');
    // ─────────────────────────────────────────────────────────────────────

    // AI 필수 게이트: AI=0이면 절대 매수 금지 (기술지표만 진입 → 21% 승률 → 돈만 잃음)
    // 해외(VisionScalp) 59% 승률 = AI 확인 후 진입. 국내도 동일 원칙 적용.
    if (!aiScore || !Number.isFinite(aiScore) || aiScore === 0) {
      logger.info(`  🚫 ${stock.stock_code}: AI 점수 없음 → 매수 차단 (tech=${effectiveTechScore})`, { component: 'TRACK_B' });
      continue;
    }

    // 진입 게이트: 기술점수 충족 OR AI 꽁돈(>=92점, 단 기술점수 절대하한 45점)
    // isKongdon이라도 tech.score 45 미만이면 차단 — AI 과대평가 낙칼 방지
    const isKongdon = aiScore >= 85 && effectiveTechScore >= 45;
    if (effectiveTechScore >= minTechScore || isKongdon) {
      candidates.push({ stock_code: stock.stock_code, tech, price, candleBonus, regimeRoute });
      const wrInfo = winRateSummary(stock.stock_code, winRates?.get(stock.stock_code));
      const bonusStr = [priorityBonus > 0 ? `+${priorityBonus}테마` : '', candleBonus > 0 ? `+${candleBonus}캔들` : '', isKongdon ? `🎰꽁돈(AI${aiScore}점)` : ''].filter(Boolean).join('');
      logger.info(`  ✅ ${stock.stock_code}: 기술=${effectiveTechScore}점(>=${minTechScore})${isKongdon ? ` 꽁돈AI=${aiScore}점` : ''} [${entryReason}] RSI=${tech.rsi14.toFixed(0)} vol=${tech.volumeRatio.toFixed(2)}x → 매수 후보${bonusStr}${wrInfo}`, { component: 'TRACK_B' });
    }
  }

  return candidates;
}
