/**
 * 🎯 종가 개떡락 줍줍 전략 (Closing Bell Dip Buy)
 *
 * 전략: 장마감 직전 당일 급락한 감시목록 종목 매수 → 다음날 이후 Track B TP/SL 청산
 *
 * 실행: 15:10 KST (runner.ts: '10 15 * * 1-5')
 *
 * 필터 조건:
 *   1. 감시목록 종목만 (CEO가 직접 관리한 우량주)
 *   2. 당일 하락률 -5% ~ -15% (개떡락 zone)
 *   3. 거래량 비율 ≥ 2.0 (공황 매도 신호 — 진짜 낙폭과대)
 *   4. AI 스코어 ≥ 75 (DB ai_scores 기준, 오늘 Track B 분석 점수)
 *   5. 최대 3종목 (오버나이트 분산)
 *
 * 청산: Track B 표준 TP/SL (BOTTOM_FISHING: +6% / -2.5%, 최대 5영업일)
 * 포지션 크기: maxPositionKrw × 0.5 (오버나이트 할인)
 */

import { getActiveWatchlist, getOpenChains, getLatestScores, logSystem } from '../db/client.js';
import { getBatchPrices, getDailyChart } from '../kis/market.js';
import { analyzeTechnicals } from '../analysis/indicators.js';
import { callVertexGemini } from '../utils/vertex-gemini.js';
import { getAccountBalance, invalidateBalanceCache } from '../kis/account.js';
import { getPaperBalance } from '../risk/paper-balance.js';
import { tradeExecutor } from '../trading/executor.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';
import { isKillSwitchActive, reportSuccess } from '../risk/kill-switch.js';
import { isRiskOffToday } from '../automation/market-routing.js';
import { getCtxIsPaper } from '../config/context.js';
import { config } from '../config/index.js';
import type { TradeDecision } from '../db/models.js';

// ── 필터 파라미터 ──
const DIP_MIN_PCT = -15.0;   // 하락률 하한 (-15% 이하는 뭔가 문제 있는 종목)
const DIP_MAX_PCT = -5.0;    // 하락률 상한 (-5% 이상 하락이어야 개떡락)
const MIN_VOLUME_RATIO = 2.0; // 거래량 비율 최소 (공황매도 확인)
const MIN_AI_SCORE = 75;     // AI 스코어 최소 (우량 감시목록 확인)
const MAX_STOCKS = 3;        // 최대 3종목 (오버나이트 집중 방지)
const POSITION_OVERNIGHT_DISC = 0.5; // 포지션 크기 50% 할인 (오버나이트 리스크)
const MIN_POSITION_KRW = 100_000;    // 최소 10만원

// 중복 매수 방지 (당일 1회)
const _boughtToday = new Map<string, Set<string>>(); // key: 'paper'|'live'
let _boughtDate = '';

/**
 * 🎯 종가 개떡락 줍줍 — 15:10 KST 크론에서 호출
 */
export async function runClosingBellJob(): Promise<void> {
  const kst = getKSTNow();
  const kstH = kst.getUTCHours();
  const kstM = kst.getUTCMinutes();
  const isPaper = getCtxIsPaper();

  // 15:05~15:20 구간만 실행 (Paper는 항상)
  if (!isPaper && (kstH !== 15 || kstM < 5 || kstM > 20)) return;

  if (isKillSwitchActive()) {
    logger.debug('🛑 Kill Switch 활성 — 종가줍줍 스킵', { component: 'CLOSING_BELL' });
    return;
  }

  if (isRiskOffToday()) {
    logger.info('🚨 Risk-Off — 종가줍줍 스킵', { component: 'CLOSING_BELL' });
    return;
  }

  // 날짜 변경 시 리셋
  const todayStr = kst.toISOString().split('T')[0];
  if (_boughtDate !== todayStr) {
    _boughtToday.clear();
    _boughtDate = todayStr;
  }

  const modeKey = isPaper ? 'paper' : 'live';
  logger.info(`🎯 종가줍줍 스캔 시작 (${isPaper ? 'paper' : 'live'}, ${kstH}:${String(kstM).padStart(2, '0')})`, { component: 'CLOSING_BELL' });

  try {
    // ── STEP 1: 감시목록 + 실시간 시세 ──
    const [watchlist, openChains] = await Promise.all([
      getActiveWatchlist(),
      getOpenChains(),
    ]);

    if (watchlist.length === 0) {
      logger.warn('[CLOSING_BELL] 감시목록 비어있음', { component: 'CLOSING_BELL' });
      return;
    }

    const stockCodes = watchlist.map(w => w.stock_code);
    const livePrices = await getBatchPrices(stockCodes);
    const heldCodes = new Set(openChains.filter(c => Number(c.total_quantity) > 0).map(c => c.stock_code));
    const alreadyBought = _boughtToday.get(modeKey) ?? new Set<string>();

    // ── STEP 2: 당일 하락률 필터 (-5% ~ -15%) ──
    const dipCandidates: Array<{
      code: string;
      name: string;
      changePct: number;
      currentPrice: number;
    }> = [];

    for (const w of watchlist) {
      const p = livePrices.get(w.stock_code);
      if (!p || p.currentPrice <= 0) continue;
      if (heldCodes.has(w.stock_code)) continue;        // 이미 보유 중
      if (alreadyBought.has(w.stock_code)) continue;    // 오늘 이미 매수

      const dropPct = p.changePct; // 당일 등락률 (%)
      if (dropPct > DIP_MAX_PCT || dropPct < DIP_MIN_PCT) continue;

      dipCandidates.push({
        code: w.stock_code,
        name: w.stock_name,
        changePct: dropPct,
        currentPrice: p.currentPrice,
      });
    }

    logger.info(`🎯 하락률 필터(${DIP_MAX_PCT}%~${DIP_MIN_PCT}%): ${dipCandidates.length}종목`, { component: 'CLOSING_BELL' });
    if (dipCandidates.length === 0) {
      logger.info('[CLOSING_BELL] 개떡락 조건 충족 종목 없음 → 종료', { component: 'CLOSING_BELL' });
      return;
    }

    // ── STEP 3: 차트 로드 + 거래량 비율 필터 ──
    const chartResults = await Promise.allSettled(
      dipCandidates.map(c => getDailyChart(c.code, 30)),
    );

    const volFiltered: Array<{
      code: string;
      name: string;
      changePct: number;
      currentPrice: number;
      volumeRatio: number;
    }> = [];

    for (let i = 0; i < dipCandidates.length; i++) {
      const cand = dipCandidates[i];
      const result = chartResults[i];
      if (result.status !== 'fulfilled' || result.value.length < 10) continue;

      const tech = analyzeTechnicals(result.value);
      if (!tech) continue;
      if (tech.volumeRatio < MIN_VOLUME_RATIO) {
        logger.debug(`[CLOSING_BELL] ${cand.code} 거래량 부족 (${tech.volumeRatio.toFixed(1)}x < ${MIN_VOLUME_RATIO}x)`, { component: 'CLOSING_BELL' });
        continue;
      }

      volFiltered.push({ ...cand, volumeRatio: tech.volumeRatio });
    }

    logger.info(`🎯 거래량 필터(≥${MIN_VOLUME_RATIO}x): ${volFiltered.length}종목`, { component: 'CLOSING_BELL' });
    if (volFiltered.length === 0) {
      logger.info('[CLOSING_BELL] 거래량 조건 충족 종목 없음 → 종료', { component: 'CLOSING_BELL' });
      return;
    }

    // ── STEP 4: AI 스코어 필터 (DB ai_scores, ≥75점) ──
    const aiScoreRows = await getLatestScores(volFiltered.map(c => c.code));
    const scoreMap = new Map(aiScoreRows.map(s => [s.stock_code, Number(s.composite_score ?? 0)]));

    const scoreFiltered = volFiltered.filter(c => {
      const score = scoreMap.get(c.code) ?? 0;
      if (score < MIN_AI_SCORE) {
        logger.debug(`[CLOSING_BELL] ${c.code} AI점수 부족 (${score} < ${MIN_AI_SCORE})`, { component: 'CLOSING_BELL' });
        return false;
      }
      return true;
    });

    logger.info(`🎯 AI점수 필터(≥${MIN_AI_SCORE}): ${scoreFiltered.length}종목`, { component: 'CLOSING_BELL' });

    // AI점수 필터 통과 종목이 없으면 → 거래량 상위 후보로 fallback (점수 60+ 조건 완화)
    let finalCandidates = scoreFiltered;
    if (finalCandidates.length === 0 && volFiltered.length > 0) {
      const FALLBACK_SCORE = 60;
      const fallback = volFiltered.filter(c => (scoreMap.get(c.code) ?? 0) >= FALLBACK_SCORE);
      if (fallback.length > 0) {
        logger.info(`[CLOSING_BELL] AI점수 fallback(≥${FALLBACK_SCORE}): ${fallback.length}종목`, { component: 'CLOSING_BELL' });
        finalCandidates = fallback;
      } else {
        logger.info('[CLOSING_BELL] AI점수 조건 충족 종목 없음 → 종료', { component: 'CLOSING_BELL' });
        return;
      }
    }

    // ── STEP 5: Gemini 재평가 (선택적) ──
    if (config.geminiEnabled && finalCandidates.length > 0) {
      try {
        const prompt = `당신은 한국 주식 장마감 반등 전략 전문가입니다.
아래 종목들은 오늘 5~15% 급락했으나 거래량이 평소의 2배 이상입니다.
감시목록에 포함된 우량주로, 내일 반등 가능성을 0~100으로 평가하세요.

평가 기준:
- 낙폭이 5~10% 구간이면 반등 신호로 적합 (가점)
- 거래량 급증은 공황 매도 완료 신호 (가점)
- 낙폭이 12% 이상이면 추가 하락 가능성 주의 (감점)
- 섹터/시장 전반 하락이면 개별 반등 제한 (감점)
- 전일 대비 거래량 3배 이상이면 바닥 신호 (가점)

JSON만 반환 (다른 텍스트 없이):
{"scores":[{"code":"종목코드","score":점수,"reason":"한줄사유"},...]}`;

        const details = finalCandidates.map(c => ({
          code: c.code,
          name: c.name,
          changePct: c.changePct.toFixed(1),
          volumeRatio: c.volumeRatio.toFixed(1),
          aiScore: scoreMap.get(c.code) ?? 0,
        }));

        const raw = await callVertexGemini(prompt, JSON.stringify(details), {
          temperature: 0.1,
          maxOutputTokens: 512,
          label: '종가줍줍-평가',
        });

        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { scores?: Array<{ code: string; score: number; reason: string }> };
          for (const s of parsed.scores ?? []) {
            if (s.code && typeof s.score === 'number') {
              // Gemini 점수와 DB 점수를 70:30으로 블렌딩
              const dbScore = scoreMap.get(s.code) ?? s.score;
              const blended = Math.round(s.score * 0.7 + dbScore * 0.3);
              scoreMap.set(s.code, blended);
              logger.info(`🤖 [CLOSING_BELL] ${s.code} Gemini: ${s.score}점 → 블렌드: ${blended}점 (${s.reason})`, { component: 'CLOSING_BELL' });
            }
          }
        }
      } catch (gemErr) {
        logger.warn(`[CLOSING_BELL] Gemini 재평가 실패 (DB 점수로 진행): ${gemErr}`, { component: 'CLOSING_BELL' });
      }
    }

    // ── STEP 6: 점수 내림차순 정렬 + 상위 MAX_STOCKS 종목 ──
    const top = finalCandidates
      .sort((a, b) => (scoreMap.get(b.code) ?? 0) - (scoreMap.get(a.code) ?? 0))
      .slice(0, MAX_STOCKS);

    // ── STEP 7: 포지션 사이징 ──
    if (!isPaper) invalidateBalanceCache();
    const balance = isPaper ? await getPaperBalance() : await getAccountBalance(true);
    const orderableCash = balance.orderableCash;

    const basePositionKrw = config.risk.maxPositionKrw;
    const overnightPositionKrw = Math.floor(basePositionKrw * POSITION_OVERNIGHT_DISC);
    const cashPerStock = Math.floor(orderableCash * 0.90 / top.length);
    const effectivePositionKrw = Math.min(overnightPositionKrw, cashPerStock);

    if (effectivePositionKrw < MIN_POSITION_KRW) {
      logger.warn(`[CLOSING_BELL] 포지션 ${effectivePositionKrw.toLocaleString()}원 < 최소 ${MIN_POSITION_KRW.toLocaleString()}원 → 잔고 부족`, { component: 'CLOSING_BELL' });
      return;
    }

    logger.info(`🎯 사이징: ${overnightPositionKrw.toLocaleString()}원/종목 (기본${basePositionKrw.toLocaleString()} × 50% 오버나이트 할인), ${top.length}종목`, { component: 'CLOSING_BELL' });

    // ── STEP 8: 매수 결정 생성 ──
    const buyDecisions: TradeDecision[] = [];

    for (const cand of top) {
      const qty = Math.floor(effectivePositionKrw / cand.currentPrice);
      if (qty <= 0) continue;

      const score = scoreMap.get(cand.code) ?? 0;

      buyDecisions.push({
        action: 'BUY',
        stock_code: cand.code,
        quantity: qty,
        price_type: 'MARKET',
        reasoning: `🎯 개떡락줍줍: ${cand.changePct.toFixed(1)}% 하락 vol=${cand.volumeRatio.toFixed(1)}x AI=${score} (BOTTOM_FISHING TP+6% SL-2.5%)`,
        confidence: Math.min(0.90, 0.65 + score / 500),
        strategy_mode: 'BOTTOM_FISHING',
        trigger_source: 'CLOSING_BELL',
      });

      logger.info(
        `  🎯 ${cand.code} ${cand.name}: ${cand.changePct.toFixed(1)}% 하락 | 거래량 ${cand.volumeRatio.toFixed(1)}x | AI ${score}점 | ${qty}주 × ${cand.currentPrice.toLocaleString()}원`,
        { component: 'CLOSING_BELL' },
      );
    }

    if (buyDecisions.length === 0) {
      logger.info('[CLOSING_BELL] 수량 계산 후 매수 대상 없음', { component: 'CLOSING_BELL' });
      return;
    }

    // ── STEP 9: 매수 실행 ──
    await tradeExecutor.processDecisions(buyDecisions, 'BOTTOM_FISHING', 'CLOSING_BELL');
    reportSuccess();

    if (!_boughtToday.has(modeKey)) _boughtToday.set(modeKey, new Set());
    for (const d of buyDecisions) _boughtToday.get(modeKey)!.add(d.stock_code);

    // ── STEP 10: 알림 ──
    const summary = buyDecisions
      .map(d => `  • ${d.stock_code} ×${d.quantity} — ${d.reasoning}`)
      .join('\n');
    await sendTelegramMessage(`🎯 종가줍줍 매수 ${buyDecisions.length}건\n${summary}\n📌 Track B TP+6%/SL-2.5% 청산`).catch(() => {});
    await logSystem('INFO', 'CLOSING_BELL', `개떡락줍줍: ${buyDecisions.length}건 매수`);

    logger.info(`🎯 종가줍줍 완료: ${buyDecisions.length}종목 매수 (BOTTOM_FISHING 모드)`, { component: 'CLOSING_BELL' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`종가줍줍 실패: ${msg}`, { component: 'CLOSING_BELL' });
    await logSystem('ERROR', 'CLOSING_BELL', `종가줍줍 실패: ${msg}`);
  }
}
