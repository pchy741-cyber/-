import { KIS_TR_ID, STRATEGY_PARAMS } from '../config/constants.js';
import { getActiveStrategy, getPool, logSystem } from '../db/client.js';
import { kisRequest } from '../kis/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { getMacroSnapshot, calculateFearGreedIndex } from './macro-data.js';
import { logger } from '../utils/logger.js';
import { getCtxIsPaper } from '../config/context.js';

/**
 * 장세 자동 감지 & 전략 모드 자동 전환 (v2)
 *
 * 다중 팩터 스코어링:
 * ① 오늘 KOSPI 등락률
 * ② 연속 상승/하락일 수 (최근 5거래일)
 * ③ VKOSPI (변동성 지수) — 공포/탐욕 판단
 * ④ 외국인 순매수 방향 (KIS 시장 수급)
 * ⑤ Fear & Greed Index (VKOSPI + KOSPI 합산)
 *
 * 점수 합산 → BULLISH / NEUTRAL / BEARISH / PANIC 판정
 * → SWING / DEFENSE / DIVIDEND 모드 자동 전환
 */

export interface MarketRegime {
  regime: 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'PANIC';
  kospiChange: number;
  kospi200Change: number;
  foreignNetBuy: number;
  vix: number;
  fearGreed: number;
  consecutiveDays: number; // 양수=연속 상승일, 음수=연속 하락일
  score: number;           // 종합 점수 (양수=강세, 음수=약세)
  recommendedMode: 'SWING' | 'SCALPING' | 'DEFENSE' | 'DIVIDEND';
  reasons: string[];
}

// ── KOSPI 최근 5일 종가 (Naver) ──
async function fetchKospiHistory(): Promise<number[]> {
  try {
    const end = new Date();
    const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().split('T')[0].replace(/-/g, '');
    const url = `https://m.stock.naver.com/api/index/KOSPI/price?startTime=${fmt(start)}&endTime=${fmt(end)}&pageSize=10&type=DAYBYDAY`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown>[];
    if (!Array.isArray(data)) return [];
    // 최신순 → 최근 5거래일 종가 반환
    return data.slice(0, 5).map((d: any) => Number(d.closePrice ?? d.endPrice ?? 0)).filter(v => v > 0);
  } catch {
    return [];
  }
}

// ── 연속 상승/하락일 계산 ──
function calcConsecutiveDays(prices: number[]): number {
  if (prices.length < 2) return 0;
  // prices[0] = 최신, prices[1] = 전일 ...
  const isUp = prices[0] > prices[1];
  let streak = isUp ? 1 : -1;
  for (let i = 1; i < prices.length - 1; i++) {
    if (isUp && prices[i] > prices[i + 1]) streak++;
    else if (!isUp && prices[i] < prices[i + 1]) streak--;
    else break;
  }
  return streak;
}

// ── KIS 시장 외국인 수급 (KOSPI 전체) ──
async function fetchMarketForeignNet(): Promise<number> {
  try {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0].replace(/-/g, '');
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-investor',
      trId: KIS_TR_ID.QUOTE.INVESTOR_FLOW,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: '0001', // KOSPI 지수 코드
        FID_INPUT_DATE_1: weekAgo,
        FID_INPUT_DATE_2: today,
      },
    });
    const items = ((res.output ?? []) as Record<string, string>[]).slice(0, 3); // 최근 3일
    if (items.length === 0) return 0;
    // 외국인 순매수 금액 합산 (frgn_ntby_tr_pbmn = 외국인 순매수 거래대금 억원)
    const total = items.reduce((sum, item) => {
      return sum + Number(item.frgn_ntby_tr_pbmn ?? item.frgn_ntby_qty ?? 0);
    }, 0);
    return total;
  } catch {
    return 0;
  }
}

// ── KOSPI 200 등락률 ──
async function fetchKospi200Change(): Promise<number> {
  try {
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-price',
      trId: KIS_TR_ID.QUOTE.CURRENT_PRICE,
      params: { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0101' },
    });
    const o = res.output as Record<string, string>;
    return Number(o?.prdy_ctrt ?? 0);
  } catch {
    return 0;
  }
}

/**
 * 다중 팩터 장세 판단
 */
export async function detectMarketRegime(): Promise<MarketRegime> {
  const reasons: string[] = [];

  // 병렬 데이터 수집
  const [macro, kospiHistory, foreignNet, kospi200Change] = await Promise.all([
    getMacroSnapshot().catch(() => null),
    fetchKospiHistory(),
    fetchMarketForeignNet(),
    fetchKospi200Change(),
  ]);

  const kospiChange = macro?.kospiChange ?? 0;
  const vkospi = macro?.vkospi ?? 20;
  const fearGreed = macro?.fearGreedIndex ?? calculateFearGreedIndex(vkospi, kospiChange);
  const consecutiveDays = calcConsecutiveDays(kospiHistory);

  // ── 점수 계산 (양수=강세, 음수=약세) ──
  let score = 0;

  // ① 오늘 KOSPI 등락률
  if (kospiChange >= 1.5) { score += 4; reasons.push(`KOSPI +${kospiChange.toFixed(1)}% 강세`); }
  else if (kospiChange >= 0.5) { score += 2; reasons.push(`KOSPI +${kospiChange.toFixed(1)}%`); }
  else if (kospiChange <= -2.0) { score -= 5; reasons.push(`KOSPI ${kospiChange.toFixed(1)}% 급락`); }
  else if (kospiChange <= -1.0) { score -= 3; reasons.push(`KOSPI ${kospiChange.toFixed(1)}% 하락`); }
  else if (kospiChange <= -0.5) { score -= 1; reasons.push(`KOSPI ${kospiChange.toFixed(1)}%`); }

  // ② 연속 상승/하락일
  if (consecutiveDays >= 3) { score += 3; reasons.push(`연속 ${consecutiveDays}일 상승`); }
  else if (consecutiveDays >= 2) { score += 1; reasons.push(`연속 ${consecutiveDays}일 상승`); }
  else if (consecutiveDays <= -3) { score -= 4; reasons.push(`연속 ${Math.abs(consecutiveDays)}일 하락`); }
  else if (consecutiveDays <= -2) { score -= 2; reasons.push(`연속 ${Math.abs(consecutiveDays)}일 하락`); }

  // ③ VKOSPI (공포지수)
  if (vkospi >= 35) { score -= 4; reasons.push(`VKOSPI ${vkospi.toFixed(1)} (극단 공포)`); }
  else if (vkospi >= 25) { score -= 2; reasons.push(`VKOSPI ${vkospi.toFixed(1)} (공포)`); }
  else if (vkospi <= 14) { score += 3; reasons.push(`VKOSPI ${vkospi.toFixed(1)} (극단 탐욕)`); }
  else if (vkospi <= 18) { score += 1; reasons.push(`VKOSPI ${vkospi.toFixed(1)} (탐욕)`); }

  // ④ 외국인 수급 (3일 합산)
  if (foreignNet > 3000) { score += 3; reasons.push(`외국인 3일 순매수 ${(foreignNet / 100).toFixed(0)}억`); }
  else if (foreignNet > 500) { score += 1; reasons.push(`외국인 순매수`); }
  else if (foreignNet < -3000) { score -= 3; reasons.push(`외국인 3일 순매도 ${(Math.abs(foreignNet) / 100).toFixed(0)}억`); }
  else if (foreignNet < -500) { score -= 1; reasons.push(`외국인 순매도`); }

  // ⑤ Fear & Greed
  if (fearGreed >= 75) { score += 2; reasons.push(`탐욕 지수 ${fearGreed}`); }
  else if (fearGreed >= 60) { score += 1; }
  else if (fearGreed <= 20) { score += 1; reasons.push(`극단 공포 → 역발상 매수 (F&G ${fearGreed})`); } // 역발상
  else if (fearGreed <= 35) { score -= 2; reasons.push(`공포 지수 ${fearGreed}`); }

  // ⑥ KOSPI200 이중 확인
  if (kospi200Change <= -2.0) { score -= 2; reasons.push(`KOSPI200 ${kospi200Change.toFixed(1)}% 급락`); }

  // ── 체제 판단 ──
  let regime: MarketRegime['regime'];
  let recommendedMode: MarketRegime['recommendedMode'];

  if (score >= 6) {
    regime = 'BULLISH';
    recommendedMode = 'SCALPING'; // 강세장 → 공격적 스캘핑
    reasons.push(`강세장 스코어 ${score} → SCALPING 모드`);
  } else if (score >= 2) {
    regime = 'BULLISH';
    recommendedMode = 'SWING';
    reasons.push(`상승장 스코어 ${score} → SWING 모드`);
  } else if (score >= -2) {
    regime = 'NEUTRAL';
    recommendedMode = 'SWING';
    reasons.push(`중립장 스코어 ${score} → SWING 유지`);
  } else if (score >= -5) {
    regime = 'BEARISH';
    recommendedMode = 'DEFENSE';
    reasons.push(`하락장 스코어 ${score} → DEFENSE 모드`);
  } else {
    regime = 'PANIC';
    recommendedMode = 'DIVIDEND';
    reasons.push(`공황 스코어 ${score} → DIVIDEND 파킹`);
  }

  return {
    regime,
    kospiChange,
    kospi200Change,
    foreignNetBuy: foreignNet,
    vix: vkospi,
    fearGreed,
    consecutiveDays,
    score,
    recommendedMode,
    reasons,
  };
}

/**
 * 장세 한글 종합 한마디 — 프론트엔드 뉴스탭 표시용
 */
export function generateMarketSummaryKorean(regime: MarketRegime): string {
  const moodKr: Record<string, string> = {
    BULLISH: '상승장', NEUTRAL: '보합장', BEARISH: '하락장', PANIC: '공황장',
  };
  const mood = moodKr[regime.regime] || '보합장';
  const factors: string[] = [];

  if (regime.foreignNetBuy > 500) factors.push('외국인 매수세 강함');
  else if (regime.foreignNetBuy < -500) factors.push('외국인 매도세 지속');

  if (regime.vix >= 25) factors.push('변동성 높은 불안한 장세');
  else if (regime.vix > 0 && regime.vix <= 18) factors.push('변동성 낮아 안정적');

  if (regime.consecutiveDays >= 3) factors.push(`${regime.consecutiveDays}일 연속 상승 중`);
  else if (regime.consecutiveDays <= -3) factors.push(`${Math.abs(regime.consecutiveDays)}일 연속 하락 중`);

  if (regime.fearGreed >= 70) factors.push('탐욕 구간 진입');
  else if (regime.fearGreed > 0 && regime.fearGreed <= 30) factors.push('공포 구간');

  if (regime.kospiChange >= 1.0) factors.push(`KOSPI +${regime.kospiChange.toFixed(1)}%`);
  else if (regime.kospiChange <= -1.0) factors.push(`KOSPI ${regime.kospiChange.toFixed(1)}%`);

  const factorStr = factors.length > 0 ? ` ${factors.join(', ')}.` : '';
  return `오늘은 ${mood} 분위기입니다 (스코어 ${regime.score >= 0 ? '+' : ''}${regime.score}).${factorStr}`;
}

/**
 * 장세 감지 → 전략 자동 전환
 */
export async function autoSwitchStrategy(): Promise<void> {
  try {
    const regime = await detectMarketRegime();
    const currentStrategy = await getActiveStrategy();
    const currentMode = currentStrategy?.mode ?? 'SWING';

    // 마지막 전환 후 경과 시간 (시간 단위) — 과도한 전환 방지용
    const updatedAt = currentStrategy?.updated_at ? new Date(currentStrategy.updated_at) : null;
    const hoursSinceSwitch = updatedAt ? (Date.now() - updatedAt.getTime()) / 3_600_000 : 999;

    let targetMode = regime.recommendedMode as string;

    // DEFENSE 지속 중 여전히 BEARISH → DIVIDEND 에스컬레이션 (24시간 이상 지속 후에만)
    if (currentMode === 'DEFENSE' && (regime.regime === 'BEARISH' || regime.regime === 'PANIC')) {
      if (hoursSinceSwitch >= 24) {
        targetMode = 'DIVIDEND';
        regime.reasons.push(`DEFENSE ${hoursSinceSwitch.toFixed(0)}h 지속 → DIVIDEND 에스컬레이션`);
      } else {
        targetMode = 'DEFENSE'; // 24시간 미경과 → 에스컬레이션 보류
        regime.reasons.push(`DEFENSE 유지 (전환 후 ${hoursSinceSwitch.toFixed(0)}h < 24h)`);
      }
    }
    // DIVIDEND 중 장세 회복 → SWING 복귀
    else if ((currentMode as string) === 'DIVIDEND' && (regime.regime === 'NEUTRAL' || regime.regime === 'BULLISH')) {
      targetMode = 'SWING';
      regime.reasons.push('장세 회복 → DIVIDEND → SWING 복귀');
    }
    // SCALPING은 강세장 스코어 6이상 + 현재 SWING일 때만 전환 (과도한 전환 방지)
    if (targetMode === 'SCALPING' && currentMode !== 'SWING') {
      targetMode = currentMode; // DEFENSE/DIVIDEND 중엔 SCALPING 전환 안 함
    }

    // ── 히스테리시스: 진입/탈출 기준 이중화 (모드 경계 근처 과도한 전환 방지) ──
    // SWING → DEFENSE: score ≤ -4 필요 (기본 -3보다 1점 엄격)
    if (currentMode === 'SWING' && targetMode === 'DEFENSE' && regime.score > -4) {
      targetMode = 'SWING';
      regime.reasons.push(`히스테리시스: SWING 유지 (스코어 ${regime.score} > -4)`);
    }
    // DEFENSE → SWING: score ≥ 0 필요 (기본 -2보다 2점 엄격 — 충분한 회복 확인)
    if (currentMode === 'DEFENSE' && targetMode === 'SWING' && regime.score < 0) {
      targetMode = 'DEFENSE';
      regime.reasons.push(`히스테리시스: DEFENSE 유지 (스코어 ${regime.score} < 0)`);
    }

    // ── 최소 체류 시간: 6시간 미만 전환 보류 (같은 날 12:00 재판단 시 즉시 번복 방지) ──
    if (targetMode !== currentMode && hoursSinceSwitch < 6) {
      logger.info(`전략 전환 보류: 마지막 전환 후 ${hoursSinceSwitch.toFixed(1)}h (최소 6h 필요) — ${currentMode} 유지`, { component: 'REGIME' });
      return;
    }

    logger.info(
      `장세 감지: ${regime.regime} | 스코어 ${regime.score} | KOSPI ${regime.kospiChange > 0 ? '+' : ''}${regime.kospiChange.toFixed(1)}% | VKOSPI ${regime.vix.toFixed(1)} | 연속 ${regime.consecutiveDays}일 | 외국인 ${regime.foreignNetBuy > 0 ? '+' : ''}${regime.foreignNetBuy} → ${targetMode}`,
      { component: 'REGIME' },
    );

    if (currentMode === targetMode) return;

    const modeParams = STRATEGY_PARAMS[targetMode as keyof typeof STRATEGY_PARAMS];
    const newBuyThreshold = modeParams?.buyThreshold ?? 65;
    const newStopLoss = modeParams?.stopLossPct ?? -5.0;

    const isPaper = getCtxIsPaper();
    const { rowCount: updCount } = await getPool().query(
      `UPDATE strategy_config SET mode=$1, buy_threshold=$2, stop_loss_pct=$3, updated_at=NOW() WHERE is_active=true AND is_paper=$4`,
      [targetMode, newBuyThreshold, newStopLoss, isPaper],
    );

    if ((updCount ?? 0) === 0) {
      await getPool().query(
        `INSERT INTO strategy_config
           (mode, is_active, gemini_prompt, gpt_prompt, claude_prompt,
            buy_threshold, stop_loss_pct, take_profit_pct, notebooklm_prompt, strategy_document, risk_prompt, is_paper)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [targetMode, true,
          currentStrategy?.gemini_prompt ?? '', currentStrategy?.gpt_prompt ?? '', currentStrategy?.claude_prompt ?? '',
          newBuyThreshold, newStopLoss, currentStrategy?.take_profit_pct ?? 8.0,
          currentStrategy?.notebooklm_prompt ?? '', currentStrategy?.strategy_document ?? '', currentStrategy?.risk_prompt ?? '', isPaper],
      );
    }

    const regimeEmoji = { BULLISH: '🟢', NEUTRAL: '⚪', BEARISH: '🔴', PANIC: '💀' }[regime.regime];
    await logSystem('WARN', 'REGIME', `전략 자동 전환: ${currentMode} → ${targetMode} (${regime.reasons.join(', ')})`);
    await sendTelegramMessage(
      `${regimeEmoji} *전략 자동 전환*\n` +
      `${currentMode} → *${targetMode}*\n\n` +
      `장세: ${regime.regime} (스코어 ${regime.score})\n` +
      `KOSPI: ${regime.kospiChange > 0 ? '+' : ''}${regime.kospiChange.toFixed(1)}% | 연속 ${regime.consecutiveDays}일\n` +
      `VKOSPI: ${regime.vix.toFixed(1)} | F&G: ${regime.fearGreed}\n` +
      `외국인: ${regime.foreignNetBuy > 0 ? '+' : ''}${regime.foreignNetBuy}\n\n` +
      `사유: ${regime.reasons.slice(-3).join(' / ')}\n` +
      `수동 변경: 대시보드 > 설정`,
    );

    const { onModeSwitch } = await import('./ceo-workflow.js');
    await onModeSwitch(currentMode, targetMode);
  } catch (error) {
    logger.error(`장세 감지 실패: ${error}`, { component: 'REGIME' });
  }
}
