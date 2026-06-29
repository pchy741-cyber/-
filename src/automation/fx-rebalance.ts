/**
 * 💱 통합증거금 KRW↔USD 시간별 자동 재배분 자문
 *
 * 배경: KIS 통합증거금 모드라도 KRW 예수금과 USD 외수금이 별도 풀로 유지됨
 *       → KR장 활성 시 USD가 idle, US장 활성 시 KRW가 idle
 *
 * 동작:
 * - 시간대별 목표 비중 계산 (KR=75% / US=75% / 장외=50%)
 * - 현재 비중과 5%p 이상 차이 → Telegram 알림
 * - env ENABLE_FX_AUTO_REBALANCE=true → 자동 환전 실행 (TODO: KIS 환전 API 통합)
 */

import { getCtxIsPaper } from '../config/context.js';
import { getPool } from '../db/client.js';
import { getAccountBalance } from '../kis/account.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { fetchExchangeRate } from './macro-data.js';

const COMP = 'FX_REBAL';

interface CashState {
  krwTotal: number; // 원화 주문가능 (KRW)
  usdTotal: number; // 달러 잔고 (USD)
  usdInKrw: number; // USD를 KRW로 환산
  fxRate: number; // USD/KRW
  krwPct: number; // 전체에서 KRW 비중
  usdPct: number;
}

async function readCashState(): Promise<CashState> {
  const fxRate = await fetchExchangeRate();
  const balance = await getAccountBalance(true).catch(() => ({ orderableCash: 0 }) as any);
  const krwTotal = Number(balance.orderableCash ?? 0);

  // USD 잔고: overseas_state (paper: cash_paper, live: cash)
  const cashKey = getCtxIsPaper() ? 'cash_paper' : 'cash';
  const { rows } = await getPool()
    .query('SELECT value FROM overseas_state WHERE key = $1', [cashKey])
    .catch(() => ({ rows: [] as Array<{ value: string }> }));
  const usdTotal = Number(rows[0]?.value ?? 0);

  const usdInKrw = usdTotal * fxRate;
  const total = krwTotal + usdInKrw;
  const krwPct = total > 0 ? (krwTotal / total) * 100 : 50;
  const usdPct = 100 - krwPct;
  return { krwTotal, usdTotal, usdInKrw, fxRate, krwPct, usdPct };
}

function computeTarget(now: Date): { krwPctTarget: number; reason: string } {
  const kstH = (now.getUTCHours() + 9) % 24;
  const krActive = kstH >= 9 && kstH < 16; // KR 정규장
  const usActive = kstH >= 22 || kstH < 7; // US 정규장 (KST 22:30 ~ 06:00, 대략)

  if (krActive && !usActive) return { krwPctTarget: 75, reason: 'KR 정규장 → KRW 75%' };
  if (usActive && !krActive) return { krwPctTarget: 25, reason: 'US 정규장 → USD 75%' };
  return { krwPctTarget: 50, reason: '장외시간 → 50/50 균형' };
}

// 장기 보완 #3: 텔레그램 알림 쿨다운 4시간 (이전 15분 → 폭주 방지)
const TG_COOLDOWN_MS = 4 * 60 * 60_000;
let _lastTgAt = 0;
let _lastImbalanceDirection: 'KRW_short' | 'KRW_excess' | 'balanced' = 'balanced';

export async function runFxRebalance(): Promise<void> {
  try {
    const state = await readCashState();
    const target = computeTarget(new Date());
    const totalKrw = state.krwTotal + state.usdInKrw;

    // 총 자산 100만원 미만이면 의미 없음
    if (totalKrw < 1_000_000) {
      logger.debug(`FX 자문 스킵: 총 자산 ${Math.round(totalKrw / 10000)}만원 < 100만`, { component: COMP });
      return;
    }

    const targetKrwAmount = totalKrw * (target.krwPctTarget / 100);
    const krwImbalance = targetKrwAmount - state.krwTotal; // +: KRW 부족, -: KRW 초과
    const imbalancePct = (Math.abs(krwImbalance) / totalKrw) * 100;

    logger.info(
      `📊 FX 자문: ${target.reason} | 현재 KRW${state.krwPct.toFixed(0)}% USD${state.usdPct.toFixed(0)}% → 목표 KRW${target.krwPctTarget}% (불균형 ${imbalancePct.toFixed(0)}%p)`,
      { component: COMP },
    );

    // v16.2: 3%p 이상 불균형 시 알림 (기존 5% → idle KRW 빠르게 감지)
    if (imbalancePct < 3) {
      _lastImbalanceDirection = 'balanced';
      return;
    }
    const currentDirection: typeof _lastImbalanceDirection = krwImbalance > 0 ? 'KRW_short' : 'KRW_excess';
    const sinceLast = Date.now() - _lastTgAt;
    const directionChanged = currentDirection !== _lastImbalanceDirection;
    if (sinceLast < TG_COOLDOWN_MS && !directionChanged) {
      logger.debug(`FX 알림 스킵: 쿨다운 ${Math.round(sinceLast / 60_000)}분 < 240분 (방향 동일)`, { component: COMP });
      return;
    }
    _lastTgAt = Date.now();
    _lastImbalanceDirection = currentDirection;

    const direction = krwImbalance > 0 ? 'USD→KRW' : 'KRW→USD';
    const usdEquiv = Math.abs(krwImbalance) / state.fxRate;
    const krwEquiv = Math.abs(krwImbalance);
    const action =
      krwImbalance > 0
        ? `${direction} 환전 약 $${usdEquiv.toFixed(0)} (≈ ${Math.round(krwEquiv / 10000)}만원)`
        : `${direction} 환전 약 ${Math.round(krwEquiv / 10000)}만원 (≈ $${usdEquiv.toFixed(0)})`;

    const mode = getCtxIsPaper() ? '연습' : '실전';
    const msg = [
      `💱 *FX 재배분 자문* [${mode}] (${target.reason})`,
      ``,
      `현재: KRW ${Math.round(state.krwTotal / 10000)}만(${state.krwPct.toFixed(0)}%) / USD $${state.usdTotal.toFixed(0)}(${state.usdPct.toFixed(0)}%)`,
      `목표: KRW ${target.krwPctTarget}% / USD ${100 - target.krwPctTarget}%`,
      `권장: *${action}*`,
      ``,
      `환율: ₩${state.fxRate.toFixed(0)}/USD`,
      ``,
      process.env.ENABLE_FX_AUTO_REBALANCE === 'true'
        ? `🔧 자동 환전: KIS 환전 API 통합 대기 중 (수동 환전 필요)`
        : `※ 한투앱에서 수동 환전 권장 (자동: env ENABLE_FX_AUTO_REBALANCE=true)`,
    ].join('\n');

    await sendTelegramMessage(msg).catch(() => {});

    // 자동 실행 (TODO: KIS 환전 API 통합)
    if (process.env.ENABLE_FX_AUTO_REBALANCE === 'true' && !getCtxIsPaper()) {
      logger.warn(`⚠️ ENABLE_FX_AUTO_REBALANCE 활성 — KIS 환전 API 통합 대기 중. 수동 환전 필요.`, { component: COMP });
    }
  } catch (e) {
    logger.error(`FX 자문 실패: ${(e as Error).message}`, { component: COMP });
  }
}
