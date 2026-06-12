import { logger } from '../utils/logger.js';

let _webhookUrl = '';

export function initSlack(webhookUrl: string): void {
  _webhookUrl = webhookUrl;
  logger.info('💬 Slack webhook 초기화', { component: 'SLACK' });
}

/**
 * Slack Incoming Webhook 메시지 전송
 * level: 'info'=회색, 'warn'=노랑, 'error'=빨강
 */
export async function sendSlackMessage(text: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  if (!_webhookUrl) return;
  const colorMap = { info: '#36a64f', warn: '#ffc107', error: '#e53935' };
  const payload = {
    attachments: [
      {
        color: colorMap[level],
        text,
        ts: Math.floor(Date.now() / 1000).toString(),
      },
    ],
  };
  try {
    const res = await fetch(_webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn(`Slack 전송 실패: HTTP ${res.status}`, { component: 'SLACK' });
    }
  } catch (err) {
    logger.warn(`Slack 전송 오류: ${err}`, { component: 'SLACK' });
  }
}
