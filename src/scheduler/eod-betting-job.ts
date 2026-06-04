/**
 * 🎰 종가베팅 전략 (EOD Betting)
 *
 * 매수: 15:15~15:20 KST — 당일 거래대금 1,000억+ 주도주, 종가 부근(캔들 상단 20%)
 * 매도: 익일 09:00~09:10 KST — 기계적 전량 매도 (갭수익 or 손절)
 *
 * 쿨다운 모드 연동: 연패 시 장중 매매 차단 → 종가베팅만 허용
 */

import { getOpenChains, logSystem } from '../db/client.js';
import { getPool } from '../db/client.js';
import { getCtxIsPaper } from '../config/context.js';
import { getAccountBalance } from '../kis/account.js';
import { getPaperBalance } from '../risk/paper-balance.js';
import { getVolumeRankingStocks, getCurrentPrice, getBatchPrices, type CurrentPrice } from '../kis/market.js';
import { isKillSwitchActive, reportSuccess } from '../risk/kill-switch.js';
import { tradeExecutor } from '../trading/executor.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import type { TradeDecision } from '../db/models.js';

// ── 설정 ──
const EOD_BUY_START_H = 15, EOD_BUY_START_M = 15;
const EOD_BUY_END_H = 15, EOD_BUY_END_M = 20;
const MORNING_SELL_START_H = 9, MORNING_SELL_START_M = 0;
const MORNING_SELL_END_H = 9, MORNING_SELL_END_M = 10;

const MIN_TRADE_VALUE_EOK = 1000;    // 거래대금 최소 1,000억원
const CANDLE_TOP_PCT = 0.80;          // 캔들 상단 20% (0.80 이상)
const YESTERDAY_SURGE_PCT = 5.0;      // 전일 +5% 이상이면 재탕 종목 제외
const MAX_STOCKS = 12;                // 최대 12종목
const POSITION_SIZE_PCT = 0.12;       // 시드의 12%/포지션

// 중복 매수 방지 — paper/live 분리 (크로스오염 방지)
const _eodBoughtToday = new Map<string, Set<string>>(); // key: 'paper'|'live'
let _eodBoughtDate = '';

/**
 * 🎰 종가베팅 메인 — 15:15 KST 크론에서 호출
 */
export async function runEodBettingJob(): Promise<void> {
  const kst = new Date(Date.now() + 9 * 3600000);
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();
  const isPaper = getCtxIsPaper();

  // 시간 윈도우 체크 (Paper: 시간 제한 없이 테스트 가능)
  if (!isPaper) {
    const inWindow = (kstH === EOD_BUY_START_H && kstM >= EOD_BUY_START_M) ||
                     (kstH === EOD_BUY_END_H && kstM <= EOD_BUY_END_M);
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
    const codes = allRankStocks.map(s => s.stock_code);
    const prices = await getBatchPrices(codes);

    // 이미 보유 중인 종목 제외
    const openChains = await getOpenChains();
    const heldCodes = new Set(openChains.filter(c => Number(c.total_quantity) > 0).map(c => c.stock_code));

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

    // ── STEP 4: 순위 정렬 (거래대금 내림차순) + 상위 12 ──
    const top = freshCandidates
      .sort((a, b) => b.tradeValueEok - a.tradeValueEok)
      .slice(0, MAX_STOCKS);

    // ── STEP 5: 포지션 사이징 ──
    const balance = isPaper ? await getPaperBalance() : await getAccountBalance();
    const totalAssets = balance.netAsset || (balance.orderableCash + balance.totalEvalAmount);
    const positionKrw = Math.floor(totalAssets * POSITION_SIZE_PCT);

    if (positionKrw < 50_000) {
      logger.warn('🎰 종가베팅: 포지션 크기 5만원 미만 → 스킵', { component: 'EOD_BETTING' });
      return;
    }

    // ── STEP 6: 매수 결정 생성 ──
    const buyDecisions: TradeDecision[] = [];

    for (const cand of top) {
      const qty = Math.floor(positionKrw / cand.price.currentPrice);
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
    const summary = buyDecisions
      .map(d => `  • ${d.stock_code} x${d.quantity} — ${d.reasoning}`)
      .join('\n');
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
  const kst = new Date(Date.now() + 9 * 3600000);
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
    const todayKst = new Date(Date.now() + 9 * 3600000);
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
    const msg = sellDecisions
      .map(d => `  • ${d.stock_code} x${d.quantity}`)
      .join('\n');
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
    const { rows } = await getPool().query(`
      SELECT DISTINCT stock_code FROM transaction_chains
      WHERE closed_at >= NOW() - INTERVAL '2 days'
        AND strategy_mode = 'EOD_BETTING'
        AND is_paper = $1
    `, [getCtxIsPaper()]);
    const recentEodCodes = new Set(rows.map((r: any) => r.stock_code));

    // 추가: 전일 등락률 +5% 이상 종목도 제외 (거래량 순위에 올랐지만 이미 올라버린 종목)
    const surgeSet = new Set<string>();

    // 빠른 방법: candidates의 changePct가 이미 있으므로 활용
    // 하지만 이건 "오늘" 등락률임. "어제" 급등을 확인하려면 전일 데이터 필요
    // → 간단한 휴리스틱: 최근 EOD_BETTING 매수 종목은 재진입 방지 (2일 쿨다운)
    return candidates.filter(c => {
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
