/**
 * 이메일 알림 서비스 — nodemailer SMTP
 * 패턴: slack.ts와 동일 (init → send, 설정 없으면 no-op)
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '../utils/logger.js';

let transporter: Transporter | null = null;
let _defaultTo = '';

interface EmailConfig {
  to: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
}

/**
 * SMTP transporter 초기화 — smtpUser 미설정 시 no-op
 */
export function initEmail(cfg: EmailConfig): void {
  if (!cfg.smtpUser || !cfg.smtpPass) {
    logger.info('📧 Email SMTP 미설정 → 이메일 알림 비활성', { component: 'EMAIL' });
    return;
  }

  _defaultTo = cfg.to;

  // smtpHost 미설정 시 smtpUser 도메인 기반 자동 감지
  const host = cfg.smtpHost || detectSmtpHost(cfg.smtpUser);
  const port = cfg.smtpPort || 587;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPass,
    },
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });

  logger.info(`📧 Email 초기화 완료 (${cfg.smtpUser} → ${_defaultTo})`, { component: 'EMAIL' });
}

/** 도메인 기반 SMTP 호스트 자동 감지 */
function detectSmtpHost(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (domain.includes('gmail')) return 'smtp.gmail.com';
  if (domain.includes('naver')) return 'smtp.naver.com';
  if (domain.includes('daum') || domain.includes('kakao')) return 'smtp.daum.net';
  // 커스텀 도메인 → smtp.도메인 시도
  return `smtp.${domain}`;
}

/**
 * HTML 이메일 발송 — 에러 시 로그만 (throw 안 함)
 */
export async function sendEmail({
  to,
  subject,
  html,
}: {
  to?: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  if (!transporter) return false;

  const recipient = to || _defaultTo;
  if (!recipient) {
    logger.warn('이메일 수신자 미설정', { component: 'EMAIL' });
    return false;
  }

  try {
    await transporter.sendMail({
      from: transporter.options && 'auth' in transporter.options
        ? (transporter.options.auth as Record<string, string>)?.user
        : undefined,
      to: recipient,
      subject,
      html,
    });
    logger.info(`📧 이메일 발송: ${subject}`, { component: 'EMAIL' });
    return true;
  } catch (err) {
    logger.error(`📧 이메일 발송 실패: ${err}`, { component: 'EMAIL' });
    return false;
  }
}

/**
 * HTML 특수문자 이스케이프 — XSS 방지
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 긴급 알림 이메일 — config.email.to로 발송
 */
export async function sendAlertEmail({
  subject,
  html,
}: {
  subject: string;
  html: string;
}): Promise<boolean> {
  return sendEmail({ subject, html });
}
