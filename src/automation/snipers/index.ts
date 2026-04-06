/**
 * 🎯 Opportunity Sniper — "거의 확실한" 고수익 타이밍 자동 포착
 *
 * 주식 좀 아는 사람들이 알고 있는 90~100% 확률의 수익 포인트:
 *
 * 1. 기관+외국인 동시 순매수 5일 연속 (수급 확정)
 * 2. 실적 서프라이즈 (어닝 비트) 직후
 * 3. 자사주 매입 공시 (CEO가 자기 주식을 사는데 안 오를 리가 없다)
 * 4. 대규모 수주 공시 (매출 확정)
 * 5. 프로그램 매수 폭탄 (기관이 무차별 매수)
 * 6. 눌림목 반등 (고점 대비 -10~15% 하락 + 거래량 터지며 양봉)
 * 7. 골든크로스 + 거래량 동반 (5일선이 20일선 상향 돌파)
 *
 * 발견 시: 일반 스윙보다 높은 비중(최대 1.5배)으로 자동 진입
 * + CEO에게 Telegram 즉시 알림
 */

import { logSystem } from '../../db/client.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';

export interface SniperSignal {
  stockCode: string;
  stockName: string;
  type: SniperType;
  confidence: number; // 0.0 ~ 1.0
  budgetMultiplier: number; // 일반 대비 투자 배수 (1.0 ~ 1.5)
  reasoning: string;
  detectedAt: string;
}

export type SniperType =
  | 'INSTITUTIONAL_SURGE' // 기관+외국인 동시 순매수 (e.g., 5일 연속, 거래량 동반 시 confidence 0.9)
  | 'EARNINGS_BEAT' // 실적 서프라이즈 (e.g., 컨센서스 20% 상회 시 confidence 0.95)
  | 'BUYBACK' // 자사주 매입 공시 (e.g., 발행 주식 수 대비 1% 이상 시 confidence 0.85)
  | 'MEGA_CONTRACT' // 대규모 수주/계약 공시 (e.g., 전년 매출 10% 이상 시 confidence 0.9)
  | 'PROGRAM_BUY_BOMB' // 프로그램 매수 폭탄 (e.g., 시총 대비 n% 이상 유입 시 confidence 0.8)
  | 'PULLBACK_BOUNCE' // 눌림목 반등 (e.g., 고점 대비 -15% 하락 후 거래량 실린 양봉 출현 시 confidence 0.75)
  | 'GOLDEN_CROSS_VOLUME'; // 골든크로스 + 거래량 (e.g., 5-20일선 골든크로스 + 평소 거래량 300% 이상 시 confidence 0.8)

// 감지된 시그널 캐시 (중복 알림 방지 + 자동 정리)
const recentSignals = new Map<string, Date>();
const SIGNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000;

function cleanupExpiredSignals() {
  const now = Date.now();
  for (const [key, date] of recentSignals) {
    if (now - date.getTime() > SIGNAL_COOLDOWN_MS * 2) {
      recentSignals.delete(key);
    }
  }
}

export async function emitSniperSignal(signal: SniperSignal): Promise<void> {
  cleanupExpiredSignals(); // 메모리 릭 방지

  const key = `${signal.stockCode}:${signal.type}`;
  const lastEmit = recentSignals.get(key);
  if (lastEmit && Date.now() - lastEmit.getTime() < SIGNAL_COOLDOWN_MS) return;

  recentSignals.set(key, new Date());

  const emoji = getTypeEmoji(signal.type);
  const typeName = getTypeName(signal.type);

  logger.warn(`🎯 SNIPER: ${signal.stockName} [${typeName}] 신뢰도 ${(signal.confidence * 100).toFixed(0)}%`, {
    component: 'SNIPER',
  });

  await logSystem('TRADE', 'SNIPER', `${typeName}: ${signal.stockName} (${signal.stockCode}) — ${signal.reasoning}`, {
    signal,
  });

  await sendTelegramMessage(
    `${emoji} *고확률 기회 포착!*\n\n` +
      `종목: *${signal.stockName}* (${signal.stockCode})\n` +
      `유형: ${typeName}\n` +
      `신뢰도: ${(signal.confidence * 100).toFixed(0)}%\n` +
      `투자 배수: x${signal.budgetMultiplier.toFixed(1)}\n\n` +
      `근거: ${signal.reasoning}\n\n` +
      `자동 매수 진행 예정 (10분 내)`,
  );
}

function getTypeEmoji(type: SniperType): string {
  const map: Record<SniperType, string> = {
    INSTITUTIONAL_SURGE: '🏦',
    EARNINGS_BEAT: '📊',
    BUYBACK: '💎',
    MEGA_CONTRACT: '📝',
    PROGRAM_BUY_BOMB: '🚀',
    PULLBACK_BOUNCE: '🔄',
    GOLDEN_CROSS_VOLUME: '✨',
  };
  return map[type];
}

function getTypeName(type: SniperType): string {
  const map: Record<SniperType, string> = {
    INSTITUTIONAL_SURGE: '기관+외국인 동시 순매수',
    EARNINGS_BEAT: '실적 서프라이즈',
    BUYBACK: '자사주 매입 공시',
    MEGA_CONTRACT: '대규모 수주 공시',
    PROGRAM_BUY_BOMB: '프로그램 매수 폭탄',
    PULLBACK_BOUNCE: '눌림목 반등 시그널',
    GOLDEN_CROSS_VOLUME: '골든크로스 + 거래량',
  };
  return map[type];
}
