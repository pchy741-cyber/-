/**
 * 📣 모드별 알림 헬퍼 — Telegram 메시지에 실전/연습 컬러 구분 강제
 *
 * CEO 지시 (2026-06-12): "알림도 실전인지 연습인지 컬러 구분이 있으면 더 인지하기 좋을듯"
 *
 * Telegram은 텍스트 기반이라 직접 색상 안 됨 → 이모지+볼드로 강한 시각 구분
 *
 * 규약:
 *   🔴 [실전] = Live 매매 (위험 + 진짜 돈)
 *   🟡 [연습] = Paper 매매 (학습용, 안전)
 *   🔵 [정보] = 모드 무관 시스템 알림
 *
 * 사용:
 *   sendModeMessage('live', '매수 완료: 005930');
 *   → "🔴 *[실전]* 매수 완료: 005930"
 */

import { sendTelegramMessage } from './telegram.js';

export type AlertMode = 'paper' | 'live' | 'system';

const MODE_PREFIX: Record<AlertMode, string> = {
  live: '🔴 *[실전]*',
  paper: '🟡 *[연습]*',
  system: '🔵 *[시스템]*',
};

/**
 * 모드별 prefix가 자동 부착된 Telegram 알림
 */
export async function sendModeMessage(mode: AlertMode, message: string): Promise<void> {
  const prefix = MODE_PREFIX[mode];
  // 이미 prefix가 있으면 중복 방지
  if (message.includes('[실전]') || message.includes('[연습]') || message.includes('[시스템]')) {
    return sendTelegramMessage(message).catch(() => {});
  }
  const formatted = `${prefix}\n${message}`;
  return sendTelegramMessage(formatted).catch(() => {});
}

/** isPaper boolean → 모드 변환 */
export async function sendByPaperFlag(isPaper: boolean, message: string): Promise<void> {
  return sendModeMessage(isPaper ? 'paper' : 'live', message);
}

// v10.11.4: sendTradeAlert, sendAlert 삭제 (미사용 — sendModeMessage/sendByPaperFlag만 활성)
