import { INVERSE_ETF_CODES } from '../automation/crash-profit.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { getActiveStrategy, getOpenChains, getPool } from '../db/client.js';
import type { TradeDecision } from '../db/models.js';
import { getCurrentPrice } from '../kis/market.js';
import { sendByPaperFlag } from '../notifications/mode-message.js';
import { tradeExecutor } from '../trading/executor.js';
import { reconcileExternalSells } from '../trading/fill-reconciler.js';
import { logger } from '../utils/logger.js';
import { calcPnlPct } from '../utils/money.js';
import { sleep } from '../utils/sleep.js';

/**
 * 트레일링 스탑 설정
 *
 * 수익률이 TRAILING_ACTIVATE_PCT(+1.5%) 이상에 도달한 순간부터
 * 고점(peak_price_since_open)을 추적한다.
 * +3% 이상 구간 진입 시 보유 수량의 50% 분할 익절 (1회만)
 * 이후 고점 대비 TRAILING_DROP_PCT(1.5%) 하락 시 나머지 전량 매도.
 *
 * 예시:
 *  매수 10,000원 → +3% → 50% 분할 익절
 *  → 남은 50% 고점 추적, 고점 대비 -1.5% 하락 시 청산
 */
const TRAILING_ACTIVATE_PCT = 1.5; // 트레일링 스탑 활성화 최소 수익률 (%)

/** 수익률 구간별 동적 트레일링 드롭 (고점 대비 하락 허용 %) — 수익 클수록 타이트 */
function getDynamicTrailingDrop(peakPnlPct: number): number {
  if (peakPnlPct >= 20) return 1.0; // +20% 이상: 1.0% 하락 시 즉시 청산 (러너 수익 극대화)
  if (peakPnlPct >= 15) return 1.2; // +15~20%: 1.2% 하락 허용 (고수익 보호)
  if (peakPnlPct >= 9) return 1.5; // +9~15%: 1.5% 하락 시 즉시 청산 (v12: 1.2→1.5, 한국 주도주 숨고르기 1.5~1.8% 대응)
  if (peakPnlPct >= 6) return 1.8; // +6~9%: 1.8% 하락 허용
  if (peakPnlPct >= 4) return 2.2; // +4~6%: 2.2% 하락 허용
  if (peakPnlPct >= 2) return 2.6; // +2~4%: 2.6% 하락 허용
  return 3.0; // +1.5~2%: 기본 3.0% (초기 노이즈 흡수)
}

/**
 * 보유일 초과 자동 손절 체크
 * - 매수 후 N영업일(기본 3일) 경과 시 수익이 안 나면 전량 손절
 * - CEO 매뉴얼: "매수 후 3영업일이 지나도 수익이 안 나면 미련 없이 전량 시장가로 손절"
 *
 * 실행 시점: 장중 매 3분마다 Track B와 함께
 */
export async function runHoldingCheckJob(): Promise<void> {
  const modeTag = getCtxIsPaper() ? '[PAPER]' : '[LIVE]';
  // 외부 매도 감지 (KIS 앱 직접 매도 등) — 유령 체인 정리
  await reconcileExternalSells().catch((e) =>
    logger.warn(`${modeTag} 외부 매도 감지 실패 (무시): ${e}`, { component: 'HOLDING_CHECK' }),
  );

  try {
    const chains = await getOpenChains(getCtxIsPaper());
    if (chains.length === 0) return;

    // ── 탈출 모드 체크 (+0.5% 돌파 시 즉시 매도) ──
    await checkEscapeTargets(chains);

    const strategy = await getActiveStrategy();
    const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
    const _globalParams = STRATEGY_PARAMS[mode];

    const now = new Date();
    const forceCloseDecisions: TradeDecision[] = [];

    for (const chain of chains) {
      if (chain.total_quantity <= 0) continue;

      // 체인별 전략 파라미터 (체인 자체 모드 우선, 없으면 글로벌)
      const chainMode =
        chain.strategy_mode && chain.strategy_mode in STRATEGY_PARAMS
          ? (chain.strategy_mode as keyof typeof STRATEGY_PARAMS)
          : mode;
      const params = STRATEGY_PARAMS[chainMode];
      const isInverseEtf = INVERSE_ETF_CODES.has(chain.stock_code);
      // 인버스 ETF: 일일 리밸런싱 손실 방지 — 전략 설정 무관하게 4영업일 하드 타임아웃
      const maxDays = isInverseEtf ? 4 : params.maxHoldingDays;
      if (maxDays <= 0) continue;

      // 영업일 계산 (주말 제외)
      const openedAt = new Date(chain.opened_at);
      const businessDays = countBusinessDays(openedAt, now);

      // 1영업일 미만은 건드리지 않음
      if (businessDays < 1) continue;

      // 현재가 확인 — 최대 2회 재시도
      let currentPrice: number | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const priceData = await getCurrentPrice(chain.stock_code);
          if (priceData.currentPrice > 0) {
            currentPrice = priceData.currentPrice;
            break;
          }
        } catch {
          if (attempt < 2) await sleep(1000);
        }
      }

      if (currentPrice === null) {
        if (businessDays >= maxDays) {
          // maxDays 초과 + 가격 조회 실패 → 강행
          logger.warn(`${chain.stock_code} 현재가 조회 2회 실패 → 평균가(${chain.avg_buy_price}) 기준 시간손절 강행`, {
            component: 'HOLDING_CHECK',
          });
          forceCloseDecisions.push({
            action: 'FORCE_CLOSE',
            stock_code: chain.stock_code,
            quantity: chain.total_quantity,
            price_type: 'MARKET',
            reasoning: `보유 ${businessDays}영업일 초과 (한도 ${maxDays}일), 현재가 조회 실패 → 시장가 강제 손절`,
            confidence: 1.0,
          });
        }
        continue;
      }

      const pnlPct = calcPnlPct(Number(chain.avg_buy_price), currentPrice);

      // ── 트레일링 스탑: 고점 갱신 + 하락 감지 ──
      const trailingResult = await checkAndUpdateTrailingStop(chain, currentPrice, pnlPct, params);
      if (trailingResult) {
        forceCloseDecisions.push(trailingResult);
        continue;
      }

      // ── 3영업일 하드 리밋: -1.5% 이상 손실 중이면 강제 청산 (단순 횡보는 더 기다림) ──
      if (businessDays >= 3 && pnlPct <= -1.5) {
        logger.warn(
          `${modeTag} ⏰ ${chain.stock_code}: ${businessDays}영업일 보유 + 손실 ${pnlPct.toFixed(2)}% → 3일 하드 리밋 강제 청산`,
          { component: 'HOLDING_CHECK' },
        );
        forceCloseDecisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `3영업일 하드 리밋: ${businessDays}일 보유, 손실 ${pnlPct.toFixed(2)}% → 강제 청산`,
          confidence: 1.0,
        });
        continue;
      }

      // ── 조기 정체 감지 (수익 가능성 없는 포지션 선제 청산) ──
      // 기준: 일수별 슬라이딩 임계값. 아래 조건 충족 시 maxDays 기다리지 않고 청산
      const stagnantReason = checkStagnation(businessDays, pnlPct, maxDays, params.stopLossPct);
      if (stagnantReason) {
        logger.warn(
          `${modeTag} 🥱 정체 청산: ${chain.stock_code} ${businessDays}일 보유, ${pnlPct.toFixed(2)}% — ${stagnantReason}`,
          { component: 'HOLDING_CHECK' },
        );
        forceCloseDecisions.push({
          action: 'FORCE_CLOSE',
          stock_code: chain.stock_code,
          quantity: chain.total_quantity,
          price_type: 'MARKET',
          reasoning: `정체 청산 (${businessDays}영업일, ${pnlPct.toFixed(2)}%): ${stagnantReason}`,
          confidence: 1.0,
        });
        continue;
      }

      // ── 최대 보유일 초과 ──
      if (businessDays < maxDays) continue;

      // 수익 중이거나 손익분기(0% 이상)면 시간 청산 제외 — 수수료 손실 방지, 트레일링 스탑이 처리
      // 인버스 ETF는 일일 리밸런싱 decay 있으므로 제외
      if (pnlPct >= 0.0 && !isInverseEtf) {
        logger.info(
          `⏰ ${chain.stock_code}: ${businessDays}일 보유 초과, 수익 ${pnlPct.toFixed(2)}% → 수익/횡보 중 — 시간 청산 제외 (트레일링 스탑 대기)`,
          { component: 'HOLDING_CHECK' },
        );
        continue;
      }

      logger.warn(
        `${modeTag} ⏰ ${chain.stock_code}: ${businessDays}일 보유 초과 (한도 ${maxDays}일), 손실 ${pnlPct.toFixed(2)}% → 시간 손절`,
        { component: 'HOLDING_CHECK' },
      );
      forceCloseDecisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `보유 ${businessDays}영업일 초과 (한도 ${maxDays}일), 손실 ${pnlPct.toFixed(2)}% → 시간 손절`,
        confidence: 1.0,
      });
    }

    if (forceCloseDecisions.length > 0) {
      await tradeExecutor.processDecisions(forceCloseDecisions, mode, 'HOLDING_CHECK');

      const summary = forceCloseDecisions.map((d) => `${d.stock_code} x${d.quantity} (${d.reasoning})`).join('\n');
      await sendByPaperFlag(getCtxIsPaper(), `⏰ 시간 손절 실행:\n${summary}`);
    }
  } catch (error) {
    logger.error(`보유일 체크 실패: ${error}`, { component: 'HOLDING_CHECK' });
  }
}

/**
 * 정체 감지: 전략 손절선 기반으로 "회복 가능성 없는 포지션"만 조기 청산
 *
 * 스윙(-5% 손절선) 기준 예시:
 *  - 5일차+: -4% 미만 → 손절선 80% 도달, 추가 하락 리스크 차단
 *  - maxDays-2 이후: -2.5% 미만 → 만기 임박인데 손실 중
 *
 * 단기 하락(-1~-3%)은 스윙 회복 여지로 보고 기다림
 *
 * @returns 청산 사유 문자열 (청산 불필요하면 null)
 */
function checkStagnation(businessDays: number, pnlPct: number, maxDays: number, stopLossPct: number): string | null {
  // 손절선의 80% 이상 손실이 5일 이상 지속 → 회복 가능성 낮음
  const earlyStopPct = stopLossPct * 0.8; // e.g. SWING -5% → -4%
  if (businessDays >= 5 && pnlPct < earlyStopPct) {
    return `${businessDays}일 보유 중 ${pnlPct.toFixed(2)}% (회복 가능성 낮음, 기준 ${earlyStopPct.toFixed(1)}%)`;
  }
  // 만기 2일 전: 손절선 50% 이상 손실 → 만기까지 기다려도 회복 어려움
  const lateStopPct = stopLossPct * 0.5; // e.g. SWING -5% → -2.5%
  if (maxDays > 2 && businessDays >= maxDays - 2 && pnlPct < lateStopPct) {
    return `만기 ${maxDays - businessDays}일 전 손실 (${pnlPct.toFixed(2)}% < ${lateStopPct.toFixed(1)}%) — 조기 청산`;
  }
  return null;
}

/**
 * 트레일링 스탑 체크 + 고점 업데이트
 *
 * - 수익률 >= TRAILING_ACTIVATE_PCT 이면 peak_price_since_open 갱신
 * - 고점 대비 TRAILING_DROP_PCT% 하락 시 → FORCE_CLOSE 결정 반환
 * - 아직 익절 구간 미도달 or 하락폭 미달 → null 반환
 */
async function checkAndUpdateTrailingStop(
  chain: any,
  currentPrice: number,
  pnlPct: number,
  params: { takeProfitPct: number },
): Promise<import('../db/models.js').TradeDecision | null> {
  const avgBuy = Number(chain.avg_buy_price);
  if (avgBuy <= 0 || currentPrice <= 0) return null;

  // 분할 익절 상태 확인 (본절 방어에도 필요하므로 early return 전에 선언)
  const storedPeakRaw = Number(chain.peak_price_since_open ?? 0);
  const partialSoldAlready = storedPeakRaw < 0;
  const storedPeak = Math.abs(storedPeakRaw);

  // 🛡️ 본절 방어: 한때 트레일링 활성화됐다가 수익이 0%대로 복귀 → 즉시 청산
  // NYC 데이트레이더 원칙: +1.5% 찍고 0% 복귀는 손실과 동일
  const hadTrailingActivation = storedPeak >= avgBuy * (1 + TRAILING_ACTIVATE_PCT / 100);
  const breakEvenThreshold = partialSoldAlready ? -0.5 : 0.3;
  if (hadTrailingActivation && pnlPct < breakEvenThreshold) {
    const peakPnlPct = ((storedPeak - avgBuy) / avgBuy) * 100;
    logger.info(
      `🛡️ 본절 방어 발동: ${chain.stock_code} 한때 +${peakPnlPct.toFixed(1)}% 도달 → 현재 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (기준 +${breakEvenThreshold}% 미만) → 즉시 청산`,
      { component: 'TRAILING' },
    );
    return {
      action: 'FORCE_CLOSE' as const,
      stock_code: chain.stock_code,
      quantity: chain.total_quantity,
      price_type: 'MARKET' as const,
      reasoning: `🛡️ 본절 방어: 트레일링 활성(고점 +${peakPnlPct.toFixed(1)}%) 후 수익 반납 → 현재 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
      confidence: 1.0,
    };
  }

  // 트레일링 미활성화 구간 (수익 불충분)
  if (pnlPct < TRAILING_ACTIVATE_PCT) return null;
  const chainTp = Number(chain.target_profit_pct) || params.takeProfitPct;
  const chainMode = chain.strategy_mode as keyof typeof STRATEGY_PARAMS | undefined;
  const modeParams = chainMode && chainMode in STRATEGY_PARAMS ? STRATEGY_PARAMS[chainMode] : null;
  const tpRatio = (modeParams as any)?.takeProfitRatio ?? 0.5;
  const isFullSell = tpRatio >= 1.0;

  // ── 조기 부분익절: earlyTpPct 도달 시 50% 즉시 해제 → 현금 회전율 향상 ──
  const earlyTpPct: number = (modeParams as any)?.earlyTpPct ?? 0;
  if (
    earlyTpPct > 0 &&
    !partialSoldAlready &&
    !isFullSell &&
    chain.status !== 'PROFIT_TAKING' &&
    pnlPct >= earlyTpPct &&
    pnlPct < chainTp && // 아직 메인 TP 미도달 (도달 시 아래 메인 TP 로직 처리)
    chain.total_quantity >= 2
  ) {
    const sellQty = Math.floor(chain.total_quantity / 2);
    if (sellQty > 0) {
      logger.info(
        `⚡ 조기 부분익절 발동: ${chain.stock_code} +${pnlPct.toFixed(1)}% (조기TP +${earlyTpPct}%) → ${sellQty}주 50% 매도, 나머지 메인TP(+${chainTp}%) 추적`,
        { component: 'TRAILING' },
      );
      try {
        await getPool().query(
          'UPDATE transaction_chains SET peak_price_since_open = $1 WHERE id = $2 AND is_paper = $3',
          [-currentPrice, chain.id, chain.is_paper ?? getCtxIsPaper()],
        );
      } catch (err) {
        // DB 쓰기 실패 시 매도 결정 반환 금지 — 다음 사이클에서 이중 부분매도 방지
        logger.error(`⛔ 조기익절 플래그 저장 실패 → 매도 차단 (이중 부분매도 방지): ${err}`, {
          component: 'TRAILING',
        });
        return null;
      }
      return {
        action: 'PARTIAL_SELL' as const,
        stock_code: chain.stock_code,
        quantity: sellQty,
        price_type: 'MARKET' as const,
        reasoning: `⚡ 조기익절(50%): +${pnlPct.toFixed(1)}% 도달 (조기TP +${earlyTpPct}%) → ${sellQty}주 즉시 회수, 나머지 +${chainTp}% 목표 트레일링`,
        confidence: 1.0,
      };
    }
  }

  // ── 메인 TP: chainTp 도달 시 50% 매도 (조기익절 없었거나 SCALPING/BOTTOM_FISHING 전량) ──
  if (!partialSoldAlready && chain.status !== 'PROFIT_TAKING' && pnlPct >= chainTp && chain.total_quantity >= 2) {
    const sellQty = isFullSell ? chain.total_quantity : Math.floor(chain.total_quantity / 2);

    if (sellQty > 0) {
      logger.info(
        `💰 ${isFullSell ? '전량' : '분할'} 익절 발동: ${chain.stock_code} +${pnlPct.toFixed(1)}% (기준 +${chainTp}%) → ${sellQty}주 ${isFullSell ? '100%' : '50%'} 매도`,
        { component: 'TRAILING' },
      );
      try {
        await getPool().query(
          'UPDATE transaction_chains SET peak_price_since_open = $1 WHERE id = $2 AND is_paper = $3',
          [-currentPrice, chain.id, chain.is_paper ?? getCtxIsPaper()],
        );
      } catch (err) {
        // DB 쓰기 실패 시 매도 결정 반환 금지 — 다음 사이클에서 이중 부분매도 방지
        logger.error(`⛔ 분할매도 플래그 저장 실패 → 매도 차단 (이중 부분매도 방지): ${err}`, {
          component: 'TRAILING',
        });
        return null;
      }
      return {
        action: isFullSell ? ('FORCE_CLOSE' as const) : ('PARTIAL_SELL' as const),
        stock_code: chain.stock_code,
        quantity: sellQty,
        price_type: 'MARKET' as const,
        reasoning: isFullSell
          ? `전량 익절: 평단가 대비 +${pnlPct.toFixed(1)}% 도달 (TP ${chainTp}%) → ${sellQty}주 전량 매도`
          : `분할 익절(50%): 평단가 대비 +${pnlPct.toFixed(1)}% 도달 (TP ${chainTp}%) → ${sellQty}주 매도, 나머지 트레일링 추적`,
        confidence: 1.0,
      };
    }
  }

  const newPeak = Math.max(storedPeak, currentPrice);

  // 고점 갱신
  if (newPeak > storedPeak) {
    const saveVal = partialSoldAlready ? -newPeak : newPeak;
    try {
      await getPool().query(
        'UPDATE transaction_chains SET peak_price_since_open = $1 WHERE id = $2 AND is_paper = $3',
        [saveVal, chain.id, chain.is_paper ?? getCtxIsPaper()],
      );
    } catch (err) {
      logger.error(`트레일링 고점 갱신 실패: ${err}`, { component: 'TRAILING' });
    }
    logger.info(
      `📈 트레일링 고점 갱신: ${chain.stock_code} ${storedPeak > 0 ? storedPeak.toLocaleString() : '초기'} → ${newPeak.toLocaleString()}원 (+${pnlPct.toFixed(1)}%)`,
      { component: 'TRAILING' },
    );
  }

  if (newPeak <= 0) return null;
  const dropFromPeak = ((newPeak - currentPrice) / newPeak) * 100;
  const peakPnlPct = ((newPeak - avgBuy) / avgBuy) * 100;
  const dynamicDrop = getDynamicTrailingDrop(peakPnlPct);

  if (dropFromPeak >= dynamicDrop) {
    logger.info(
      `🎯 트레일링 스탑 발동: ${chain.stock_code} 고점 ${newPeak.toLocaleString()}원(+${peakPnlPct.toFixed(1)}%) → 현재 ${currentPrice.toLocaleString()}원(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) | 고점 대비 -${dropFromPeak.toFixed(1)}% (기준 -${dynamicDrop}%)`,
      { component: 'TRAILING' },
    );
    return {
      action: 'FORCE_CLOSE',
      stock_code: chain.stock_code,
      quantity: chain.total_quantity,
      price_type: 'MARKET',
      reasoning: `트레일링 스탑: 고점 +${peakPnlPct.toFixed(1)}% → 현재 ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (고점 대비 -${dropFromPeak.toFixed(1)}% > 기준 -${dynamicDrop}%)`,
      confidence: 1.0,
    };
  }

  logger.info(
    `⏳ 트레일링 추적 중: ${chain.stock_code} +${pnlPct.toFixed(1)}% | 고점 ${newPeak.toLocaleString()}원(+${peakPnlPct.toFixed(1)}%) 대비 -${dropFromPeak.toFixed(1)}% (발동까지 ${(dynamicDrop - dropFromPeak).toFixed(1)}% 남음, 기준 -${dynamicDrop}%)`,
    { component: 'TRAILING' },
  );
  return null;
}

/** 한국 공휴일 목록 (KRX 휴장일 기준 2025~2026) */
const KRX_HOLIDAYS = new Set([
  // 2025
  '2025-01-01',
  '2025-01-28',
  '2025-01-29',
  '2025-01-30',
  '2025-03-01',
  '2025-05-05',
  '2025-05-06',
  '2025-06-06',
  '2025-08-15',
  '2025-10-03',
  '2025-10-06',
  '2025-10-07',
  '2025-10-08',
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-03-01',
  '2026-03-02',
  '2026-05-05',
  '2026-05-25',
  '2026-06-06',
  '2026-08-17',
  '2026-09-24',
  '2026-09-25',
  '2026-09-28',
  '2026-10-09',
  '2026-12-25',
]);

/** 두 날짜 사이의 영업일 수 (주말 + 한국 공휴일 제외) — KST 기준 */
function countBusinessDays(start: Date, end: Date): number {
  let count = 0;
  // KST 기준으로 날짜 경계 정렬 (UTC+9 → UTC epoch에서 +9h 후 자정 절삭)
  const KST_OFFSET_MS = 9 * 60 * 60_000;
  const startKstMs = start.getTime() + KST_OFFSET_MS;
  const endKstMs = end.getTime() + KST_OFFSET_MS;
  const MS_PER_DAY = 24 * 60 * 60_000;
  let currentMs = startKstMs - (startKstMs % MS_PER_DAY); // KST 자정 절삭
  const endMs = endKstMs - (endKstMs % MS_PER_DAY);

  while (currentMs < endMs) {
    currentMs += MS_PER_DAY;
    // KST 기준 요일/날짜: currentMs는 이미 KST 시프트된 epoch → getUTCDay()=KST 요일
    const kstDate = new Date(currentMs);
    const day = kstDate.getUTCDay();
    const ymd = kstDate.toISOString().split('T')[0];
    if (day !== 0 && day !== 6 && !KRX_HOLIDAYS.has(ymd)) count++;
  }

  return count;
}

/**
 * 탈출 모드 체크: escape_target_price 가 설정된 체인 중
 * 현재가 >= 목표가 (+0.5%) 이면 즉시 전량 매도
 */
async function checkEscapeTargets(chains: any[]): Promise<void> {
  const escapeChains = chains.filter((ch) => ch.escape_target_price != null && Number(ch.escape_target_price) > 0);
  if (escapeChains.length === 0) return;

  const decisions: TradeDecision[] = [];

  for (const chain of escapeChains) {
    const target = Number(chain.escape_target_price);
    let curPrice: number | null = null;

    try {
      const priceData = await getCurrentPrice(chain.stock_code);
      if (priceData.currentPrice > 0) curPrice = priceData.currentPrice;
    } catch {
      continue;
    }

    if (curPrice === null) continue;

    if (curPrice >= target) {
      const pnlPct = calcPnlPct(Number(chain.avg_buy_price), curPrice);
      logger.info(
        `🚪 탈출 실행: ${chain.stock_code} 현재가 ${curPrice.toLocaleString()}원 ≥ 목표 ${target.toLocaleString()}원 (${pnlPct.toFixed(2)}%)`,
        { component: 'ESCAPE' },
      );
      decisions.push({
        action: 'FORCE_CLOSE',
        stock_code: chain.stock_code,
        quantity: chain.total_quantity,
        price_type: 'MARKET',
        reasoning: `탈출: 현재가 ${curPrice.toLocaleString()}원이 목표가 ${target.toLocaleString()}원 돌파 (+${pnlPct.toFixed(2)}%)`,
        confidence: 1.0,
      });
    } else {
      const gap = (((target - curPrice) / curPrice) * 100).toFixed(2);
      logger.info(
        `🚪 탈출 대기: ${chain.stock_code} 현재 ${curPrice.toLocaleString()}원 / 목표 ${target.toLocaleString()}원 (${gap}% 남음)`,
        { component: 'ESCAPE' },
      );
    }
  }

  if (decisions.length === 0) return;

  const strategy = await getActiveStrategy();
  const mode = (strategy?.mode ?? 'SWING') as StrategyMode;
  await tradeExecutor.processDecisions(decisions, mode, 'HOLDING_CHECK');

  // 매도 실행 성공 후 escape_target_price 초기화 (실행 전에 하면 실패 시 탈출 기회 상실)
  for (const chain of escapeChains) {
    const d = decisions.find((dd) => dd.stock_code === chain.stock_code);
    if (d) {
      await getPool()
        .query('UPDATE transaction_chains SET escape_target_price = NULL WHERE id = $1 AND is_paper = $2', [
          chain.id,
          getCtxIsPaper(),
        ])
        .catch(() => {});
    }
  }

  const summary = decisions.map((d) => `${d.stock_code} x${d.quantity} — ${d.reasoning}`).join('\n');
  await sendByPaperFlag(getCtxIsPaper(), `🚪 탈출 매도 실행:\n${summary}`);
}
