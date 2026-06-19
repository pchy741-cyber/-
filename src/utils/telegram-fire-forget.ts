/**
 * 텔레그램 fire-and-forget — sendTelegramMessage().catch(() => {}) 패턴 대체
 */
import { sendTelegramMessage } from '../notifications/telegram.js';

export function notifyTelegram(msg: string): void {
  sendTelegramMessage(msg).catch(() => {});
}
