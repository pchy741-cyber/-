import { getCtxIsPaper } from '../config/context.js';
import { getPool, logSystem } from '../db/client.js';
import { getChangeRankingStocks, getCurrentPrice, getVolumeRankingStocks } from '../kis/market.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { getInvestorFlow } from './investor-flow.js';

/**
 * 워치리스트 자동 순환 (Weekly)
 *
 * - 지난 14일간 AI 스코어 평균이 40점 미만인 종목 → 비활성화
 * - 지난 7일간 AI 스코어 평균이 65점 이상 + 워치리스트 미등록 종목 → 자동 추가
 * - 단, 현재 보유 중인 종목은 절대 제거하지 않음
 * - 주 1회 (일요일 19:00) 실행
 */
const MIN_SCORE_THRESHOLD = 40;
const AUTO_ADD_THRESHOLD = 58;
const EVAL_DAYS = 14;
const ADD_EVAL_DAYS = 7;
const MIN_SCORE_RECORDS = 3;
const MIN_ADD_RECORDS = 3;
const MAX_AUTO_ADD = 8; // 주당 최대 자동 추가 종목 수
const MAX_WATCHLIST_SIZE = 60; // 활성 종목 하드캡

export async function runWatchlistRotation(): Promise<void> {
  logger.info('🔄 워치리스트 자동 순환 시작', { component: 'WATCHLIST_ROTATION' });

  try {
    const pool = getPool();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - EVAL_DAYS);

    const addCutoff = new Date();
    addCutoff.setDate(addCutoff.getDate() - ADD_EVAL_DAYS);

    // 보호 종목: 보유 중 + SEED/MANUAL 소스 (절대 자동 제거 금지)
    const { rows: holdingRows } = await pool.query(
      `SELECT DISTINCT stock_code FROM transaction_chains WHERE status = 'OPEN' AND total_quantity > 0`,
    );
    const holdingCodes = new Set(holdingRows.map((r: Record<string, unknown>) => String(r.stock_code)));
    const { rows: protectedRows } = await pool.query(
      `SELECT stock_code FROM watchlist WHERE source IN ('SEED', 'MANUAL') AND is_active = true`,
    );
    const protectedCodes = new Set([
      ...holdingCodes,
      ...protectedRows.map((r: Record<string, unknown>) => String(r.stock_code)),
    ]);

    // 현재 워치리스트 전체 (활성/비활성 모두)
    const { rows: watchlistRows } = await pool.query(`SELECT stock_code FROM watchlist`);
    const existingCodes = new Set(watchlistRows.map((r: Record<string, unknown>) => String(r.stock_code)));

    // ── 1. 저성과 종목 제거 ──────────────────────────────────────────────
    const { rows: scoreRows } = await pool.query(
      `SELECT stock_code,
              COUNT(*) AS record_count,
              AVG(composite_score) AS avg_score
         FROM ai_scores
        WHERE score_date >= $1
          AND composite_score IS NOT NULL
        GROUP BY stock_code`,
      [cutoff.toISOString().split('T')[0]],
    );

    const removed: string[] = [];
    const skipped: string[] = [];

    for (const row of scoreRows) {
      const code = String(row.stock_code);
      const avgScore = Number(row.avg_score ?? 0);
      const recordCount = Number(row.record_count ?? 0);

      if (!existingCodes.has(code)) continue; // 워치리스트에 없으면 스킵
      if (recordCount < MIN_SCORE_RECORDS) continue;
      if (avgScore >= MIN_SCORE_THRESHOLD) continue;

      if (protectedCodes.has(code)) {
        skipped.push(`${code}(보호, ${avgScore.toFixed(0)}점)`);
        continue;
      }

      await pool.query(`UPDATE watchlist SET is_active = false WHERE stock_code = $1`, [code]);
      logger.info(
        `🗑️ 워치리스트 제거: ${code} — 14일 평균 ${avgScore.toFixed(1)}점 (기준 ${MIN_SCORE_THRESHOLD}점 미달)`,
        { component: 'WATCHLIST_ROTATION' },
      );
      removed.push(`${code}(${avgScore.toFixed(0)}점)`);
    }

    // ── 2. 고점수 신규 종목 자동 추가 ────────────────────────────────────
    // ai_scores는 watchlist FK로 묶여있어 watchlist에 있는 종목만 조회됨
    // inactive 종목 중 고점수인 것을 활성화
    const { rows: addCandidates } = await pool.query(
      `SELECT a.stock_code,
              COUNT(*) AS record_count,
              AVG(a.composite_score) AS avg_score,
              MAX(w.stock_name) AS stock_name
         FROM ai_scores a
         JOIN watchlist w ON w.stock_code = a.stock_code
        WHERE a.score_date >= $1
          AND a.composite_score IS NOT NULL
        GROUP BY a.stock_code
        HAVING COUNT(*) >= $2 AND AVG(a.composite_score) >= $3
        ORDER BY AVG(a.composite_score) DESC
        LIMIT 20`,
      [addCutoff.toISOString().split('T')[0], MIN_ADD_RECORDS, AUTO_ADD_THRESHOLD],
    );

    const added: string[] = [];

    for (const row of addCandidates) {
      if (added.length >= MAX_AUTO_ADD) break;

      const code = String(row.stock_code);
      const avgScore = Number(row.avg_score ?? 0);
      const stockName = String(row.stock_name ?? code);

      if (existingCodes.has(code)) {
        const { rowCount } = await pool.query(
          `UPDATE watchlist SET is_active = true, source = 'AUTO' WHERE stock_code = $1 AND is_active = false`,
          [code],
        );
        if (rowCount && rowCount > 0) {
          logger.info(`♻️ 워치리스트 재활성화: ${code}(${stockName}) — 7일 평균 ${avgScore.toFixed(1)}점`, {
            component: 'WATCHLIST_ROTATION',
          });
          added.push(`${code}(${avgScore.toFixed(0)}점, 재활성화)`);
        }
        continue;
      }

      await pool.query(
        `INSERT INTO watchlist (stock_code, stock_name, is_active, source)
         VALUES ($1, $2, true, 'AUTO')
         ON CONFLICT (stock_code) DO UPDATE SET is_active = true, stock_name = EXCLUDED.stock_name, source = 'AUTO'`,
        [code, stockName],
      );
      existingCodes.add(code); // 중복 추가 방지
      logger.info(`✨ 워치리스트 자동 추가: ${code}(${stockName}) — 7일 평균 ${avgScore.toFixed(1)}점`, {
        component: 'WATCHLIST_ROTATION',
      });
      added.push(`${code}(${avgScore.toFixed(0)}점)`);
    }

    // ── 3. 시장 자동 발굴 — 일요일 순환 시에는 스킵 (평일 daily scan으로 이관) ──
    const marketAdded: string[] = [];

    // ── 4. 결과 리포트 ───────────────────────────────────────────────────
    await logSystem('INFO', 'WATCHLIST_ROTATION', '워치리스트 순환 완료', {
      removed: removed.length,
      added: added.length,
      marketAdded: marketAdded.length,
      skipped: skipped.length,
      removedCodes: removed,
      addedCodes: added,
      marketAddedCodes: marketAdded,
      skippedCodes: skipped,
    });

    const hasChanges = removed.length > 0 || added.length > 0 || marketAdded.length > 0 || skipped.length > 0;
    if (hasChanges) {
      const msg = [
        `🔄 워치리스트 자동 순환 완료`,
        removed.length > 0 ? `제거(${removed.length}): ${removed.join(', ')}` : '',
        added.length > 0 ? `♻️ 재활성(${added.length}): ${added.join(', ')}` : '',
        marketAdded.length > 0 ? `🔍 시장발굴(${marketAdded.length}): ${marketAdded.join(', ')}` : '',
        skipped.length > 0 ? `보유중 유지(${skipped.length}): ${skipped.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await sendTelegramMessage(msg).catch(() => {});
    } else {
      logger.info('워치리스트 순환: 변경 없음', { component: 'WATCHLIST_ROTATION' });
    }
  } catch (error) {
    logger.error(`워치리스트 순환 실패: ${error}`, { component: 'WATCHLIST_ROTATION' });
  }
}

/**
 * 일일 시장 발굴 — 평일 08:50 실행
 *
 * 거래량 상위 + 급등 상위 후보에서 기관·외국인·개인 수급을 검증해
 * 스윙 매매에 적합한 종목만 워치리스트에 편입한다.
 *
 * 수급 점수 기준:
 *   기관+외국인 동시 순매수 → +3
 *   기관 or 외국인 단독 순매수 → +1 each
 *   개인만 순매수(기관+외국인 순매도) → -2 (개인 주도 급등 = 불안정)
 *   외국인 연속 순매수 3일+ → +2 추가
 *
 * 주가 필터: 2,000원~300,000원 (저가주·고가주 제외)
 * 최종: 수급점수 ≥ 1 인 종목만 편입, 하루 최대 10개
 */
export async function runDailyMarketScan(): Promise<void> {
  logger.info('🔍 일일 시장 발굴 + 정리 시작', { component: 'DAILY_MARKET_SCAN' });

  try {
    const pool = getPool();

    // ── 0. 보호 종목: 보유 중 + SEED/MANUAL 소스 ──────────────────────
    const { rows: holdingRows } = await pool.query(
      `SELECT DISTINCT stock_code FROM transaction_chains WHERE status = 'OPEN' AND total_quantity > 0 AND is_paper = $1`,
      [getCtxIsPaper()],
    );
    const holdingCodes = new Set(holdingRows.map((r: Record<string, unknown>) => String(r.stock_code)));
    const { rows: protectedRows } = await pool.query(
      `SELECT stock_code FROM watchlist WHERE source IN ('SEED', 'MANUAL') AND is_active = true`,
    );
    const protectedCodes = new Set([
      ...holdingCodes,
      ...protectedRows.map((r: Record<string, unknown>) => String(r.stock_code)),
    ]);

    // ── 1. 일일 정리 — 상태 나쁜 종목 즉시 비활성화 ─────────────────────
    //   조건 A: 최근 3일 AI 평균 점수 < 35 (심각 저조)
    //   조건 B: 기관+외국인 모두 순매도 AND 외국인 연속 순매도 3일+ (스마트머니 이탈)
    const cutoff3d = new Date();
    cutoff3d.setDate(cutoff3d.getDate() - 5); // 주말 포함해 여유있게 5일치

    const { rows: activeRows } = await pool.query(
      `SELECT w.stock_code, w.stock_name,
              COUNT(a.composite_score) AS record_count,
              AVG(a.composite_score) AS avg_score
         FROM watchlist w
         LEFT JOIN ai_scores a
           ON a.stock_code = w.stock_code AND a.score_date >= $1
        WHERE w.is_active = true
        GROUP BY w.stock_code, w.stock_name`,
      [cutoff3d.toISOString().split('T')[0]],
    );

    const dailyRemoved: string[] = [];

    for (const row of activeRows) {
      const code = String(row.stock_code);
      if (protectedCodes.has(code)) continue; // 보유 중 / SEED / MANUAL → 스킵

      const recordCount = Number(row.record_count ?? 0);
      const avgScore = Number(row.avg_score ?? 50);

      // 스코어 데이터가 있고 낮으면 즉시 정리
      if (recordCount >= 2 && avgScore < 48) {
        await pool.query(`UPDATE watchlist SET is_active = false WHERE stock_code = $1`, [code]);
        dailyRemoved.push(`${code}(${row.stock_name ?? code}, ${avgScore.toFixed(0)}점)`);
        logger.info(`🗑️ 일일정리: ${code}(${row.stock_name}) — 3일 평균 ${avgScore.toFixed(1)}점`, {
          component: 'DAILY_MARKET_SCAN',
        });
        continue;
      }

      // 스마트머니 이탈 체크 (기관+외국인 동시 순매도 + 외국인 연속 3일+)
      if (recordCount >= 1) {
        const flow = await getInvestorFlow(code, 5).catch(() => null);
        if (flow && flow.institutionNet < 0 && flow.foreignNet < 0 && flow.foreignStreak <= -3) {
          await pool.query(`UPDATE watchlist SET is_active = false WHERE stock_code = $1`, [code]);
          dailyRemoved.push(`${code}(${row.stock_name ?? code}, 스마트머니이탈)`);
          logger.info(`🗑️ 일일정리: ${code}(${row.stock_name}) — 기관+외국인 동시 이탈 ${flow.foreignStreak}일`, {
            component: 'DAILY_MARKET_SCAN',
          });
        }
      }
    }

    // ── 2. 발굴 — KOSPI + KOSDAQ 거래량/급등 후보에서 수급 좋은 종목 편입 ──
    const [kospiVol, kosdaqVol, kospiChg, kosdaqChg] = await Promise.all([
      getVolumeRankingStocks('J', 50).catch(() => []),
      getVolumeRankingStocks('Q', 50).catch(() => []),
      getChangeRankingStocks(40, 'J').catch(() => []),
      getChangeRankingStocks(40, 'Q').catch(() => []),
    ]);

    const allRankingStocks = [...kospiVol, ...kosdaqVol, ...kospiChg, ...kosdaqChg];

    if (allRankingStocks.length === 0) {
      logger.warn('시장 발굴: KIS 순위 데이터 없음', { component: 'DAILY_MARKET_SCAN' });
      if (dailyRemoved.length > 0) {
        await sendTelegramMessage(`🗑️ 일일정리(${dailyRemoved.length}): ${dailyRemoved.join(' | ')}`).catch(() => {});
      }
      return;
    }

    logger.info(
      `시장 발굴 후보: KOSPI거래량${kospiVol.length} + KOSDAQ거래량${kosdaqVol.length} + KOSPI급등${kospiChg.length} + KOSDAQ급등${kosdaqChg.length} = 총${allRankingStocks.length}개`,
      { component: 'DAILY_MARKET_SCAN' },
    );

    // 현재 워치리스트 전체 (활성/비활성 구분) — 정리 후 재조회
    const { rows: watchlistRows } = await pool.query(`SELECT stock_code, is_active FROM watchlist`);
    const activeSet = new Set(watchlistRows.filter((r: Record<string, unknown>) => r.is_active).map((r: Record<string, unknown>) => String(r.stock_code)));
    const inactiveSet = new Set(watchlistRows.filter((r: Record<string, unknown>) => !r.is_active).map((r: Record<string, unknown>) => String(r.stock_code)));

    // 중복 제거된 후보 목록 (활성 종목 제외)
    const seen = new Set<string>();
    const candidates: { stock_code: string; stock_name: string }[] = [];
    for (const s of allRankingStocks) {
      if (!s.stock_code || seen.has(s.stock_code) || activeSet.has(s.stock_code)) continue;
      seen.add(s.stock_code);
      candidates.push(s);
    }

    if (candidates.length === 0) {
      logger.info('일일 시장 발굴: 신규 후보 없음 (모두 이미 활성)', { component: 'DAILY_MARKET_SCAN' });
      return;
    }

    // 후보별 수급 + 주가 검증 (병렬, 최대 40개 검사)
    const checkList = candidates.slice(0, 40);
    const scored: { stock_code: string; stock_name: string; score: number; reason: string; isInactive: boolean }[] = [];

    await Promise.allSettled(
      checkList.map(async (s) => {
        try {
          const [price, flow] = await Promise.all([
            getCurrentPrice(s.stock_code).catch(() => null),
            getInvestorFlow(s.stock_code, 5).catch(() => null),
          ]);

          // 주가 범위 필터 (저가주·초고가주 제외)
          if (!price || price.currentPrice < 1000 || price.currentPrice > 600000) return;

          // 국내 제약주 자동편입 차단 (CEO 지시 — 제약은 해외만)
          const sName = (s.stock_name || price.stockName || '').toLowerCase();
          const PHARMA_KEYWORDS = ['제약', '약품', '바이오', '셀', '젠', '팜', '메디', '헬스케어', 'pharm', 'bio'];
          if (PHARMA_KEYWORDS.some(kw => sName.includes(kw))) return;

          let supplyScore = 0;
          const reasons: string[] = [];

          if (flow) {
            const instBuy = flow.institutionNet > 0;
            const foreignBuy = flow.foreignNet > 0;
            const retailOnly = !instBuy && !foreignBuy && flow.retailNet > 0;

            if (instBuy && foreignBuy) {
              supplyScore += 3;
              reasons.push(`기관+외국인 동시순매수`);
            } else {
              if (instBuy) {
                supplyScore += 1;
                reasons.push(`기관순매수`);
              }
              if (foreignBuy) {
                supplyScore += 1;
                reasons.push(`외국인순매수`);
              }
            }
            if (retailOnly) {
              supplyScore -= 2;
              reasons.push(`개인주도(불안)`);
            }
            if (flow.foreignStreak >= 3) {
              supplyScore += 2;
              reasons.push(`외국인연속${flow.foreignStreak}일`);
            }
          }

          if (supplyScore < 1) return; // 수급 불량 제외

          scored.push({
            stock_code: s.stock_code,
            stock_name: s.stock_name,
            score: supplyScore,
            reason: reasons.join(', '),
            isInactive: inactiveSet.has(s.stock_code),
          });
        } catch (err) {
          logger.debug(`시장 발굴 개별 후보 조회 실패: ${err}`, { component: 'DAILY_MARKET_SCAN' });
        }
      }),
    );

    // 활성 종목 하드캡 체크
    const { rows: activeCountRows } = await pool.query(`SELECT COUNT(*) AS cnt FROM watchlist WHERE is_active = true`);
    const currentActiveCount = Number(activeCountRows[0]?.cnt ?? 0);
    const slotsAvailable = Math.max(0, MAX_WATCHLIST_SIZE - currentActiveCount);

    if (slotsAvailable === 0) {
      logger.info(`🚫 감시종목 하드캡 도달 (${currentActiveCount}/${MAX_WATCHLIST_SIZE}) — 신규 편입 스킵`, {
        component: 'DAILY_MARKET_SCAN',
      });
    }

    // 수급 점수 내림차순 정렬 → 슬롯 여유만큼 편입, 최대 10개
    scored.sort((a, b) => b.score - a.score);
    const toAdd = scored.slice(0, Math.min(10, slotsAvailable));

    const newlyAdded: string[] = [];
    const reactivated: string[] = [];

    for (const item of toAdd) {
      if (item.isInactive) {
        await pool.query(`UPDATE watchlist SET is_active = true, source = 'AUTO' WHERE stock_code = $1`, [
          item.stock_code,
        ]);
        reactivated.push(`${item.stock_code}(${item.stock_name}, ${item.reason})`);
        logger.info(`♻️ 재활성: ${item.stock_code}(${item.stock_name}) — ${item.reason}`, {
          component: 'DAILY_MARKET_SCAN',
        });
      } else {
        await pool.query(
          `INSERT INTO watchlist (stock_code, stock_name, market, is_active, source)
           VALUES ($1, $2, 'KOSPI', true, 'AUTO')
           ON CONFLICT (stock_code) DO UPDATE SET is_active = true, stock_name = EXCLUDED.stock_name, source = 'AUTO'`,
          [item.stock_code, item.stock_name || item.stock_code],
        );
        newlyAdded.push(`${item.stock_code}(${item.stock_name}, ${item.reason})`);
        logger.info(`✨ 신규 편입: ${item.stock_code}(${item.stock_name}) — ${item.reason}`, {
          component: 'DAILY_MARKET_SCAN',
        });
      }
    }

    const total = newlyAdded.length + reactivated.length;
    if (total > 0 || dailyRemoved.length > 0) {
      const msg = [
        `🔄 일일 워치리스트 정비`,
        dailyRemoved.length > 0 ? `🗑️ 정리(${dailyRemoved.length}): ${dailyRemoved.join(' | ')}` : '',
        newlyAdded.length > 0 ? `✨ 신규(${newlyAdded.length}): ${newlyAdded.join(' | ')}` : '',
        reactivated.length > 0 ? `♻️ 재활성(${reactivated.length}): ${reactivated.join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await sendTelegramMessage(msg).catch(() => {});
    } else {
      logger.info('일일 정비: 변경 없음', { component: 'DAILY_MARKET_SCAN' });
    }
  } catch (error) {
    logger.error(`일일 시장 발굴 실패: ${error}`, { component: 'DAILY_MARKET_SCAN' });
  }
}

// ── v22: 장중 실시간 발굴 — Track B에서 매수 후보 없을 때 호출 ──
// 2시간 쿨다운, 장중(10:00~14:30)만 실행, 최대 5종목 편입
let _lastMidDayScanAt = 0;
const MIDDAY_SCAN_COOLDOWN_MS = 2 * 60 * 60_000; // 2시간

export async function runMidDayDiscovery(): Promise<string[]> {
  const now = Date.now();
  if (now - _lastMidDayScanAt < MIDDAY_SCAN_COOLDOWN_MS) return [];

  // 장중 시간 체크 (10:00~14:30 KST)
  const kst = new Date(now + 9 * 60 * 60_000);
  const hhmm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  if (hhmm < 1000 || hhmm > 1430) return [];

  _lastMidDayScanAt = now;
  logger.info('🔎 장중 실시간 발굴 시작 (매수 후보 부족)', { component: 'MIDDAY_DISCOVERY' });

  try {
    const pool = getPool();

    // 현재 활성 워치리스트
    const { rows: wRows } = await pool.query(`SELECT stock_code FROM watchlist WHERE is_active = true`);
    const activeSet = new Set(wRows.map((r: Record<string, unknown>) => String(r.stock_code)));

    // 보유 종목
    const { rows: holdRows } = await pool.query(
      `SELECT DISTINCT stock_code FROM transaction_chains WHERE status = 'OPEN' AND total_quantity > 0`,
    );
    const holdingSet = new Set(holdRows.map((r: Record<string, unknown>) => String(r.stock_code)));

    // 거래량+급등 상위 (KRX 실시간)
    const [kospiVol, kosdaqVol, kospiChg, kosdaqChg] = await Promise.all([
      getVolumeRankingStocks('J', 30).catch(() => []),
      getVolumeRankingStocks('Q', 30).catch(() => []),
      getChangeRankingStocks(20, 'J').catch(() => []),
      getChangeRankingStocks(20, 'Q').catch(() => []),
    ]);

    const allStocks = [...kospiVol, ...kosdaqVol, ...kospiChg, ...kosdaqChg];
    const seen = new Set<string>();
    const candidates: { stock_code: string; stock_name: string }[] = [];

    for (const s of allStocks) {
      if (!s.stock_code || seen.has(s.stock_code)) continue;
      if (activeSet.has(s.stock_code) || holdingSet.has(s.stock_code)) continue;
      seen.add(s.stock_code);
      candidates.push(s);
    }

    if (candidates.length === 0) {
      logger.info('장중 발굴: 신규 후보 없음', { component: 'MIDDAY_DISCOVERY' });
      return [];
    }

    // 수급 + 가격 + 잡주 필터 (최대 20개 검사)
    const checkList = candidates.slice(0, 20);
    const scored: { stock_code: string; stock_name: string; score: number; reason: string }[] = [];

    const PHARMA_KEYWORDS = ['제약', '약품', '바이오', '셀', '젠', '팜', '메디', '헬스케어', 'pharm', 'bio'];

    await Promise.allSettled(
      checkList.map(async (s) => {
        try {
          const [price, flow] = await Promise.all([
            getCurrentPrice(s.stock_code).catch(() => null),
            getInvestorFlow(s.stock_code, 3).catch(() => null),
          ]);

          if (!price || price.currentPrice < 3000 || price.currentPrice > 500000) return; // v22: 3000원 미만 잡주 제외
          const sName = (s.stock_name || price.stockName || '').toLowerCase();
          if (PHARMA_KEYWORDS.some(kw => sName.includes(kw))) return;

          // 당일 등락률 체크 — 이미 +8% 이상 급등한 종목은 추격 금지
          if (price.changePct && price.changePct > 8.0) return;

          let supplyScore = 0;
          const reasons: string[] = [];

          if (flow) {
            if (flow.institutionNet > 0 && flow.foreignNet > 0) {
              supplyScore += 3;
              reasons.push('기관+외국인 동시순매수');
            } else if (flow.institutionNet > 0) {
              supplyScore += 1;
              reasons.push('기관순매수');
            } else if (flow.foreignNet > 0) {
              supplyScore += 1;
              reasons.push('외국인순매수');
            }
            if (flow.foreignStreak >= 3) {
              supplyScore += 2;
              reasons.push(`외국인연속${flow.foreignStreak}일`);
            }
            // 개인만 순매수 = 불안정
            if (flow.institutionNet <= 0 && flow.foreignNet <= 0 && flow.retailNet > 0) {
              supplyScore -= 2;
            }
          }

          if (supplyScore < 1) return;

          scored.push({ stock_code: s.stock_code, stock_name: s.stock_name, score: supplyScore, reason: reasons.join(', ') });
        } catch { /* skip */ }
      }),
    );

    // 상위 5개만 편입
    scored.sort((a, b) => b.score - a.score);
    const toAdd = scored.slice(0, 5);
    const added: string[] = [];

    for (const item of toAdd) {
      await pool.query(
        `INSERT INTO watchlist (stock_code, stock_name, market, is_active, source)
         VALUES ($1, $2, 'KOSPI', true, 'MIDDAY')
         ON CONFLICT (stock_code) DO UPDATE SET is_active = true, stock_name = EXCLUDED.stock_name, source = 'MIDDAY'`,
        [item.stock_code, item.stock_name || item.stock_code],
      );
      added.push(item.stock_code);
      logger.info(`🔎 장중 발굴 편입: ${item.stock_code}(${item.stock_name}) — ${item.reason}`, {
        component: 'MIDDAY_DISCOVERY',
      });
    }

    if (added.length > 0) {
      await sendTelegramMessage(`🔎 장중 발굴 ${added.length}종목: ${toAdd.map(t => `${t.stock_code}(${t.stock_name})`).join(', ')}`).catch(() => {});
    }

    return added;
  } catch (error) {
    logger.error(`장중 실시간 발굴 실패: ${error}`, { component: 'MIDDAY_DISCOVERY' });
    return [];
  }
}
