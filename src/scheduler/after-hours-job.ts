import { getActiveWatchlist, getOpenChains, logSystem, getAllRecentScores } from '../db/client.js';
import { getBatchPrices, getDailyChart, getBatchInvestorFlow } from '../kis/market.js';
import type { CurrentPrice } from '../kis/market.js';
import { isKillSwitchActive, reportSuccess } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { EOD_BLUECHIP_CODES } from '../ai/track-b/eod-bluechip.js';
import { fetchKospiRegime } from '../ai/track-b/market-regime.js';
import { analyzeTechnicals, type TechnicalSummary } from '../analysis/indicators.js';
import { getCtxIsPaper } from '../config/context.js';
import type { StrategyMode } from '../config/constants.js';
import { getActiveStrategy } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { runBottomFishingScanner } from '../automation/bottom-fishing-scanner.js';
import type { TradeDecision } from '../db/models.js';

// ── 중복 매수 방지: 오늘 이미 주문한 종목 추적 (paper/live 모드별 분리) ──
const _todayBoughtCodes = new Map<string, Set<string>>(); // key: 'paper'|'live'
let _todayBoughtDate = '';

/**
 * 🧠 스마트 장외 매매 전략 v2
 *
 * 기존: 단순 -1.5% 하락 → 매수 (승률 ~25%)
 * 개선: 5축 멀티팩터 스코어링 → 고품질 매수만 (목표 승률 60%+)
 *
 * 5축 스코어링:
 *   1. 기술지표 (RSI, BB, SMA, 캔들패턴, MACD) → 0~40점
 *   2. AI 점수 (Track A composite_score) → -15~+20점
 *   3. 스마트머니 (기관/외인 수급) → -15~+20점
 *   4. 하락 품질 (거래량, 하락폭) → 0~15점
 *   5. 쿨다운 (최근 매수 이력) → 0 or -999점
 *
 * 매수 기준: 종합 40점 이상, 상위 3종목만
 */

interface ScoredCandidate {
  code: string;
  price: CurrentPrice;
  score: number;
  reasons: string[];
  tech: TechnicalSummary | null;
}

/**
 * 5축 멀티팩터 스코어링
 */
function scoreCandidate(
  code: string,
  price: CurrentPrice,
  tech: TechnicalSummary | null,
  aiComposite: number | null,
  instNet: number,
  foreignNet: number,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // ═══ 1축: 기술지표 (0~40점) ═══
  if (tech) {
    // RSI(14) 과매도
    if (tech.rsi14 < 25) { score += 20; reasons.push(`RSI${tech.rsi14.toFixed(0)}`); }
    else if (tech.rsi14 < 35) { score += 12; reasons.push(`RSI${tech.rsi14.toFixed(0)}`); }
    else if (tech.rsi14 < 45) { score += 5; }

    // RSI(2) 극단적 과매도 (단기 반등 확률 극대화)
    if (tech.rsi2 < 10) { score += 10; reasons.push('RSI2극단'); }
    else if (tech.rsi2 < 20) { score += 5; reasons.push(`RSI2=${tech.rsi2.toFixed(0)}`); }

    // 볼린저밴드 위치 (하단 돌파 = 과매도 확인)
    if (tech.bollingerPosition === 'BELOW_LOWER') { score += 8; reasons.push('BB하단'); }

    // 이동평균 추세 — 핵심 필터
    if (tech.deathCross) {
      score -= 20; reasons.push('데드크로스');
    } else if (tech.sma5 > tech.sma20 && tech.sma20 > tech.sma60) {
      score += 10; reasons.push('정배열풀백');
    } else if (tech.sma5 > tech.sma20) {
      score += 5; reasons.push('단기상승');
    }

    // 반전 캔들 패턴 (해머, 모닝스타 등)
    const bullishPatterns = tech.candlePatterns.filter(
      (p) => p.bullish && (p.name.includes('Hammer') || p.name.includes('Engulfing') || p.name.includes('Morning')),
    );
    if (bullishPatterns.length > 0) {
      score += 8;
      reasons.push(bullishPatterns[0].name.includes('Hammer') ? '해머' : '반전캔들');
    }

    // MACD 모멘텀
    if (tech.macdCrossover === 'BULLISH') { score += 5; reasons.push('MACD+'); }

    // 풀백 시그널
    if (tech.pullbackSignal) { score += 4; reasons.push('풀백'); }

    // 거래량 급증 (캐피추레이션 = 바닥 신호)
    if (tech.volumeRatio > 3) { score += 10; reasons.push(`거래량${tech.volumeRatio.toFixed(1)}x`); }
    else if (tech.volumeRatio > 2) { score += 6; reasons.push(`거래량${tech.volumeRatio.toFixed(1)}x`); }
    else if (tech.volumeRatio > 1.5) { score += 3; }
  }

  // ═══ 2축: AI 점수 (-15~+20점) ═══
  if (aiComposite != null && aiComposite > 0) {
    if (aiComposite >= 65) { score += 20; reasons.push(`AI${aiComposite}`); }
    else if (aiComposite >= 55) { score += 12; reasons.push(`AI${aiComposite}`); }
    else if (aiComposite >= 45) { score += 5; }
    else if (aiComposite < 35) { score -= 15; reasons.push(`AI약${aiComposite}`); }
  }

  // ═══ 3축: 스마트머니 수급 (-15~+20점) ═══
  const instBuy = instNet > 0;
  const forgBuy = foreignNet > 0;
  if (instBuy && forgBuy) { score += 20; reasons.push('기관외인매수'); }
  else if (instBuy) { score += 12; reasons.push('기관매수'); }
  else if (forgBuy) { score += 8; reasons.push('외인매수'); }
  else if (instNet < 0 && foreignNet < 0) { score -= 15; reasons.push('기관외인매도'); }

  // ═══ 4축: 하락 품질 (0~15점) ═══
  const drop = Math.abs(price.changePct);
  // 적정 하락 구간 (-2% ~ -8%)이 최적 — 너무 적으면 반등 약하고 너무 크면 펀더멘탈 문제
  if (drop >= 2 && drop <= 5) { score += 10; reasons.push(`낙폭${price.changePct.toFixed(1)}%`); }
  else if (drop > 5 && drop <= 8) { score += 8; reasons.push(`급락${price.changePct.toFixed(1)}%`); }
  else if (drop > 8 && drop <= 12) { score += 3; reasons.push(`폭락${price.changePct.toFixed(1)}%`); }
  else if (drop > 12) { score -= 10; reasons.push(`위험낙폭${price.changePct.toFixed(1)}%`); }

  // 블루칩 보너스 (삼성전자, SK하이닉스, 한화에어로)
  if ((EOD_BLUECHIP_CODES as readonly string[]).includes(code)) {
    score += 5; reasons.push('블루칩');
  }

  return { score, reasons };
}

export async function runAfterHoursJob(): Promise<void> {
  const kst = getKSTNow();
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();

  const isPaper = getCtxIsPaper();

  // 15:40~15:55 에서만 실행 (Paper 모드: 시간 제한 없이 테스트 가능)
  if (!isPaper && (kstH !== 15 || kstM < 40 || kstM > 55)) {
    logger.debug('시간외: 시간 범위 밖 — 스킵', { component: 'AFTER_HOURS' });
    return;
  }

  // 중복 매수 방지: 날짜 변경 시 리셋
  const todayStr = kst.toISOString().split('T')[0];
  if (_todayBoughtDate !== todayStr) {
    _todayBoughtCodes.clear();
    _todayBoughtDate = todayStr;
  }
  const modeKey = isPaper ? 'paper' : 'live';
  if (!_todayBoughtCodes.has(modeKey)) _todayBoughtCodes.set(modeKey, new Set());

  logger.info(`🌙 시간외 잡 시작 (${isPaper ? 'paper' : 'live'})`, { component: 'AFTER_HOURS' });

  try {
    // ═══════════════════════════════════════════════════════════
    //  STEP 0: 보유종목 수익확정 매도 (매도=탈출, Kill Switch 무관)
    // ═══════════════════════════════════════════════════════════
    const openChains = await getOpenChains();

    if (openChains.length > 0) {
      const holdingCodes = openChains.map((c) => c.stock_code);
      const holdingPrices = await getBatchPrices(holdingCodes);

      const sellDecisions: TradeDecision[] = [];
      for (const chain of openChains) {
        if (chain.total_quantity <= 0) continue;
        const avgBuy = Number(chain.avg_buy_price);
        if (avgBuy <= 0) continue;
        const priceData = holdingPrices.get(chain.stock_code);
        const curPrice = priceData?.currentPrice ?? 0;
        if (curPrice <= 0) continue;
        const pnlPct = ((curPrice - avgBuy) / avgBuy) * 100;

        if (pnlPct >= 1.0) {
          logger.info(
            `🌙 시간외 수익확정: ${chain.stock_code} +${pnlPct.toFixed(2)}% (평단 ${avgBuy.toLocaleString()} → 현재 ${curPrice.toLocaleString()})`,
            { component: 'AFTER_HOURS' },
          );
          sellDecisions.push({
            action: 'SELL',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `시간외 수익확정: +${pnlPct.toFixed(2)}% (장마감 후 단일가 매도)`,
            confidence: 0.9,
          });
        } else {
          logger.info(
            `🌙 시간외 패스: ${chain.stock_code} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% → 익일 판단`,
            { component: 'AFTER_HOURS' },
          );
        }
      }

      if (sellDecisions.length > 0) {
        const strategy = await getActiveStrategy();
        const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
        await tradeExecutor.processDecisions(sellDecisions, mode, 'AFTER_HOURS');
        reportSuccess();
        const sellSummary = sellDecisions.map((d) => `  • ${d.stock_code} x${d.quantity} — ${d.reasoning}`).join('\n');
        await sendTelegramMessage(`🌙 시간외 수익확정 매도 ${sellDecisions.length}건\n${sellSummary}`).catch(() => {});
        await logSystem('INFO', 'AFTER_HOURS', `시간외 수익확정: ${sellDecisions.length}건 매도`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    //  STEP 1: 🧠 스마트 장외 매수 (5축 멀티팩터 스코어링)
    // ═══════════════════════════════════════════════════════════
    if (isKillSwitchActive()) {
      logger.debug('🛑 Kill Switch 활성 — 시간외 매수 스킵', { component: 'AFTER_HOURS' });
      return;
    }

    // 1-A. 바닥낚시 스캐너 (시장 전체 RSI 과매도 스캔)
    let scannedStocks: Awaited<ReturnType<typeof runBottomFishingScanner>> = [];
    try {
      scannedStocks = await runBottomFishingScanner();
      if (scannedStocks.length > 0) {
        logger.info(
          `🎣 바닥낚시 스캐너: ${scannedStocks.length}종목 — ${scannedStocks.map((s) => `${s.stock_name}(${s.changePct.toFixed(1)}%)`).join(', ')}`,
          { component: 'AFTER_HOURS' },
        );
      }
    } catch (err) {
      logger.warn(`바닥낚시 스캐너 실패 (무시): ${err}`, { component: 'AFTER_HOURS' });
    }

    // 1-B. 후보 종목 수집 + 시세 조회
    const [watchlist, latestChains] = await Promise.all([getActiveWatchlist(), getOpenChains()]);
    const watchlistCodes = watchlist.map((w) => w.stock_code);
    const scannedCodes = scannedStocks.map((s) => s.stock_code);
    const allCodes = [...new Set([...EOD_BLUECHIP_CODES, ...watchlistCodes, ...scannedCodes])];
    const livePrices = await getBatchPrices(allCodes);

    // 1-C. 1차 필터: 하락 종목만 추출 (API 호출 최소화)
    const heldCodes = new Set(latestChains.filter((c) => Number(c.total_quantity) > 0).map((c) => c.stock_code));
    const dropCandidates: { code: string; price: CurrentPrice }[] = [];

    for (const code of allCodes) {
      if (_todayBoughtCodes.get(modeKey)!.has(code)) continue;  // 오늘 이미 주문
      if (heldCodes.has(code)) continue;                 // 이미 보유
      const p = livePrices.get(code);
      if (!p || p.currentPrice <= 0) continue;
      if (p.changePct > -1.5) continue;                  // 최소 -1.5% 하락
      if (p.changePct < -15) continue;                   // -15% 초과 = 위험 (상폐/악재)
      dropCandidates.push({ code, price: p });
    }

    if (dropCandidates.length === 0) {
      logger.info('🧠 스마트장외: 하락 후보 0종목 → 매수 없음', { component: 'AFTER_HOURS' });
      return;
    }

    logger.info(`🧠 스마트장외: 1차 필터 ${dropCandidates.length}종목 → 멀티팩터 분석 시작`, { component: 'AFTER_HOURS' });

    // 1-D. 멀티팩터 데이터 수집 (병렬)
    const candCodes = dropCandidates.map((c) => c.code);
    const [chartResults, aiScoresAll, investorFlows] = await Promise.all([
      Promise.allSettled(candCodes.map((c) => getDailyChart(c, 60))),
      getAllRecentScores(),
      getBatchInvestorFlow(candCodes),
    ]);

    // AI 점수 Map 변환
    const aiScoreMap = new Map<string, number>();
    for (const s of aiScoresAll) {
      if (s.composite_score != null) aiScoreMap.set(s.stock_code, s.composite_score);
    }

    // 1-E. 5축 스코어링
    const scored: ScoredCandidate[] = dropCandidates.map((cand, i) => {
      const chartResult = chartResults[i];
      const candles = chartResult.status === 'fulfilled' ? chartResult.value : [];
      const tech = candles.length >= 30 ? analyzeTechnicals(candles) : null;
      const aiComp = aiScoreMap.get(cand.code) ?? null;
      const flow = investorFlows.get(cand.code);

      const { score, reasons } = scoreCandidate(
        cand.code,
        cand.price,
        tech,
        aiComp,
        flow?.institutionNet ?? 0,
        flow?.foreignNet ?? 0,
      );

      return { code: cand.code, price: cand.price, score, reasons, tech };
    });

    // 1-F. 순위 정렬 + 컷오프 (40점 이상, 상위 3종목)
    const qualified = scored
      .filter((c) => c.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // 로그: 전체 스코어링 결과
    for (const c of scored.sort((a, b) => b.score - a.score)) {
      const status = c.score >= 40 ? '✅' : '❌';
      logger.info(
        `  🧠 ${status} ${c.code}: ${c.score}점 [${c.reasons.join(', ')}] (${c.price.changePct.toFixed(1)}%)`,
        { component: 'AFTER_HOURS' },
      );
    }

    if (qualified.length === 0) {
      logger.info(`🧠 스마트장외: 40점 이상 종목 없음 (최고 ${scored[0]?.score ?? 0}점) → 매수 없음`, { component: 'AFTER_HOURS' });
      return;
    }

    // 1-G. 포지션 크기 계산
    const balance = latestChains.reduce((sum, c) => {
      const p = livePrices.get(c.stock_code)?.currentPrice ?? Number(c.avg_buy_price ?? 0);
      return sum + p * Number(c.total_quantity ?? 0);
    }, 0);
    const maxPosKrw = Math.max(500_000, balance * 0.10);

    // 1-H. 매수 결정 생성 (점수 비례 포지션 사이징)
    const buyDecisions: TradeDecision[] = [];
    for (const c of qualified) {
      const sizePct = c.score >= 70 ? 0.40 : c.score >= 55 ? 0.30 : 0.25;
      const qty = Math.floor((maxPosKrw * sizePct) / c.price.currentPrice);
      if (qty <= 0) continue;
      buyDecisions.push({
        action: 'BUY',
        stock_code: c.code,
        quantity: qty,
        price_type: 'LIMIT',
        limit_price: c.price.currentPrice,
        reasoning: `스마트장외 [${c.score}점] ${c.reasons.join(',')} (${c.price.changePct.toFixed(1)}%)`,
        confidence: Math.min(0.95, 0.5 + c.score / 200),
      });
    }

    if (buyDecisions.length === 0) {
      logger.info('🧠 스마트장외: 수량 계산 후 매수 대상 없음', { component: 'AFTER_HOURS' });
      return;
    }

    // 1-I. 매매 실행
    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
    await tradeExecutor.processDecisions(buyDecisions, mode, 'AFTER_HOURS');
    reportSuccess();

    // 중복 매수 방지: 주문 기록
    for (const d of buyDecisions) _todayBoughtCodes.get(modeKey)!.add(d.stock_code);

    // 1-J. 텔레그램 알림
    const msg = buyDecisions
      .map((d) => `  • 🧠 ${d.stock_code} x${d.quantity} — ${d.reasoning}`)
      .join('\n');
    await sendTelegramMessage(`🧠 스마트장외 매수 ${buyDecisions.length}건\n${msg}`).catch(() => {});
    await logSystem('INFO', 'AFTER_HOURS', `스마트장외: ${buyDecisions.length}건 (${qualified.map((q) => `${q.code}=${q.score}점`).join(', ')})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`시간외 잡 실패: ${msg}`, { component: 'AFTER_HOURS' });
    await logSystem('ERROR', 'AFTER_HOURS', `시간외 잡 실패: ${msg}`);
  }
}
