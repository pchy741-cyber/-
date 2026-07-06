import { KIS_TR_ID, STRATEGY_PARAMS } from '../config/constants.js';
import { getCtxIsPaper } from '../config/context.js';
import { getActiveStrategy, getPool, logSystem } from '../db/client.js';
import { kisRequest } from '../kis/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { calculateFearGreedIndex, getMacroSnapshot } from './macro-data.js';

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

export interface FactorDetail {
  label: string;
  value: number;
  impact: 'bull' | 'bear' | 'neutral';
  weight: number;
}

export interface MarketRegime {
  regime: 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'PANIC';
  kospiChange: number;
  kospi200Change: number;
  foreignNetBuy: number;
  vix: number;
  fearGreed: number;
  consecutiveDays: number; // 양수=연속 상승일, 음수=연속 하락일
  score: number; // 종합 점수 (양수=강세, 음수=약세)
  recommendedMode: 'SWING' | 'SCALPING' | 'DEFENSE';
  reasons: string[];
  bullFactors: string[];   // 상승 요인 목록
  bearFactors: string[];   // 하락 요인 목록
  factorDetail: Record<string, FactorDetail>;
}

// ── ⑧ AI 뉴스 분석 → regime 스코어 (v22.1 하이브리드) ──
// FinBERT + Gemini 분석 결과를 regime 점수로 변환
// 기존 키워드 매칭 대신 AI가 판단한 regimeAdjustment 직접 사용
async function assessNewsShockForRegime(): Promise<{ score: number; reasons: string[] }> {
  try {
    const { analyzeNewsHeadlines, getCachedNewsAnalysis } = await import('./news-analyzer.js');

    // 캐시 우선 (30분 TTL)
    let analysis = getCachedNewsAnalysis();
    if (!analysis) {
      analysis = await analyzeNewsHeadlines();
    }

    if (analysis.regimeAdjustment === 0) return { score: 0, reasons: [] };

    const src = analysis.analysisSource === 'hybrid' ? 'AI' : analysis.analysisSource === 'finbert_only' ? 'FinBERT' : '키워드';
    const reason = `뉴스${src}: ${analysis.marketImpactSummary || `조정 ${analysis.regimeAdjustment}`}`;
    return { score: analysis.regimeAdjustment, reasons: [reason] };
  } catch {
    return { score: 0, reasons: [] };
  }
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
    const data = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(data)) return [];
    // 최신순 → 최근 5거래일 종가 반환
    return data
      .slice(0, 5)
      .map((d: Record<string, unknown>) => Number(d.closePrice ?? d.endPrice ?? 0))
      .filter((v) => v > 0);
  } catch (err) {
    logger.debug(`KOSPI 일봉 조회 실패: ${err}`, { component: 'REGIME' });
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
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().split('T')[0].replace(/-/g, '');
    const weekAgo = new Date(Date.now() + 9 * 3600_000 - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]
      .replace(/-/g, '');
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
  } catch (err) {
    logger.debug(`시장 외국인 수급 조회 실패: ${err}`, { component: 'REGIME' });
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
  } catch (err) {
    logger.debug(`KOSPI200 등락률 조회 실패: ${err}`, { component: 'REGIME' });
    return 0;
  }
}

/**
 * 다중 팩터 장세 판단
 */
export async function detectMarketRegime(): Promise<MarketRegime> {
  const reasons: string[] = [];

  // 병렬 데이터 수집 (FRED 매크로 + 뉴스 충격 + US 세션 마감 판정 — Gemini 미관여, 독립 신호)
  const [macro, kospiHistory, foreignNet, kospi200Change, fredAdj, newsShockAdj, usCloseAdj] = await Promise.all([
    getMacroSnapshot().catch(() => null),
    fetchKospiHistory(),
    fetchMarketForeignNet(),
    fetchKospi200Change(),
    import('../market/fred-macro.js').then((m) => m.getFredMacroAdjustment()).catch(() => ({ score: 0, reasons: [] })),
    assessNewsShockForRegime().catch(() => ({ score: 0, reasons: [] as string[] })),
    import('../scheduler/overseas/session.js').then((m) => m.getUSCloseInfluence()).catch(() => null),
  ]);

  const kospiChange = macro?.kospiChange ?? 0;
  const vkospi = macro?.vkospi ?? 20;
  const fearGreed = macro?.fearGreedIndex ?? calculateFearGreedIndex(vkospi, kospiChange);
  const consecutiveDays = calcConsecutiveDays(kospiHistory);

  // ── 점수 계산 (양수=강세, 음수=약세) + Bull/Bear 팩터 분리 ──
  let score = 0;
  const bullFactors: string[] = [];
  const bearFactors: string[] = [];
  const factorDetail: Record<string, FactorDetail> = {};

  // 헬퍼: 팩터 추가 + bull/bear 분류
  const addFactor = (key: string, label: string, value: number, pts: number) => {
    score += pts;
    const impact: 'bull' | 'bear' | 'neutral' = pts > 0 ? 'bull' : pts < 0 ? 'bear' : 'neutral';
    factorDetail[key] = { label, value, impact, weight: Math.abs(pts) };
    reasons.push(label);
    if (impact === 'bull') bullFactors.push(label);
    else if (impact === 'bear') bearFactors.push(label);
  };

  // ① 오늘 KOSPI 등락률
  if (kospiChange >= 1.5) {
    addFactor('kospi', `KOSPI +${kospiChange.toFixed(1)}% 강세`, kospiChange, 4);
  } else if (kospiChange >= 0.5) {
    addFactor('kospi', `KOSPI +${kospiChange.toFixed(1)}%`, kospiChange, 2);
  } else if (kospiChange <= -2.0) {
    addFactor('kospi', `KOSPI ${kospiChange.toFixed(1)}% 급락`, kospiChange, -5);
  } else if (kospiChange <= -1.0) {
    addFactor('kospi', `KOSPI ${kospiChange.toFixed(1)}% 하락`, kospiChange, -3);
  } else if (kospiChange <= -0.5) {
    addFactor('kospi', `KOSPI ${kospiChange.toFixed(1)}%`, kospiChange, -1);
  }

  // ② 연속 상승/하락일
  if (consecutiveDays >= 3) {
    addFactor('streak', `연속 ${consecutiveDays}일 상승`, consecutiveDays, 3);
  } else if (consecutiveDays >= 2) {
    addFactor('streak', `연속 ${consecutiveDays}일 상승`, consecutiveDays, 1);
  } else if (consecutiveDays <= -3) {
    addFactor('streak', `연속 ${Math.abs(consecutiveDays)}일 하락`, consecutiveDays, -4);
  } else if (consecutiveDays <= -2) {
    addFactor('streak', `연속 ${Math.abs(consecutiveDays)}일 하락`, consecutiveDays, -2);
  }

  // ③ VKOSPI (공포지수)
  if (vkospi >= 35) {
    addFactor('vkospi', `VKOSPI ${vkospi.toFixed(1)} (극단 공포)`, vkospi, -4);
  } else if (vkospi >= 25) {
    addFactor('vkospi', `VKOSPI ${vkospi.toFixed(1)} (공포)`, vkospi, -2);
  } else if (vkospi <= 14) {
    addFactor('vkospi', `VKOSPI ${vkospi.toFixed(1)} (극단 탐욕)`, vkospi, 3);
  } else if (vkospi <= 18) {
    addFactor('vkospi', `VKOSPI ${vkospi.toFixed(1)} 안정`, vkospi, 1);
  }

  // ④ 외국인 수급 (3일 합산)
  if (foreignNet > 3000) {
    addFactor('foreign', `외국인 순매수 +${(foreignNet / 100).toFixed(0)}억`, foreignNet, 3);
  } else if (foreignNet > 500) {
    addFactor('foreign', `외국인 순매수`, foreignNet, 1);
  } else if (foreignNet < -3000) {
    addFactor('foreign', `외국인 순매도 ${(Math.abs(foreignNet) / 100).toFixed(0)}억`, foreignNet, -3);
  } else if (foreignNet < -500) {
    addFactor('foreign', `외국인 순매도`, foreignNet, -1);
  }

  // ⑤ Fear & Greed
  if (fearGreed >= 75) {
    addFactor('feargreed', `탐욕 지수 ${fearGreed}`, fearGreed, 2);
  } else if (fearGreed >= 60) {
    score += 1; // 약한 신호는 reasons에 안 넣되 점수만
  } else if (fearGreed <= 20) {
    addFactor('feargreed', `극단 공포 → 역발상 매수 (F&G ${fearGreed})`, fearGreed, 1);
  } else if (fearGreed <= 35) {
    addFactor('feargreed', `공포 지수 ${fearGreed}`, fearGreed, -2);
  }

  // ⑥ KOSPI200 이중 확인
  if (kospi200Change <= -2.0) {
    addFactor('kospi200', `KOSPI200 ${kospi200Change.toFixed(1)}% 급락`, kospi200Change, -2);
  }

  // ⑦ FRED 미국 매크로 (Fed 금리/CPI/실업률/수익률곡선/VIX) — 독립 신호
  if (fredAdj.score !== 0) {
    for (const r of fredAdj.reasons) {
      const fredPts = fredAdj.score > 0
        ? Math.ceil(fredAdj.score / fredAdj.reasons.length)
        : Math.floor(fredAdj.score / fredAdj.reasons.length);
      addFactor(`fred_${r.slice(0, 10)}`, `FRED: ${r}`, fredAdj.score, fredPts);
    }
  }

  // ⑧ 매크로 뉴스 충격 (v22: 국민연금·금리인상·전쟁 등 대형 이벤트)
  if (newsShockAdj.score !== 0) {
    for (const r of newsShockAdj.reasons) {
      addFactor(`news_${r.slice(0, 10)}`, r, newsShockAdj.score, newsShockAdj.score);
    }
  }

  // ⑨ US 세션 마감 분위기 → KR 장세 전달 (미국=구매자, 한국=공급자 연동)
  if (usCloseAdj && usCloseAdj.score !== 0) {
    const dir = usCloseAdj.score > 0 ? '강세' : '약세';
    addFactor('us_close', `US마감 ${dir} (${usCloseAdj.regime}, ${usCloseAdj.age.toFixed(0)}h전)`, usCloseAdj.score, usCloseAdj.score);
  }

  // ── 체제 판단 ──
  let regime: MarketRegime['regime'];
  let recommendedMode: MarketRegime['recommendedMode'];

  if (score >= 6) {
    regime = 'BULLISH';
    recommendedMode = 'SWING'; // v10.2: SCALPING 영구 비활성화 → 강세장도 SWING (적극 매매)
    reasons.push(`강세장 스코어 ${score} → SWING 모드 (적극 매매)`);
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
    recommendedMode = 'DEFENSE';
    reasons.push(`공황 스코어 ${score} → DEFENSE 방어`);
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
    bullFactors,
    bearFactors,
    factorDetail,
  };
}

/**
 * 장세 한글 종합 딥 요약 — 프론트엔드 뉴스탭 표시용 (v23: 딥 분석)
 * 기존 한줄 → 상승/하락 요인 대비 구조의 3~4문장 분석
 */
export function generateMarketSummaryKorean(regime: MarketRegime): string {
  const moodKr: Record<string, string> = {
    BULLISH: '상승장',
    NEUTRAL: '보합장',
    BEARISH: '하락장',
    PANIC: '공황장',
  };
  const mood = moodKr[regime.regime] || '보합장';

  const bulls = regime.bullFactors;
  const bears = regime.bearFactors;

  // 핵심 수치 포맷
  const kospiStr = `KOSPI ${regime.kospiChange >= 0 ? '+' : ''}${regime.kospiChange.toFixed(1)}%`;
  const foreignStr = regime.foreignNetBuy !== 0
    ? `외국인 ${regime.foreignNetBuy > 0 ? '순매수' : '순매도'} ${Math.abs(regime.foreignNetBuy / 100).toFixed(0)}억`
    : '';
  const vkospiStr = regime.vix > 0 ? `VKOSPI ${regime.vix.toFixed(1)}` : '';

  const parts: string[] = [];

  if (regime.regime === 'NEUTRAL') {
    // 보합장: 상승/하락 요인 대비 구조 강조
    if (bulls.length > 0 && bears.length > 0) {
      parts.push(`상승 요인(${bulls.slice(0, 2).join(', ')})과 하락 요인(${bears.slice(0, 2).join(', ')})이 맞서며 팽팽한 균형.`);
    } else if (bulls.length > 0) {
      parts.push(`${bulls.slice(0, 2).join(', ')} 등 긍정 신호에도 추가 모멘텀 부재로 관망세.`);
    } else if (bears.length > 0) {
      parts.push(`${bears.slice(0, 2).join(', ')} 등 부정 요인이 있으나 하방 지지가 유효.`);
    } else {
      parts.push(`뚜렷한 방향성 없이 횡보 중.`);
    }
    parts.push(`${kospiStr}${foreignStr ? ', ' + foreignStr : ''}${vkospiStr ? ', ' + vkospiStr : ''}.`);
  } else if (regime.regime === 'BULLISH') {
    parts.push(`${bulls.slice(0, 3).join(', ')} 등이 시장을 견인하며 상승 흐름.`);
    if (bears.length > 0) {
      parts.push(`다만 ${bears.slice(0, 2).join(', ')} 등 리스크 요인은 주시 필요.`);
    }
    parts.push(`${kospiStr}, 적극 매매 구간.`);
  } else if (regime.regime === 'BEARISH') {
    parts.push(`${bears.slice(0, 3).join(', ')} 등 하락 압력이 우세.`);
    if (bulls.length > 0) {
      parts.push(`${bulls.slice(0, 2).join(', ')} 등이 바닥을 지지하나 반등 모멘텀 약함.`);
    }
    parts.push(`${kospiStr}, 방어 모드 전환 권장.`);
  } else {
    // PANIC
    parts.push(`${bears.slice(0, 3).join(', ')} 등 복합 악재로 시장 패닉.`);
    parts.push(`${kospiStr}${vkospiStr ? ', ' + vkospiStr : ''}, 최대 방어 태세.`);
  }

  return `오늘은 ${mood} (스코어 ${regime.score >= 0 ? '+' : ''}${regime.score}). ${parts.join(' ')}`;
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

    // v10.2: SCALPING 영구 비활성화 — 혹시 다른 경로에서 SCALPING이 들어와도 SWING으로 강제
    if (targetMode === 'SCALPING') {
      targetMode = 'SWING';
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
      logger.info(
        `전략 전환 보류: 마지막 전환 후 ${hoursSinceSwitch.toFixed(1)}h (최소 6h 필요) — ${currentMode} 유지`,
        { component: 'REGIME' },
      );
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
        [
          targetMode,
          true,
          currentStrategy?.gemini_prompt ?? '',
          currentStrategy?.gpt_prompt ?? '',
          currentStrategy?.claude_prompt ?? '',
          newBuyThreshold,
          newStopLoss,
          currentStrategy?.take_profit_pct ?? 8.0,
          currentStrategy?.notebooklm_prompt ?? '',
          currentStrategy?.strategy_document ?? '',
          currentStrategy?.risk_prompt ?? '',
          isPaper,
        ],
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
    ).catch(() => {});

    const { onModeSwitch } = await import('./ceo-workflow.js');
    await onModeSwitch(currentMode, targetMode);
  } catch (error) {
    logger.error(`장세 감지 실패: ${error}`, { component: 'REGIME' });
  }
}
