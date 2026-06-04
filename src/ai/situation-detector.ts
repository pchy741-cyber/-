/**
 * Situation Detector — 규칙으로 판단 불가능한 상황을 자동 감지하고 큐에 적재
 *
 * 10분마다 AutoPilot과 함께 실행.
 * "무엇을 판단해야 하는지"는 코드가 감지, "어떻게 판단할지"는 Claude Code(Opus)가 결정.
 *
 * 감지 유형:
 * 1. 수익 잠금 딜레마: +N% 도달, 매도? 홀드? (실적/섹터/모멘텀 컨텍스트 필요)
 * 2. 동시 하락 패턴: 3+ 보유종목 동시 하락 → 시장 이슈? 개별?
 * 3. 볼륨 이상: 보유종목 거래량 3x+ 급증 → 뉴스? 세력?
 * 4. 보유일 임박: maxHoldingDays 80%+ 도달 + 손익 애매 → 정리? 연장?
 * 5. 승률 반전: 최근 높은 승률 종목이 갑자기 연패 → 전략 재점검?
 */
import { getPool, getOpenChains } from '../db/client.js';
import { getCtxIsPaper } from '../config/context.js';
import { getConsensusTrend } from '../market/consensus.js';
import { logger } from '../utils/logger.js';

interface PendingDecision {
  situation: string;
  category: string;
  stock_code: string | null;
  context: Record<string, unknown>;
  urgency: number;
  is_paper: boolean;
}

/**
 * 상황 감지 메인 함수
 */
export async function detectSituations(isPaper: boolean): Promise<number> {
  const mode = isPaper ? 'paper' : 'live';
  const detected: PendingDecision[] = [];

  try {
    // ── 데이터 수집 ──────────────────────────────────────────
    const chains = await getOpenChains(isPaper).catch(() => []);
    if (chains.length === 0) return 0;

    // 현재가 조회 (DB 캐시된 스냅샷에서)
    const latestSnapshot = await getPool().query(`
      SELECT data FROM portfolio_snapshots
      WHERE is_paper = $1 ORDER BY created_at DESC LIMIT 1
    `, [isPaper]).catch(() => ({ rows: [] }));

    const snapshotData = latestSnapshot.rows[0]?.data as Record<string, unknown> | undefined;
    const priceMap = new Map<string, number>();
    if (snapshotData && Array.isArray(snapshotData.positions)) {
      for (const p of snapshotData.positions as Array<Record<string, unknown>>) {
        if (p.stock_code && p.current_price) {
          priceMap.set(p.stock_code as string, Number(p.current_price));
        }
      }
    }

    // 이미 PENDING인 종목은 중복 감지 스킵
    const existingPending = await getPool().query(
      `SELECT stock_code FROM pending_decisions WHERE status = 'PENDING' AND is_paper = $1`,
      [isPaper],
    ).catch(() => ({ rows: [] }));
    const pendingCodes = new Set(existingPending.rows.map((r: Record<string, unknown>) => r.stock_code));

    // ── Situation 1: 수익 잠금 딜레마 ──────────────────────
    for (const chain of chains) {
      if (!chain.avg_buy_price || pendingCodes.has(chain.stock_code)) continue;
      const currentPrice = priceMap.get(chain.stock_code);
      if (!currentPrice) continue;

      const pnlPct = ((currentPrice - chain.avg_buy_price) / chain.avg_buy_price) * 100;
      const c = chain as Record<string, unknown>;

      // +7% 이상 수익 → "익절? 더 갈까?" 판단 필요
      if (pnlPct >= 7) {
        const consensus = getConsensusTrend(chain.stock_code);
        detected.push({
          situation: `${c.stock_name || chain.stock_code} +${pnlPct.toFixed(1)}% 수익 도달 — 익절? 홀드?`,
          category: 'profit_lock',
          stock_code: chain.stock_code,
          context: {
            stockCode: chain.stock_code,
            stockName: c.stock_name,
            pnlPct: Math.round(pnlPct * 10) / 10,
            avgBuyPrice: chain.avg_buy_price,
            currentPrice,
            peakPrice: chain.peak_price_since_open,
            strategy: chain.strategy_mode,
            holdingDays: Math.floor((Date.now() - new Date(chain.opened_at).getTime()) / 86400000),
            consensus: consensus ? { trend: consensus.trend, netScore: consensus.netScore } : null,
            question: '익절(전량/부분)할지, 트레일 강화하고 홀드할지 판단해주세요. 섹터 상황, 모멘텀, 실적 일정 고려.',
          },
          urgency: pnlPct >= 12 ? 1 : 2,
          is_paper: isPaper,
        });
      }

      // -4% ~ -6% 손실 → 손절 임박인데 반등 가능성은?
      if (pnlPct <= -4 && pnlPct >= -7) {
        const consensus = getConsensusTrend(chain.stock_code);
        detected.push({
          situation: `${c.stock_name || chain.stock_code} ${pnlPct.toFixed(1)}% 손실 — 손절? 반등 대기?`,
          category: 'loss_cut',
          stock_code: chain.stock_code,
          context: {
            stockCode: chain.stock_code,
            stockName: c.stock_name,
            pnlPct: Math.round(pnlPct * 10) / 10,
            avgBuyPrice: chain.avg_buy_price,
            currentPrice,
            strategy: chain.strategy_mode,
            holdingDays: Math.floor((Date.now() - new Date(chain.opened_at).getTime()) / 86400000),
            consensus: consensus ? { trend: consensus.trend, netScore: consensus.netScore } : null,
            question: '손절할지, 반등 가능성 보고 대기할지 판단해주세요. 시장 전체 흐름, 섹터, 기술적 지지선 고려.',
          },
          urgency: pnlPct <= -5.5 ? 1 : 2,
          is_paper: isPaper,
        });
      }
    }

    // ── Situation 2: 동시 하락 패턴 ──────────────────────────
    const losingPositions = chains.filter(ch => {
      if (!ch.avg_buy_price) return false;
      const price = priceMap.get(ch.stock_code);
      if (!price) return false;
      return ((price - ch.avg_buy_price) / ch.avg_buy_price) * 100 < -2;
    });

    if (losingPositions.length >= 3 && !pendingCodes.has('MARKET_WIDE_DROP')) {
      const details = losingPositions.map(ch => {
        const price = priceMap.get(ch.stock_code)!;
        const pnl = ((price - ch.avg_buy_price!) / ch.avg_buy_price!) * 100;
        return { code: ch.stock_code, name: (ch as Record<string, unknown>).stock_name, pnlPct: Math.round(pnl * 10) / 10 };
      });
      detected.push({
        situation: `${losingPositions.length}개 보유종목 동시 하락 — 시장 전체 이슈? 개별?`,
        category: 'anomaly',
        stock_code: null,
        context: {
          droppingStocks: details,
          totalPositions: chains.length,
          question: '시장 전체 하락인지, 개별 종목 이슈인지 판단해주세요. 전체 하락이면 방어 모드 전환, 개별이면 종목별 대응.',
        },
        urgency: losingPositions.length >= 5 ? 1 : 2,
        is_paper: isPaper,
      });
    }

    // ── Situation 3: 보유일 임박 (maxHoldingDays 80%+) ──────
    for (const chain of chains) {
      if (pendingCodes.has(chain.stock_code)) continue;
      const holdingDays = Math.floor((Date.now() - new Date(chain.opened_at).getTime()) / 86400000);
      const maxDays = chain.strategy_mode === 'SCALPING' ? 0
        : chain.strategy_mode === 'DEFENSE' ? 3
        : chain.strategy_mode === 'SNIPER' ? 7
        : chain.strategy_mode === 'EOD_BETTING' ? 1
        : 12; // SWING default

      if (maxDays > 0 && holdingDays >= maxDays * 0.8) {
        const price = priceMap.get(chain.stock_code);
        const pnlPct = price && chain.avg_buy_price
          ? ((price - chain.avg_buy_price) / chain.avg_buy_price) * 100
          : 0;

        // 손익이 애매한 경우만 (확실한 수익/손실은 규칙이 처리)
        if (pnlPct > -3 && pnlPct < 5) {
          detected.push({
            situation: `${(chain as Record<string, unknown>).stock_name || chain.stock_code} 보유 ${holdingDays}일/${maxDays}일 — 손익 ${pnlPct.toFixed(1)}% 애매`,
            category: 'rebalance',
            stock_code: chain.stock_code,
            context: {
              stockCode: chain.stock_code,
              holdingDays,
              maxDays,
              pnlPct: Math.round(pnlPct * 10) / 10,
              strategy: chain.strategy_mode,
              question: '보유일 임박인데 손익 애매. 정리(매도)? 연장(전략 변경)?',
            },
            urgency: 3,
            is_paper: isPaper,
          });
        }
      }
    }

    // ── Situation 4: 승률 역전 감지 ─────────────────────────
    const recentReversals = await getPool().query(`
      WITH recent AS (
        SELECT stock_code,
               SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)::float /
               NULLIF(COUNT(*), 0) AS recent_wr,
               COUNT(*) AS recent_cnt
        FROM transaction_chains
        WHERE status = 'CLOSED' AND is_paper = $1
          AND closed_at > NOW() - INTERVAL '7 days'
        GROUP BY stock_code
        HAVING COUNT(*) >= 3
      ),
      historical AS (
        SELECT stock_code,
               SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)::float /
               NULLIF(COUNT(*), 0) AS hist_wr,
               COUNT(*) AS hist_cnt
        FROM transaction_chains
        WHERE status = 'CLOSED' AND is_paper = $1
          AND closed_at > NOW() - INTERVAL '90 days'
          AND closed_at <= NOW() - INTERVAL '7 days'
        GROUP BY stock_code
        HAVING COUNT(*) >= 5
      )
      SELECT r.stock_code, r.recent_wr, r.recent_cnt, h.hist_wr, h.hist_cnt
      FROM recent r JOIN historical h ON r.stock_code = h.stock_code
      WHERE h.hist_wr >= 0.55 AND r.recent_wr <= 0.30
    `, [isPaper]).catch(() => ({ rows: [] }));

    for (const row of recentReversals.rows) {
      const r = row as Record<string, unknown>;
      const code = r.stock_code as string;
      if (pendingCodes.has(code)) continue;

      detected.push({
        situation: `${code} 승률 역전: 과거 ${((r.hist_wr as number) * 100).toFixed(0)}% → 최근 ${((r.recent_wr as number) * 100).toFixed(0)}%`,
        category: 'anomaly',
        stock_code: code,
        context: {
          stockCode: code,
          historicalWinRate: Math.round((r.hist_wr as number) * 100),
          recentWinRate: Math.round((r.recent_wr as number) * 100),
          historicalSample: r.hist_cnt,
          recentSample: r.recent_cnt,
          question: '전략이 더 이상 안 먹히는 건지, 일시적 부진인지 판단해주세요. 블랙리스트? 전략 변경?',
        },
        urgency: 2,
        is_paper: isPaper,
      });
    }

    // ── 큐에 적재 ────────────────────────────────────────────
    if (detected.length > 0) {
      for (const d of detected) {
        await getPool().query(
          `INSERT INTO pending_decisions (situation, category, stock_code, context, urgency, is_paper)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [d.situation, d.category, d.stock_code, JSON.stringify(d.context), d.urgency, d.is_paper],
        ).catch(err => logger.error(`판단 큐 적재 실패: ${err}`, { component: 'SITUATION' }));
      }
      logger.info(`🧠 상황 감지 [${mode}]: ${detected.length}건 발견 → 큐 적재 (${detected.map(d => d.category).join(',')})`, { component: 'SITUATION' });
    }

    // ── 만료된 판단 자동 정리 ────────────────────────────────
    await getPool().query(
      `UPDATE pending_decisions SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < NOW()`
    ).catch(() => {});

    // ── 포지션 정리된 종목의 판단 자동 해결 ──────────────────
    const openCodes = new Set(chains.map(c => c.stock_code));
    await getPool().query(
      `UPDATE pending_decisions SET status = 'AUTO_RESOLVED'
       WHERE status = 'PENDING' AND stock_code IS NOT NULL
         AND is_paper = $1
         AND stock_code NOT IN (SELECT unnest($2::text[]))`,
      [isPaper, [...openCodes]],
    ).catch(() => {});

    return detected.length;
  } catch (err) {
    logger.error(`🧠 상황 감지 [${mode}] 오류: ${err}`, { component: 'SITUATION' });
    return 0;
  }
}

/**
 * Dual-mode 실행
 */
export async function detectSituationsDual(): Promise<void> {
  await Promise.all([
    detectSituations(true),
    detectSituations(false),
  ]);
}
