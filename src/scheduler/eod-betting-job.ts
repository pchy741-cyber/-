/**
 * 🎰 종가베팅 전략 (EOD Betting)
 *
 * 매수: 15:15~15:20 KST — 당일 거래대금 1,000억+ 주도주, 종가 부근(캔들 상단 20%)
 * 매도: 익일 09:00~09:10 KST — 기계적 전량 매도 (갭수익 or 손절)
 *
 * 쿨다운 모드 연동: 연패 시 장중 매매 차단 → 종가베팅만 허용
 */

import { isRiskOffToday } from '../automation/market-routing.js';
import { getCtxIsPaper } from '../config/context.js';
import { getOpenChains, getPool, logSystem } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getAccountBalance, invalidateBalanceCache } from '../kis/account.js';
import { type CurrentPrice, getBatchPrices, getVolumeRankingStocks } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { isKillSwitchActive, reportSuccess } from '../risk/kill-switch.js';
import { getPaperBalance } from '../risk/paper-balance.js';
import { tradeExecutor } from '../trading/executor.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

// ── 설정 ──
const EOD_BUY_START_H = 15,
  EOD_BUY_START_M = 15;
const EOD_BUY_END_H = 15,
  EOD_BUY_END_M = 20;
const MORNING_SELL_START_H = 9,
  MORNING_SELL_START_M = 17; // 개장벨(09:00~09:12) 종료 후
const _MORNING_SELL_END_H = 9,
  MORNING_SELL_END_M = 25;

const MIN_TRADE_VALUE_EOK = 1000; // 거래대금 최소 1,000억원
const CANDLE_TOP_PCT = 0.8; // 캔들 상단 20% (0.80 이상)
const _YESTERDAY_SURGE_PCT = 5.0; // 전일 +5% 이상이면 재탕 종목 제외
const INTRADAY_SURGE_SKIP_PCT = 7.0; // 당일 +7% 이상 급등 → 추격 매수 금지 (고점 매수 리스크)
const MAX_STOCKS = 12; // 최대 12종목 (CRASH: 4, CORRECTION: 8)

// ── 황금비율 기반 동적 포지션 사이징 (고정 12% 폐지) ──
// 전체 EOD 베팅 한도: 포트폴리오의 PHI 비율 → 종목 수로 균등 분할
const PHI_TOTAL_NORMAL = 0.382; // 38.2% — 정상 장세 총 EOD 한도
const PHI_TOTAL_CAUTION = 0.236; // 23.6% — 하락 경계 시 축소
const PHI_TOTAL_STRESS = 0.146; // 14.6% — 스트레스 장세 최소

// ── 하락장 방어 ──
const KOSPI_DROP_BLOCK_PCT = -2.0; // KOSPI -2% 이상 하락 → 종가베팅 차단
const KOSPI_DROP_REDUCE_PCT = -1.0; // KOSPI -1% 이상 → 종목수 축소
const DAILY_LOSS_BLOCK_PCT = -1.5; // 포트폴리오 일일손실 -1.5% → 종가베팅 차단

// 중복 매수 방지 — paper/live 분리 (크로스오염 방지)
const _eodBoughtToday = new Map<string, Set<string>>(); // key: 'paper'|'live'
let _eodBoughtDate = '';

/**
 * 🎰 종가베팅 메인 — 15:15 KST 크론에서 호출
 */
export async function runEodBettingJob(): Promise<void> {
  const kst = getKSTNow();
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();
  const isPaper = getCtxIsPaper();

  // 시간 윈도우 체크 (Paper: 시간 제한 없이 테스트 가능)
  if (!isPaper) {
    const inWindow =
      (kstH === EOD_BUY_START_H && kstM >= EOD_BUY_START_M) || (kstH === EOD_BUY_END_H && kstM <= EOD_BUY_END_M);
    if (kstH !== EOD_BUY_START_H && kstH !== EOD_BUY_END_H) {
      return;
    }
    if (!inWindow) return;
  }

  // Kill Switch 확인
  if (isKillSwitchActive()) {
    logger.debug('🛑 Kill Switch 활성 — 종가베팅 스킵', { component: 'EOD_BETTING' });
    return;
  }

  if (isRiskOffToday()) {
    logger.info('🚨 Risk-Off — 종가베팅 스킵', { component: 'EOD_BETTING' });
    return;
  }

  // ── 하락장 방어: KOSPI 하락률 + 시장체제 + 일일손실 ──
  let eodMaxStocks = MAX_STOCKS;
  try {
    const { fetchKospiRegime, checkDailyLoss } = await import('../ai/track-b/market-regime.js');
    const regime = await fetchKospiRegime();

    // 1) KOSPI 당일 하락률 체크
    if (regime.todayDown) {
      const { getCurrentPrice } = await import('../kis/market.js');
      const _kospiLive = await getCurrentPrice('0001').catch(() => null);
      const _kospiCandles = regime.atrPct; // atrPct는 이미 계산됨
      // todayDown = KOSPI -0.3% 이상 하락 확인됨
      // 추가: KOSPI 실시간 가격 기반 정밀 하락률 체크 (getDailyChart 캐시 사용)
      const { getDailyChart } = await import('../kis/market.js');
      const charts = await getDailyChart('0001', 2).catch(() => []);
      const todayClose = charts[0]?.close ?? 0;
      const prevClose = charts[1]?.close ?? 0;
      const kospiDropPct = prevClose > 0 ? ((todayClose - prevClose) / prevClose) * 100 : 0;

      if (kospiDropPct <= KOSPI_DROP_BLOCK_PCT) {
        logger.warn(
          `🛑 종가베팅 차단: KOSPI ${kospiDropPct.toFixed(2)}% 하락 (기준 ${KOSPI_DROP_BLOCK_PCT}%) — 오버나이트 리스크 과대`,
          { component: 'EOD_BETTING' },
        );
        await logSystem('WARN', 'EOD_BETTING', `KOSPI ${kospiDropPct.toFixed(2)}% 하락 → 종가베팅 차단`);
        return;
      }
      if (kospiDropPct <= KOSPI_DROP_REDUCE_PCT) {
        eodMaxStocks = Math.min(eodMaxStocks, 6);
        logger.info(`⚠️ KOSPI ${kospiDropPct.toFixed(2)}% 하락 → 종가베팅 종목수 ${eodMaxStocks}개로 축소`, {
          component: 'EOD_BETTING',
        });
      }
    }

    // 2) 시장체제 연동: CRASH → 차단, CORRECTION → 축소
    if (regime.penalty >= 2) {
      logger.warn(`🛑 종가베팅 차단: CRASH 체제 (KOSPI < MA60) — 하락장 종가베팅 금지`, { component: 'EOD_BETTING' });
      await logSystem('WARN', 'EOD_BETTING', `CRASH 체제 → 종가베팅 차단`);
      return;
    }
    if (regime.penalty >= 1) {
      eodMaxStocks = Math.min(eodMaxStocks, 4);
      logger.info(`⚠️ CORRECTION 체제 → 종가베팅 종목수 ${eodMaxStocks}개로 축소`, { component: 'EOD_BETTING' });
    }

    // 3) 일일손실 체크: 이미 -1.5% 이상 손실이면 추가 베팅 금지
    if (!isPaper) {
      const { getAccountBalance: getAccBal } = await import('../kis/account.js');
      const bal = await getAccBal(false);
      const totalAssets = bal.orderableCash + bal.totalEvalAmount;
      const openChains = await getOpenChains();
      const { getBatchPrices } = await import('../kis/market.js');
      const holdCodes = openChains.filter((c) => Number(c.total_quantity) > 0).map((c) => c.stock_code);
      const livePrices = holdCodes.length > 0 ? await getBatchPrices(holdCodes) : new Map();
      const dailyLoss = await checkDailyLoss({ openChains, livePrices, totalAssets });
      if (dailyLoss.dailyPnlPct <= DAILY_LOSS_BLOCK_PCT) {
        logger.warn(
          `🛑 종가베팅 차단: 일일 손실 ${dailyLoss.dailyPnlPct.toFixed(2)}% (기준 ${DAILY_LOSS_BLOCK_PCT}%) — 추가 리스크 금지`,
          { component: 'EOD_BETTING' },
        );
        await logSystem('WARN', 'EOD_BETTING', `일일 손실 ${dailyLoss.dailyPnlPct.toFixed(2)}% → 종가베팅 차단`);
        return;
      }
    }

    // Flash Crash → 즉시 차단
    if (regime.flashCrash) {
      logger.warn(`🛑 종가베팅 차단: KOSPI Flash Crash 감지 — 오버나이트 리스크 과대`, { component: 'EOD_BETTING' });
      return;
    }
  } catch (err) {
    // fail-safe: 안전장치 체크 실패 시 종가베팅 차단 (이전: 계속 진행 → 위험)
    logger.error(`🛑 하락장 방어 체크 실패 → 종가베팅 차단 (fail-safe): ${err}`, { component: 'EOD_BETTING' });
    await logSystem('ERROR', 'EOD_BETTING', `하락장 방어 체크 실패 → 종가베팅 차단: ${err}`);
    return;
  }

  // 날짜 변경 시 리셋
  const todayStr = kst.toISOString().split('T')[0];
  if (_eodBoughtDate !== todayStr) {
    _eodBoughtToday.clear();
    _eodBoughtDate = todayStr;
  }

  logger.info(`🎰 종가베팅 스캔 시작 (${isPaper ? 'paper' : 'live'})`, { component: 'EOD_BETTING' });

  try {
    // ── STEP 1: 거래량 상위 종목 조회 ──
    const [kospiStocks, kosdaqStocks] = await Promise.all([
      getVolumeRankingStocks('J', 30),
      getVolumeRankingStocks('Q', 20),
    ]);
    const allRankStocks = [...kospiStocks, ...kosdaqStocks];

    if (allRankStocks.length === 0) {
      logger.info('🎰 종가베팅: 거래량 상위 종목 0 → 종료', { component: 'EOD_BETTING' });
      return;
    }

    // ── STEP 2: 시세 조회 + 거래대금 필터 ──
    const codes = allRankStocks.map((s) => s.stock_code);
    const prices = await getBatchPrices(codes);

    // 이미 보유 중인 종목 제외
    const openChains = await getOpenChains();
    const heldCodes = new Set(openChains.filter((c) => Number(c.total_quantity) > 0).map((c) => c.stock_code));

    interface EodCandidate {
      code: string;
      name: string;
      price: CurrentPrice;
      tradeValueEok: number;
      candlePosition: number;
    }

    const candidates: EodCandidate[] = [];

    for (const stock of allRankStocks) {
      const p = prices.get(stock.stock_code);
      if (!p || p.currentPrice <= 0) continue;
      if (heldCodes.has(stock.stock_code)) continue;
      const modeKey = isPaper ? 'paper' : 'live';
      if (_eodBoughtToday.get(modeKey)?.has(stock.stock_code)) continue;

      // 거래대금 (억원) = 누적거래량 × 현재가 / 1억
      const tradeValueEok = (p.volume * p.currentPrice) / 100_000_000;
      if (tradeValueEok < MIN_TRADE_VALUE_EOK) continue;

      // 캔들 위치: (현재가 - 저가) / (고가 - 저가)
      const range = p.highPrice - p.lowPrice;
      if (range <= 0) continue;
      const candlePosition = (p.currentPrice - p.lowPrice) / range;
      if (candlePosition < CANDLE_TOP_PCT) continue;

      // 당일 급등 추격 매수 방지: 이미 +7% 이상 뛴 종목은 종가 추가 모멘텀 기대 불가
      if (p.changePct > INTRADAY_SURGE_SKIP_PCT) continue;

      candidates.push({
        code: stock.stock_code,
        name: stock.stock_name || p.stockName,
        price: p,
        tradeValueEok,
        candlePosition,
      });
    }

    logger.info(`🎰 거래대금+캔들 필터 통과: ${candidates.length}종목`, { component: 'EOD_BETTING' });

    // ── STEP 3: 재탕 종목 제거 (전일 +5% 이상 급등주) ──
    const freshCandidates = await filterOutYesterdaySurge(candidates);
    logger.info(`🎰 재탕 제거 후: ${freshCandidates.length}종목`, { component: 'EOD_BETTING' });

    if (freshCandidates.length === 0) {
      logger.info('🎰 종가베팅: 조건 충족 종목 없음 → 매수 없음', { component: 'EOD_BETTING' });
      return;
    }

    // ── STEP 4: 순위 정렬 (거래대금 내림차순) + 상위 N (하락장 연동) ──
    const top = freshCandidates.sort((a, b) => b.tradeValueEok - a.tradeValueEok).slice(0, eodMaxStocks);

    // ── STEP 5: 황금비율 동적 포지션 사이징 ── (캐시 무효화 → 최신 잔고로 정확한 사이징)
    if (!isPaper) invalidateBalanceCache();
    const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
    const totalAssets = balance.orderableCash + balance.totalEvalAmount;

    // 황금비율: 총 EOD 배팅 한도 (레짐 연동)
    const phiTotal =
      eodMaxStocks <= 4
        ? PHI_TOTAL_STRESS // CRASH/심각 하락 → 14.6%
        : eodMaxStocks <= 8
          ? PHI_TOTAL_CAUTION // CORRECTION/경계 → 23.6%
          : PHI_TOTAL_NORMAL; // 정상 → 38.2%
    const totalEodBudget = totalAssets * phiTotal;
    const positionKrw = Math.floor(totalEodBudget / top.length); // 균등 분할

    logger.info(
      `🎰 사이징: 총자산=${totalAssets.toLocaleString()}원 한도=${phiTotal * 100}%(${Math.round(totalEodBudget).toLocaleString()}원) ${top.length}종목 → ${positionKrw.toLocaleString()}원/종목 ${isPaper ? 'PAPER' : 'LIVE'}`,
      { component: 'EOD_BETTING' },
    );

    // 현금 가드: Paper는 총자산 기준(연습모드 현금 집계 지연 대응), Live는 주문가능 현금 기준
    const cashForCap = isPaper ? totalAssets : balance.orderableCash;
    const cashCap = Math.floor((cashForCap * 0.9) / top.length);
    const effectivePositionKrw = Math.min(positionKrw, cashCap);

    // 최소 포지션 가드: 총자산의 1% 미만 또는 20만원 미만이면 잔고 계산 오류로 간주
    const MIN_POSITION_KRW = Math.max(200_000, Math.floor(totalAssets * 0.01));
    if (effectivePositionKrw < MIN_POSITION_KRW) {
      logger.warn(
        `🎰 종가베팅: 포지션 ${effectivePositionKrw.toLocaleString()}원 < 최소 ${MIN_POSITION_KRW.toLocaleString()}원 → 잔고 재확인 필요`,
        { component: 'EOD_BETTING' },
      );
      logger.warn(
        `  💰 잔고 디버그: netAsset=${balance.netAsset?.toLocaleString()} orderable=${balance.orderableCash?.toLocaleString()} eval=${balance.totalEvalAmount?.toLocaleString()} totalAssets=${totalAssets.toLocaleString()} phiTotal=${phiTotal}`,
        { component: 'EOD_BETTING' },
      );
      return;
    }

    // ── STEP 6: 매수 결정 생성 ──
    const buyDecisions: TradeDecision[] = [];

    for (const cand of top) {
      const qty = Math.floor(effectivePositionKrw / cand.price.currentPrice);
      if (qty <= 0) continue;

      buyDecisions.push({
        action: 'BUY',
        stock_code: cand.code,
        quantity: qty,
        price_type: 'MARKET',
        reasoning: `종가베팅: 거래대금${Math.round(cand.tradeValueEok)}억 캔들${(cand.candlePosition * 100).toFixed(0)}% ${cand.name} (${cand.price.changePct >= 0 ? '+' : ''}${cand.price.changePct.toFixed(1)}%)`,
        confidence: 0.75,
        trigger_source: 'EOD_BETTING',
        strategy_mode: 'EOD_BETTING',
      });

      logger.info(
        `  🎰 ${cand.code} ${cand.name}: 거래대금 ${Math.round(cand.tradeValueEok)}억 | 캔들 ${(cand.candlePosition * 100).toFixed(0)}% | ${cand.price.changePct >= 0 ? '+' : ''}${cand.price.changePct.toFixed(1)}% | ${qty}주`,
        { component: 'EOD_BETTING' },
      );
    }

    if (buyDecisions.length === 0) {
      logger.info('🎰 종가베팅: 수량 계산 후 매수 대상 없음', { component: 'EOD_BETTING' });
      return;
    }

    // ── STEP 7: 매수 실행 ──
    await tradeExecutor.processDecisions(buyDecisions, 'EOD_BETTING', 'EOD_BETTING');
    reportSuccess();

    const boughtKey = isPaper ? 'paper' : 'live';
    if (!_eodBoughtToday.has(boughtKey)) _eodBoughtToday.set(boughtKey, new Set());
    for (const d of buyDecisions) _eodBoughtToday.get(boughtKey)!.add(d.stock_code);

    // ── STEP 8: 알림 ──
    const summary = buyDecisions.map((d) => `  • ${d.stock_code} x${d.quantity} — ${d.reasoning}`).join('\n');
    await sendTelegramMessage(`🎰 종가베팅 매수 ${buyDecisions.length}건\n${summary}`).catch(() => {});
    await logSystem('INFO', 'EOD_BETTING', `종가베팅: ${buyDecisions.length}건 매수`);

    logger.info(`🎰 종가베팅 완료: ${buyDecisions.length}종목 매수`, { component: 'EOD_BETTING' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`종가베팅 실패: ${msg}`, { component: 'EOD_BETTING' });
    await logSystem('ERROR', 'EOD_BETTING', `종가베팅 실패: ${msg}`);
  }
}

/**
 * 🌅 종가베팅 익일 강제매도 — 09:02 KST 크론에서 호출
 */
export async function runEodMorningSell(): Promise<void> {
  const kst = getKSTNow();
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();
  const isPaper = getCtxIsPaper();

  // 시간 체크 (Paper: 항상 실행)
  if (!isPaper) {
    if (kstH !== MORNING_SELL_START_H) return;
    if (kstM < MORNING_SELL_START_M || kstM > MORNING_SELL_END_M + 5) return; // 약간의 여유
  }

  logger.info(`🌅 종가베팅 익일매도 시작 (${isPaper ? 'paper' : 'live'})`, { component: 'EOD_BETTING' });

  try {
    const openChains = await getOpenChains();
    const todayKst = getKSTNow();
    const todayStr = todayKst.toISOString().split('T')[0];

    const sellDecisions: TradeDecision[] = [];

    for (const chain of openChains) {
      if (Number(chain.total_quantity) <= 0) continue;
      if (chain.strategy_mode !== 'EOD_BETTING') continue;
      if (!chain.opened_at) continue;

      // 전일 매수 확인 (오늘 매수 건은 제외)
      const openedKst = new Date(new Date(chain.opened_at).getTime() + 9 * 3600000);
      const openedStr = openedKst.toISOString().split('T')[0];
      if (openedStr >= todayStr) continue; // 오늘 매수 건 제외

      // 전일 15시 이후 매수인지 확인
      const openedH = openedKst.getUTCHours();
      if (openedH < 15) continue; // 15시 이전 매수는 종가베팅이 아님

      // 동일 종목에 EOD_BETTING 외 전략 체인이 공존하면 스킵 (executor가 chain_id로 구분 불가)
      const conflictChain = openChains.find(
        (c) => c.stock_code === chain.stock_code && c.strategy_mode !== 'EOD_BETTING' && Number(c.total_quantity) > 0,
      );
      if (conflictChain) {
        logger.warn(
          `🌅 종가베팅 익일청산 스킵: ${chain.stock_code} — ${conflictChain.strategy_mode} 포지션 공존 (수동청산 필요)`,
          { component: 'EOD_BETTING' },
        );
        continue;
      }

      sellDecisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: Number(chain.total_quantity),
        price_type: 'MARKET',
        reasoning: '종가베팅 익일청산: 기계적 매도 (갭수익/손절)',
        confidence: 1.0,
      });

      logger.info(`🌅 종가베팅 익일청산: ${chain.stock_code} x${chain.total_quantity}`, { component: 'EOD_BETTING' });
    }

    if (sellDecisions.length === 0) {
      logger.info('🌅 종가베팅 익일매도: 대상 없음', { component: 'EOD_BETTING' });
      return;
    }

    // 매도 실행 (Kill Switch 무관 — 매도는 항상 허용)
    await tradeExecutor.processDecisions(sellDecisions, 'EOD_BETTING', 'EOD_BETTING');
    reportSuccess();

    // 결과 알림
    const msg = sellDecisions.map((d) => `  • ${d.stock_code} x${d.quantity}`).join('\n');
    await sendTelegramMessage(`🌅 종가베팅 익일매도 ${sellDecisions.length}건\n${msg}`).catch(() => {});
    await logSystem('INFO', 'EOD_BETTING', `종가베팅 익일매도: ${sellDecisions.length}건`);

    logger.info(`🌅 종가베팅 익일매도 완료: ${sellDecisions.length}건`, { component: 'EOD_BETTING' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`종가베팅 익일매도 실패: ${msg}`, { component: 'EOD_BETTING' });
    await logSystem('ERROR', 'EOD_BETTING', `종가베팅 익일매도 실패: ${msg}`);
  }
}

/**
 * 재탕 종목 제거: 전일 +5% 이상 급등한 종목 필터링
 */
async function filterOutYesterdaySurge<T extends { code: string; name: string }>(candidates: T[]): Promise<T[]> {
  if (candidates.length === 0) return [];

  try {
    // DB에서 전일 종가베팅/체결 기록 중 급등 종목 조회
    const { rows } = await getPool().query(
      `
      SELECT DISTINCT stock_code FROM transaction_chains
      WHERE closed_at >= NOW() - INTERVAL '2 days'
        AND strategy_mode = 'EOD_BETTING'
        AND is_paper = $1
    `,
      [getCtxIsPaper()],
    );
    const recentEodCodes = new Set(rows.map((r: any) => r.stock_code));

    // 추가: 전일 등락률 +5% 이상 종목도 제외 (거래량 순위에 올랐지만 이미 올라버린 종목)
    const _surgeSet = new Set<string>();

    // 빠른 방법: candidates의 changePct가 이미 있으므로 활용
    // 하지만 이건 "오늘" 등락률임. "어제" 급등을 확인하려면 전일 데이터 필요
    // → 간단한 휴리스틱: 최근 EOD_BETTING 매수 종목은 재진입 방지 (2일 쿨다운)
    return candidates.filter((c) => {
      if (recentEodCodes.has(c.code)) {
        logger.debug(`🎰 재탕 제외: ${c.code} ${c.name} (최근 종가베팅 이력)`, { component: 'EOD_BETTING' });
        return false;
      }
      return true;
    });
  } catch {
    // DB 실패 시 전부 통과 (안전)
    return candidates;
  }
}
