import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { enableMemoryMode, getActiveStrategy, getActiveWatchlist, getLatestScores, getOpenChains, getRecentLossStocks, getRecentManuallySoldStocks, logSystem } from '../../db/client.js';
import type { TradeDecision } from '../../db/models.js';
import { getAccountBalance } from '../../kis/account.js';
import { getBatchPrices, getDailyChart, isMarketOpen } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import {
  buildDefenseParkExitDecisions,
  getDefenseParkState,
  PARK_STOCK_CODE,
} from './defense-park.js';
import { setActiveEngine } from '../../cache/ai-status.js';
import { technicalFallbackDecisions } from './technical-fallback.js';
import { IDLE_PARK_CODE, IDLE_PARK_CODES, IDLE_PARK_NAME } from './trading-rules.js';

// ── IDLE_PARK_CODE 가격 캐시 — 배치 실패 시 직전 가격 fallback용 ──
let _idleParkPriceCache: { price: number; fetchedAt: number } = { price: 0, fetchedAt: 0 };
const IDLE_PARK_CODE_SET = new Set<string>(IDLE_PARK_CODES);

/**
 * Track B 전체 파이프라인 — 장중 5분 간격 실행
 *
 * 흐름:
 * 1. 장 열림 확인
 * 2. DB에서 스코어 + 열린 체인 로드
 * 3. KIS에서 실시간 시세 + 차트 수집
 * 4. 기술적 지표로 매매 판단 (Track A AI 점수는 우선순위 힌트)
 * 5. 하드룰 익절/손절 강제 + 파킹 관리
 * 6. 실행 가능한 결정만 TradeExecutor로 전달
 */
export async function runTrackBPipeline(): Promise<TradeDecision[]> {
  const startTime = Date.now();
  logger.info('🔄 Track B 파이프라인 시작', { component: 'TRACK_B' });

  try {
    // 1. 장 열림 확인
    if (!isMarketOpen()) {
      logger.info('장이 닫혀있어 Track B 스킵', { component: 'TRACK_B' });
      return [];
    }

    // 2. 데이터 로드 (병렬) — DB 타임아웃 시 인메모리 모드 전환
    const dbLoadWithFallback = async () => {
      try {
        return await Promise.all([
          getActiveWatchlist(),
          getOpenChains(),
          getActiveStrategy(),
          getRecentLossStocks(7),
          getRecentManuallySoldStocks(24),
        ]);
      } catch (dbErr: any) {
        const msg = String(dbErr?.message ?? dbErr);
        if (msg.includes('timeout') || msg.includes('terminated') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
          logger.warn(`⚡ DB 연결 실패 → 인메모리 모드로 전환: ${msg}`, { component: 'TRACK_B' });
          enableMemoryMode();
          return await Promise.all([
            getActiveWatchlist(),
            getOpenChains(),
            getActiveStrategy(),
            getRecentLossStocks(7),
            getRecentManuallySoldStocks(24),
          ]);
        }
        throw dbErr;
      }
    };
    const [watchlist, openChains, strategy, recentLossCodes, manuallySoldCodes] = await dbLoadWithFallback();
    const [balanceRaw, reservedWithdraw] = await Promise.all([
      getAccountBalance(),
      import('../../automation/profit-withdraw.js').then(m => m.getTotalReserved()).catch(() => 0),
    ]);
    const balance = { ...balanceRaw, reservedWithdraw } as any;

    if (watchlist.length === 0) {
      logger.warn('감시 목록이 비어있습니다', { component: 'TRACK_B' });
      return [];
    }

    // ─── 개장 초단타 모드: 09:00~09:10 자동 강제 적용 ─────────────────
    // 개장 직후 5분은 거래량 폭발 + 이목 집중 구간 — SCALPING 전략 강제
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const kstH = nowKst.getUTCHours();
    const kstM = nowKst.getUTCMinutes();
    const isOpeningBell = kstH === 9 && kstM < 10; // 09:00~09:09
    const dbMode = (strategy?.mode ?? 'SWING') as StrategyMode;
    // AI 스코어 없을 때 DEFENSE 모드는 매수 불가(minTechScore=65, buyThreshold=75)
    // → scores 로드 전이므로 여기서는 일단 dbMode 유지, technicalFallbackDecisions 호출 시 override
    const mode: StrategyMode = (isOpeningBell && dbMode !== 'DEFENSE') ? 'SCALPING' : dbMode;
    if (isOpeningBell && mode === 'SCALPING') {
      logger.info('🔔 개장 초단타 모드 자동 활성화 (09:00~09:10) — SCALPING +1.2% 즉시 익절', { component: 'TRACK_B' });
    }

    // ─── 방어 파킹 시스템 (SWING 모드 비활성) ─────────────────────────
    // SWING 모드: 방어 파킹 없이 기술적 지표로 직접 매매
    // 잔여 KODEX 200 포지션만 즉시 청산
    const parkState = await getDefenseParkState();

    if (parkState.isActive) {
      // 이미 방어 파킹 중이면 즉시 해제 (정상 매매 복귀)
      logger.info(`🔓 방어 파킹 강제 해제 → 기술적 매매 복귀`, { component: 'TRACK_B' });
      return buildDefenseParkExitDecisions(openChains, '기술적 매매 우선 — 방어 파킹 해제');
    }

    // 잔여 KODEX 200 즉시 청산
    const orphanedKodex = openChains.find((c) => c.stock_code === PARK_STOCK_CODE);
    if (orphanedKodex) {
      logger.warn(`🧹 잔여 KODEX 200 즉시 청산`, { component: 'TRACK_B' });
      return buildDefenseParkExitDecisions([orphanedKodex], 'KODEX 200 잔여 포지션 청산');
    }
    // ───────────────────────────────────────────────────────────────────

    // 3. 캐싱된 스코어 로드 (Redis 우선 → DB fallback)
    const stockCodes: string[] = watchlist.map((w) => w.stock_code);
    const { getCachedScores } = await import('../../cache/redis.js');
    let scores = await getCachedScores(stockCodes);
    if (scores.length === 0) {
      scores = await getLatestScores(stockCodes);
    }

    if (scores.length === 0) {
      logger.warn('오늘의 AI 스코어가 없습니다 (Track A 미실행?) → 기술적 지표 fallback 진행', { component: 'TRACK_B' });
    }

    // 4. 실시간 시세 수집
    // IDLE_PARK_CODE(333940) 배치에 포함 — 별도 getCurrentPrice 제거로 rate limit 최적화
    const chainStockCodes = openChains.map((c) => c.stock_code);
    const allStockCodes = [...new Set([...stockCodes, ...chainStockCodes, PARK_STOCK_CODE, ...IDLE_PARK_CODES])];
    const livePrices = await getBatchPrices(allStockCodes);

    // 333940 캐시 매 파이프라인마다 최신화
    const batchParkPrice = livePrices.get(IDLE_PARK_CODE)?.currentPrice ?? 0;
    if (batchParkPrice > 0) {
      _idleParkPriceCache = { price: batchParkPrice, fetchedAt: Date.now() };
    } else if (_idleParkPriceCache.price > 0 && Date.now() - _idleParkPriceCache.fetchedAt < 30 * 60 * 1000) {
      // 캐시 유효 — 그냥 사용
    } else {
      // 배치 실패 + 캐시 없거나 만료 → 직접 조회
      try {
        const { getCurrentPrice } = await import('../../kis/market.js');
        const parkDirect = await getCurrentPrice(IDLE_PARK_CODE);
        if (parkDirect?.currentPrice > 0) {
          _idleParkPriceCache = { price: parkDirect.currentPrice, fetchedAt: Date.now() };
          logger.info(`💰 333940 직접 조회: ${parkDirect.currentPrice.toLocaleString()}원`, { component: 'TRACK_B' });
        }
      } catch {
        logger.warn(`💰 333940 직접 조회도 실패 — 파킹 스킵`, { component: 'TRACK_B' });
        _idleParkPriceCache = { price: 0, fetchedAt: 0 };
      }
    }

    // ── 파킹 ETF 평가금액 사전 계산 (effectiveCash 포함 — 데드락 방지) ──
    // 문제: 현금 0 + 전부 파킹 ETF → 매수 결정 없음 → hasBuyDecision=false
    //       → 파킹 해제 안 됨 → 현금 계속 0 → 자동매매 불가 (무한 데드락)
    // 해결: 파킹 ETF 평가금액을 실효 현금에 포함 → 매수 결정 생성 → 파킹 해제 트리거
    const _idleParkChains = openChains.filter((c) => IDLE_PARK_CODE_SET.has(c.stock_code) && Number(c.total_quantity) > 0);
    const _idleParkValue = _idleParkChains.reduce((sum, chain) => {
      const qty = Number(chain.total_quantity) || 0;
      if (qty <= 0) return sum;
      const currentPrice = chain.stock_code === IDLE_PARK_CODE
        ? (_idleParkPriceCache.price > 0
            ? _idleParkPriceCache.price
            : (livePrices.get(chain.stock_code)?.currentPrice ?? 0))
        : (livePrices.get(chain.stock_code)?.currentPrice ?? 0);
      const fallbackPrice = Number(chain.avg_buy_price ?? 0);
      const usedPrice = currentPrice > 0 ? currentPrice : fallbackPrice;
      return sum + usedPrice * qty;
    }, 0);
    const _rawOrderableCash = Math.max(0, balance.orderableCash - ((balance as any).reservedWithdraw ?? 0));
    // 실효 가용 현금 = 주문가능현금 + 파킹 ETF 평가금액 (파킹 해제 시 즉시 사용 가능)
    const effectiveCashWithPark = _rawOrderableCash + _idleParkValue;
    if (_idleParkValue > 0) {
      logger.info(`💰 파킹 ETF 평가금액 포함: ${_idleParkValue.toLocaleString()}원 (파킹 ${_idleParkChains.length}종목) → 실효현금 ${effectiveCashWithPark.toLocaleString()}원`, { component: 'TRACK_B' });
    }

    // 가격 캐싱 — 대시보드에서 API 실패 시 fallback용
    try {
      const { cachePrice } = await import('../../cache/redis.js');
      const { cachePriceMemory } = await import('../../cache/memory.js');
      for (const [code, p] of livePrices) {
        if (p.currentPrice > 0) {
          cachePriceMemory(code, p.currentPrice);
          cachePrice(code, p.currentPrice).catch(() => {});
        }
      }
    } catch { /* cache optional */ }

    // 5. 전 종목 차트 데이터 수집 (기술적 지표용)
    // kisRateLimiter가 내부에서 12/sec 큐 관리 → 5개씩 병렬 발사
    const chartData = new Map<string, import('../../kis/market.js').DailyCandle[]>();
    const allCodesForChart = [...new Set([...stockCodes, ...openChains.map((c) => c.stock_code)])];
    const CHART_BATCH = 5;
    for (let i = 0; i < allCodesForChart.length; i += CHART_BATCH) {
      const batch = allCodesForChart.slice(i, i + CHART_BATCH);
      const results = await Promise.allSettled(batch.map((code) => getDailyChart(code, 65)));
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled') {
          if (r.value.length >= 30) {
            chartData.set(batch[j], r.value);
          } else {
            logger.warn(`차트 데이터 부족: ${batch[j]} (${r.value.length}/30)`, { component: 'TRACK_B' });
          }
        } else {
          logger.warn(`차트 조회 실패: ${batch[j]} - ${r.reason}`, { component: 'TRACK_B' });
        }
      }
    }

    // 6. 매매 판단: 기술적 지표 (Track A AI 점수를 우선순위 힌트로 활용)
    const hasScores = scores.length > 0;

    // 보유 종목 없고 + 매수 후보(스코어 ≥threshold + 신뢰도 ≥0.45)도 없으면 AI 호출 스킵
    // confidence 기본값 0 (null = 실패한 점수, 1로 폴백하면 깨진 점수가 100% 확신 취급됨)
    let hasBuyCandidates = scores.some(
      (s) => (s.composite_score ?? 0) >= STRATEGY_PARAMS[mode].buyThreshold && (s.confidence ?? 0) >= 0.35,
    );
    const hasOpenPositions = openChains.some((c) => !IDLE_PARK_CODE_SET.has(c.stock_code) && Number(c.total_quantity) > 0);
    if (!hasBuyCandidates) {
      logger.info(`⏭️ 매수 후보 없음 → KIS 관심종목 재동기화 + 종목 확장 (보유종목 ${hasOpenPositions ? '있음' : '없음'})`, { component: 'TRACK_B' });
      // 매수 후보 0개 → KIS 관심종목 즉시 재동기화 후 현재 사이클에 즉시 편입
      try {
        const { syncInterestGroups } = await import('../../kis/interest-group.js');
        const { added } = await syncInterestGroups();
        if (added.length > 0) {
          logger.info(`📌 신규 ${added.length}종목 감시 편입 → 현재 사이클 즉시 분석 (${added.join(', ')})`, { component: 'TRACK_B' });
          // 새 종목 가격 조회 후 livePrices에 추가
          try {
            const newPrices = await getBatchPrices(added);
            for (const [code, price] of newPrices) {
              livePrices.set(code, price);
              stockCodes.push(code);
            }
          } catch { /* 가격 조회 실패해도 계속 */ }
          // 새 종목 차트 조회 후 chartData에 추가
          for (const code of added) {
            try {
              const candles = await getDailyChart(code, 65);
              if (candles.length >= 30) chartData.set(code, candles);
            } catch { /* 차트 실패해도 계속 */ }
          }
          // 새 종목 스코어 조회 후 scores/hasBuyCandidates 재계산
          try {
            const newScores = await getLatestScores(added);
            if (newScores.length > 0) {
              scores.push(...newScores);
              hasBuyCandidates = scores.some(
                (s) => (s.composite_score ?? 0) >= STRATEGY_PARAMS[mode].buyThreshold && (s.confidence ?? 0) >= 0.35,
              );
              logger.info(`📊 신규 종목 스코어 ${newScores.length}개 반영 → 매수후보: ${hasBuyCandidates}`, { component: 'TRACK_B' });
            }
          } catch { /* 스코어 조회 실패해도 계속 */ }
        }
      } catch { /* 동기화 실패해도 파이프라인 계속 */ }
    }

    let decisions: TradeDecision[] = [];

    // ── 기술적 지표 매매 (항상 실행) + Track A AI 점수를 힌트로만 활용 ──
    // AI 실시간 실행(Claude/Gemini)은 제거 — 안정성 우선, 손실 없는 자동매매
    // Track A가 매일 AI로 점수를 생성 → Track B는 그 점수를 힌트로 종목 우선순위에 반영
    {
      // Paper 모드: 실제 가용현금만 사용 (totalDeposit = 가용현금)
      // Live 모드: effectiveCashWithPark 그대로 (reservedWithdraw는 _rawOrderableCash 계산 시 이미 차감됨)
      const orderableCash = Math.max(0, effectiveCashWithPark);
      const totalAssets = balance.totalEvalAmount + orderableCash;

      // AI 스코어 없을 때 DEFENSE 모드는 minTechScore=65/buyThreshold=75로 진입 불가
      // → AI 미실행 시 SWING으로 완화 (기술점수만으로 매매 가능하도록)
      const effectiveMode: StrategyMode = (scores.length === 0 && mode === 'DEFENSE') ? 'SWING' : mode;
      if (scores.length === 0 && mode === 'DEFENSE') {
        logger.info('⚡ AI 스코어 없음 + DEFENSE 모드 → SWING으로 완화 (기술적 매매 활성화)', { component: 'TRACK_B' });
      }

      // 종목별 과거 승률 로드 — AI 없어도 진입 임계값 동적 조정 (실패해도 계속)
      const { getStockWinRates } = await import('../../analysis/win-rate.js');
      const winRates = await getStockWinRates(stockCodes).catch(() => new Map());
      if (winRates.size > 0) {
        logger.info(`📈 승률 데이터 로드: ${winRates.size}종목`, { component: 'TRACK_B' });
      }

      // 황금비율 배분 설정 조회 (실패해도 계속)
      const allocCfg = await import('../../db/client.js')
        .then(m => m.getPool().query('SELECT * FROM portfolio_allocation_config WHERE is_active = true LIMIT 1'))
        .then(r => r.rows[0] ?? null).catch(() => null);

      // 현재 주식 포지션 가치 (파킹 ETF 제외)
      const currentStockValue = openChains
        .filter(c => !IDLE_PARK_CODE_SET.has(c.stock_code) && c.stock_code !== PARK_STOCK_CODE)
        .reduce((sum, c) => {
          const price = livePrices.get(c.stock_code)?.currentPrice ?? Number(c.avg_buy_price ?? 0);
          return sum + price * Number(c.total_quantity ?? 0);
        }, 0);

      decisions = await technicalFallbackDecisions({
        mode: effectiveMode,
        // PARK_STOCK_CODE(069500) + IDLE_PARK_CODES(333940 등) 제외 — 파킹 ETF가 일반 종목으로 매매되면 orphan 청산 루프 발생
        watchlist: watchlist
          .filter((w) => w.stock_code !== PARK_STOCK_CODE && !IDLE_PARK_CODE_SET.has(w.stock_code))
          .map((w) => ({ stock_code: w.stock_code, stock_name: w.stock_name })),
        livePrices,
        chartData,
        openChains,
        orderableCash,
        maxPositionKrw: config.risk.maxPositionKrw,
        totalAssets,
        lossBlockedCodes: recentLossCodes,
        manuallySoldCodes,
        aiScores: scores
          .filter((s: any) => (s.confidence ?? 0) >= 0.3)
          .map((s: any) => ({ stock_code: s.stock_code, score: s.composite_score ?? 0 })),
        takeProfitPct: strategy?.take_profit_pct ?? undefined,
        stopLossPct: strategy?.stop_loss_pct ?? undefined,
        buyThreshold: strategy?.buy_threshold ?? undefined,
        winRates,
        // 15:10 이후 신규 매수 차단 — 마감 20분 전 진입만 차단
        // DIVIDEND 모드: 신규 매수 완전 차단 (현금 파킹 ETF로만 운용)
        blockNewBuys: kstH > 15 || (kstH === 15 && kstM >= 10) || mode === 'DIVIDEND',
        allocationTarget: allocCfg ? {
          stock_pct: Number(allocCfg.stock_pct),
          rebalance_threshold_pct: Number(allocCfg.rebalance_threshold_pct),
          is_active: Boolean(allocCfg.is_active),
        } : null,
        currentStockValue,
      });

      // DIVIDEND 모드: 하드 필터 — 일반 주식 신규 매수 전량 차단
      // (blockNewBuys 플래그 외 이중 안전망 — 현금은 파킹 ETF로만 운용)
      if (mode === 'DIVIDEND') {
        const before = decisions.length;
        decisions = decisions.filter((d) => {
          if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !IDLE_PARK_CODE_SET.has(d.stock_code)) {
            logger.info(`🏦 DIVIDEND 모드 — 신규 매수 차단: ${d.stock_code}`, { component: 'TRACK_B' });
            return false;
          }
          return true;
        });
        if (before !== decisions.length) {
          logger.info(`🏦 DIVIDEND 모드: ${before - decisions.length}건 매수 차단 → 현금 파킹 ETF 전환`, { component: 'TRACK_B' });
        }
      }

      const engine = hasScores ? 'technical+AI힌트' : 'technical';
      logger.info(
        `📊 기술적 지표 매매 실행 [${engine}] (AI점수=${scores.length}개, 결정=${decisions.length}개)`,
        { component: 'TRACK_B' },
      );
      setActiveEngine('technical');
    }

    // ─────────────────────────────────────────────────────────────────
    // 6-3-C. 🛡️ 조기 매도 방지 필터 (기술적 지표 신호 오발 차단)
    //   - 기술 지표 STRONG_SELL 신호가 손절선(-1.0%) 미도달 포지션을 닫으려는 것 차단
    //   - 실제 익절/손절은 6-4 하드룰 전담 (기준: take_profit_pct / stop_loss_pct)
    //   - 파킹 ETF(IDLE_PARK_CODE) 결정은 예외 (가격 무관 청산)
    // ─────────────────────────────────────────────────────────────────
    {
      const _baseP = STRATEGY_PARAMS[mode];
      const _stopPct = strategy?.stop_loss_pct ?? _baseP.stopLossPct;
      const _tpPct = strategy?.take_profit_pct ?? _baseP.takeProfitPct;

      decisions = decisions.filter((d) => {
        if (!['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action)) return true;
        if (IDLE_PARK_CODE_SET.has(d.stock_code) || d.stock_code === PARK_STOCK_CODE) return true;

        const chain = openChains.find((c) => c.stock_code === d.stock_code);
        if (!chain?.avg_buy_price) return true;

        const liveP = livePrices.get(d.stock_code);
        if (!liveP || liveP.currentPrice <= 0) return true;

        const avgBuy = Number(chain.avg_buy_price);
        if (avgBuy <= 0) return true;

        const pnlPct = ((liveP.currentPrice - avgBuy) / avgBuy) * 100;

        if (d.action === 'FORCE_CLOSE' && pnlPct > _stopPct) {
          logger.warn(
            `🛡️ AI 조기 청산 차단: ${d.stock_code} 현재 ${pnlPct.toFixed(1)}% (손절선 ${_stopPct}% 미도달) → 하드룰 대기`,
            { component: 'TRACK_B' },
          );
          return false;
        }

        if ((d.action === 'SELL' || d.action === 'PARTIAL_SELL') && pnlPct > _stopPct && pnlPct < _tpPct) {
          logger.warn(
            `🛡️ AI 중간 매도 차단: ${d.stock_code} 현재 ${pnlPct.toFixed(1)}% — 트레일링/하드룰 처리 대기`,
            { component: 'TRACK_B' },
          );
          return false;
        }

        return true;
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 6-3-B. 💰 유휴 현금 파킹
    //   - 현금 비중 15% 초과 + BUY 신호 없음 → 머니마켓 ETF 자동 매수
    //   - 머니마켓 ETF: 사실상 원금 손실 0%, 익일물 콜금리 수준 (~3.4% 연간)
    //   - 채권 아님 — 단기금융(MMF) 유형, 수수료보다 높은 수익 보장
    //   - KODEX 200은 하락장 방어용으로만 사용 (defense-park.ts)
    // ─────────────────────────────────────────────────────────────────
    if (mode !== 'SCALPING') {
      const alreadyIdleParked = openChains.some((c) => IDLE_PARK_CODE_SET.has(c.stock_code) && Number(c.total_quantity) > 0);
      const orderableCash = Math.max(0, balance.orderableCash - ((balance as any).reservedWithdraw ?? 0));
      const totalAssets = balance.totalEvalAmount + orderableCash;

      // 파킹 진입: 매수 결정 후 남은 현금이 5% 초과 → 머니마켓 ETF 자동 주차
      const plannedBuyCash = decisions
        .filter((d) => (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !IDLE_PARK_CODE_SET.has(d.stock_code))
        .reduce((sum, d) => sum + (d.limit_price ?? 0) * (d.quantity ?? 0), 0);
      const cashAfterBuys = Math.max(0, orderableCash - plannedBuyCash);
      // totalDeposit이 가장 정확한 총자산 (D+2 미결제 포함)
      const totalPortfolio = Math.max(totalAssets, balance.totalDeposit ?? totalAssets);
      const idlePctAfterBuys = totalPortfolio > 0 ? (cashAfterBuys / totalPortfolio) * 100 : 0;

      // 현재 파킹된 ETF 평가금액 — 조기 계산된 _idleParkValue 재사용
      const idleParkPct = totalPortfolio > 0 ? (_idleParkValue / totalPortfolio) * 100 : 0;
      // 파킹 잔액이 전체의 40% 이하일 때만 추가 파킹 (무한 파킹 방지)
      const canParkMore = idleParkPct < 40;

      // 현금 파킹 조건:
      //   - DIVIDEND 모드: 잔여 현금 100% 파킹 (신규 매수 없으니 여유분 불필요)
      //   - 일반 모드: 현금 10% 초과 시 90% 파킹 (10%는 긴급 매수 여유분)
      const parkCurrentPrice = _idleParkPriceCache.price;
      const isDividendMode = mode === 'DIVIDEND';
      if ((isDividendMode || idlePctAfterBuys > 10) && canParkMore) {
        if (parkCurrentPrice > 0) {
          // DIVIDEND 모드: 100% 파킹, 일반 모드: 90% 파킹
          const parkAmount = cashAfterBuys * (isDividendMode ? 1.0 : 0.90);
          const qty = Math.floor(parkAmount / parkCurrentPrice);
          if (qty > 0) {
            logger.info(
              `💰 유휴 현금 머니마켓 파킹: 현금 ${idlePctAfterBuys.toFixed(1)}%(${Math.round(cashAfterBuys).toLocaleString()}원) → ${IDLE_PARK_NAME} ${qty}주 @${parkCurrentPrice.toLocaleString()}원 (${Math.round(parkAmount).toLocaleString()}원)`,
              { component: 'TRACK_B' },
            );
            decisions.push({
              action: 'BUY',
              stock_code: IDLE_PARK_CODE,
              quantity: qty,
              price_type: 'MARKET',
              limit_price: parkCurrentPrice,
              reasoning: `유휴 현금 파킹: 현금 ${idlePctAfterBuys.toFixed(1)}%(매수후 잔여) → ${IDLE_PARK_NAME} (단기금융형, 익일물 콜금리 수준 수익)`,
              confidence: 0.95,
            });
          }
        } else {
          logger.warn(`💰 유휴 현금 파킹 실패: ${IDLE_PARK_CODE} 가격 조회 불가 (rate limit?)`, { component: 'TRACK_B' });
        }
      }

      // 파킹 해제: 현금 부족 + 파킹 보유 중 → 파킹만 매도, 이번 사이클 BUY는 제거
      // (파킹 ETF 매도 현금은 T+2 정산 — 동일 사이클 매수 실행 시 주문 실패)
      const hasBuyDecision = decisions.some(
        (d) => (d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !IDLE_PARK_CODE_SET.has(d.stock_code),
      );
      const cashInsufficient = _rawOrderableCash < config.risk.maxPositionKrw * 0.5;
      if ((hasBuyDecision || (hasBuyCandidates && cashInsufficient)) && alreadyIdleParked) {
        const parkChains = openChains.filter((c) => IDLE_PARK_CODE_SET.has(c.stock_code) && Number(c.total_quantity) > 0);
        for (const parkChain of parkChains) {
          const fallbackPrice = Number(parkChain.avg_buy_price ?? 0);
          const livePrice = livePrices.get(parkChain.stock_code)?.currentPrice ?? 0;
          const priceForLog = livePrice > 0 ? livePrice : (_idleParkPriceCache.price > 0 ? _idleParkPriceCache.price : fallbackPrice);
          const parkPnlPct = priceForLog > 0 && fallbackPrice > 0 ? ((priceForLog - fallbackPrice) / fallbackPrice) * 100 : 0;
          const parkName = parkChain.stock_code === IDLE_PARK_CODE ? IDLE_PARK_NAME : parkChain.stock_code;
          logger.info(
            `🔄 파킹 해제: 현금 부족 → ${parkName} ${parkChain.total_quantity}주 매도 | 이번 사이클 BUY 보류 (다음 사이클 재매수)`,
            { component: 'TRACK_B' },
          );
          decisions.unshift({
            action: 'FORCE_CLOSE',
            stock_code: parkChain.stock_code,
            quantity: parkChain.total_quantity,
            price_type: 'MARKET',
            reasoning: `파킹 해제: ${parkName} 청산 (수익 ${parkPnlPct.toFixed(2)}%) → 다음 사이클 재매수`,
            confidence: 0.95,
          });
        }
        // 파킹 해제 사이클에서는 BUY 보류 — 현금 정산 후 다음 사이클에서 실행
        const filteredDecisions = decisions.filter(
          (d) => !(d.action === 'BUY' && !IDLE_PARK_CODE_SET.has(d.stock_code)),
        );
        decisions.length = 0;
        decisions.push(...filteredDecisions);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 6-4. 🔒 하드 룰: AI 결정과 무관하게 익절/손절 강제 실행
    //   - Claude가 HOLD 해도 목표 수익률/손절 초과 시 무조건 실행
    //   - chain.target_profit_pct / chain.stop_loss_pct (매수 당시 저장된 값) 기준
    //   - DB 전략 세팅값(strategy.take_profit_pct 등)으로 override
    // ─────────────────────────────────────────────────────────────────
    {
      const baseParams = (await import('../../config/constants.js')).STRATEGY_PARAMS[mode];
      const dbTakeProfit = strategy?.take_profit_pct ?? null;
      const dbStopLoss = strategy?.stop_loss_pct ?? null;

      for (const chain of openChains) {
        // 파킹 ETF는 손절/익절 하드룰 완전 제외 — 장기 보유 목적
        if (IDLE_PARK_CODE_SET.has(chain.stock_code)) continue;

        const price = livePrices.get(chain.stock_code);
        if (!price || !chain.avg_buy_price) continue;
        const avgBuy = Number(chain.avg_buy_price);
        if (avgBuy <= 0 || price.currentPrice <= 0) continue;
        const pnlPct = ((price.currentPrice - avgBuy) / avgBuy) * 100;

        // 이미 매도 결정이 있으면 스킵 (중복 방지)
        const alreadySelling = decisions.some(
          (d) => d.stock_code === chain.stock_code && ['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action),
        );
        if (alreadySelling) continue;

        // 체인 저장값 우선 (매수 당시 점수 기반 설정) → DB 세팅 → 상수 fallback
        // null/undefined 체크: Number(0)||x 는 0도 falsy로 처리하므로 != null 사용
        const targetPct = chain.target_profit_pct != null ? Number(chain.target_profit_pct) : (dbTakeProfit ?? baseParams.takeProfitPct);
        const stopPct = chain.stop_loss_pct != null ? Number(chain.stop_loss_pct) : (dbStopLoss ?? baseParams.stopLossPct);

        // PROFIT_TAKING 상태: 2단계 trailing stop — peak_price 기준
        // 수치는 technical-fallback과 동일하게 유지 (4.0% 목표, -0.8% 트레일)
        if (chain.status === 'PROFIT_TAKING') {
          // peak_price 없고 손실 구간: 브레이크이븐스톱(-1%)만 적용, 트레일 오발동 방지
          if (!(chain as any).peak_price && pnlPct < 0) {
            if (pnlPct <= -1.0) {
              logger.info(`🔒 브레이크이븐스톱(peak없음): ${chain.stock_code} ${pnlPct.toFixed(1)}%`, { component: 'TRACK_B' });
              decisions.push({ action: 'FORCE_CLOSE', stock_code: chain.stock_code, quantity: chain.total_quantity, price_type: 'MARKET', reasoning: `브레이크이븐스톱(peak없음): ${pnlPct.toFixed(1)}%`, confidence: 1.0 });
            }
            continue;
          }
          const peakPrice = (chain as any).peak_price ? Number((chain as any).peak_price) : avgBuy * (1 + targetPct / 100);
          const trailDropPct = ((price.currentPrice - peakPrice) / peakPrice) * 100;
          const stage2Target = targetPct * 2; // 1단계 익절 기준의 2배 (예: 2% → 4%)
          if (pnlPct >= stage2Target) {
            logger.info(`🔒 하드 2단계 익절: ${chain.stock_code} +${pnlPct.toFixed(1)}% → +${stage2Target}% 목표달성`, { component: 'TRACK_B' });
            decisions.push({ action: 'SELL', stock_code: chain.stock_code, quantity: chain.total_quantity, price_type: 'MARKET', reasoning: `하드 2단계 익절: +${pnlPct.toFixed(1)}% ≥ +${stage2Target}% 달성`, confidence: 1.0 });
          } else if (trailDropPct <= -0.8) {
            logger.info(`🔒 하드 트레일링스톱: ${chain.stock_code} peak 대비 ${trailDropPct.toFixed(2)}% 하락`, { component: 'TRACK_B' });
            decisions.push({ action: 'FORCE_CLOSE', stock_code: chain.stock_code, quantity: chain.total_quantity, price_type: 'MARKET', reasoning: `하드 트레일링스톱: peak ${peakPrice.toFixed(0)}원 대비 ${trailDropPct.toFixed(2)}% 하락`, confidence: 1.0 });
          }
          continue; // PROFIT_TAKING은 일반 익절/손절 하드룰 적용 안 함
        }

        if (pnlPct >= targetPct) {
          // 1단계 익절: 50% 부분 매도 → PROFIT_TAKING으로 전환
          const sellQty = chain.total_quantity > 1
            ? Math.ceil(chain.total_quantity * 0.5)
            : chain.total_quantity;
          const safeQty = Math.min(sellQty, chain.total_quantity);
          if (safeQty > 0) {
            logger.info(`🔒 하드 1단계 익절(50%): ${chain.stock_code} +${pnlPct.toFixed(1)}% → 잔여 trailing 대기`, { component: 'TRACK_B' });
            decisions.push({
              action: safeQty >= chain.total_quantity ? 'SELL' : 'PARTIAL_SELL',
              stock_code: chain.stock_code,
              quantity: safeQty,
              price_type: 'MARKET',
              reasoning: `하드 1단계 익절(50%): +${pnlPct.toFixed(1)}% (목표 ${targetPct}%) — 잔여 trailing`,
              confidence: 1.0,
            });
          }
        } else if (pnlPct <= stopPct) {
          logger.info(`🔒 하드 손절: ${chain.stock_code} ${pnlPct.toFixed(1)}% (한도 ${stopPct}%) — AI HOLD 무시`, { component: 'TRACK_B' });
          decisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `하드 손절: ${pnlPct.toFixed(1)}% (한도 ${stopPct}%) — AI 결정 무관 강제 실행`,
            confidence: 1.0,
          });
        }
      }
    }

    // syncInterestGroups 보완: hasBuyCandidates=true이나 실제 BUY 결정 없을 때도 재동기화
    // (Gemini 전부 HOLD → 기술 폴백 BUY도 없는 경우 커버)
    if (hasBuyCandidates) {
      const hasActualBuyDecision = decisions.some(
        (d) => ['BUY', 'AVERAGE_DOWN'].includes(d.action) && !IDLE_PARK_CODE_SET.has(d.stock_code),
      );
      if (!hasActualBuyDecision) {
        logger.info('⏭️ 매수 후보 있으나 실제 BUY 결정 없음 → KIS 관심종목 재동기화', { component: 'TRACK_B' });
        try {
          const { syncInterestGroups } = await import('../../kis/interest-group.js');
          await syncInterestGroups();
        } catch { /* 동기화 실패해도 파이프라인 계속 */ }
      }
    }

    // 7. HOLD 제외 + BUY 결정에 현재가 주입 (executor 재조회 실패 방지)
    for (const d of decisions) {
      if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && !d.limit_price) {
        const livePrice = livePrices.get(d.stock_code)?.currentPrice ?? 0;
        if (livePrice > 0) d.limit_price = livePrice;
      }
    }

    // 7-B. 수량 보정: 과소 수량을 1차 진입 예산 기준으로 맞춤 (초과는 금지)
    // 종목당 한도: 총자산 15% / splitCount = 1차 진입분
    {
      const orderableCashNow = Math.max(0, effectiveCashWithPark); // reservedWithdraw는 _rawOrderableCash 계산 시 이미 차감됨
      const totalAssetsNow = balance.totalEvalAmount + orderableCashNow;
      const _params = STRATEGY_PARAMS[mode];
      // 종목당 최대 = 총자산 15% or maxPositionKrw 중 작은 값 (technical-fallback과 동일 기준)
      const maxPerPosition = Math.min(config.risk.maxPositionKrw, Math.round(totalAssetsNow * 0.15));
      const budgetPerBuy = Math.floor(maxPerPosition / _params.splitCount);
      for (const d of decisions) {
        if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && (d.limit_price ?? 0) > 0 && !IDLE_PARK_CODE_SET.has(d.stock_code)) {
          const price = d.limit_price!;
          const targetQty = Math.max(1, Math.floor(budgetPerBuy / price));
          const currentQty = d.quantity ?? 0;
          if (currentQty < targetQty) {
            logger.info(
              `📊 수량 보정(상향): ${d.stock_code} ${currentQty}주 → ${targetQty}주 (1차진입예산 ${budgetPerBuy.toLocaleString()}원)`,
              { component: 'TRACK_B' },
            );
            d.quantity = targetQty;
          } else if (currentQty > targetQty * 2) {
            // 2배 초과 시만 하향 보정 (소수점 오류 등 극단값 방지)
            logger.warn(
              `📊 수량 보정(하향): ${d.stock_code} ${currentQty}주 → ${targetQty}주 (초과 감지)`,
              { component: 'TRACK_B' },
            );
            d.quantity = targetQty;
          }
        }
      }
    }
    // CEO 수동 매도 쿨다운: 24시간 내 수동 매도된 종목 BUY/AVERAGE_DOWN 하드 차단
    if (manuallySoldCodes.size > 0) {
      const before = decisions.length;
      decisions = decisions.filter((d) => {
        if ((d.action === 'BUY' || d.action === 'AVERAGE_DOWN') && d.stock_code && manuallySoldCodes.has(d.stock_code)) {
          logger.warn(`🚫 CEO 수동 매도 쿨다운 차단: ${d.stock_code} — 24시간 재진입 금지`, { component: 'TRACK_B' });
          return false;
        }
        return true;
      });
      if (decisions.length < before) {
        logger.info(`🚫 수동 매도 쿨다운: ${before - decisions.length}건 BUY 차단 (${[...manuallySoldCodes].join(', ')})`, { component: 'TRACK_B' });
      }
    }

    // ── 최종 중복 매도 신호 제거 (AI 출력 오류 or 다중 체인 방어) ──
    // 우선순위: FORCE_CLOSE > SELL > PARTIAL_SELL (더 강한 신호 유지)
    {
      const SELL_PRIORITY: Record<string, number> = { FORCE_CLOSE: 3, SELL: 2, PARTIAL_SELL: 1 };
      const sellMap = new Map<string, (typeof decisions)[0]>();
      const nonSellDecisions: typeof decisions = [];
      for (const d of decisions) {
        if (['SELL', 'PARTIAL_SELL', 'FORCE_CLOSE'].includes(d.action) && d.stock_code) {
          const existing = sellMap.get(d.stock_code);
          if (!existing || (SELL_PRIORITY[d.action] ?? 0) > (SELL_PRIORITY[existing.action] ?? 0)) {
            sellMap.set(d.stock_code, d);
          } else {
            logger.warn(
              `🔇 중복 매도 신호 제거: ${d.stock_code} ${d.action} (이미 ${existing.action} 존재)`,
              { component: 'TRACK_B' },
            );
          }
        } else {
          nonSellDecisions.push(d);
        }
      }
      decisions.length = 0;
      decisions.push(...nonSellDecisions, ...sellMap.values());
    }

    // 현재가 없는 BUY 결정 제외 (가격 조회 불가 종목 → 매수 불가)
    const actionable = decisions.filter((d) => {
      if (d.action !== 'HOLD' && (d.action === 'BUY' || d.action === 'AVERAGE_DOWN')) {
        const hasPrice = (d.limit_price ?? 0) > 0;
        if (!hasPrice) logger.warn(`가격 없는 BUY 제외: ${d.stock_code}`, { component: 'TRACK_B' });
        return hasPrice;
      }
      return d.action !== 'HOLD';
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await logSystem(
      'INFO',
      'TRACK_B',
      `파이프라인 완료 (${elapsed}초): ${decisions.length}개 판단, ${actionable.length}개 실행 대기`,
    );

    logger.info(`✅ Track B 완료 (${elapsed}초): 총 ${decisions.length}개 판단, ${actionable.length}개 액션`, {
      component: 'TRACK_B',
    });

    return actionable;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logSystem('ERROR', 'TRACK_B', `파이프라인 실패: ${msg}`);
    logger.error(`❌ Track B 실패: ${msg}`, { component: 'TRACK_B' });
    return []; // 실패 시 안전하게 아무것도 안 함
  }
}
