// ═══════════════════════════════════════
// 공유 헬퍼 함수 — 종목명 파싱, AI 사유 요약
// ═══════════════════════════════════════

import { getKnownStockName } from './stock-names';

const PENDING_STOCK_NAME_REGEX = /^(?:종목(?:명)?확인중|확인중)$/;

// 특수문자(◆ 등) 포함 여부로 종목명 깨짐 감지
export function isGarbledName(name: string): boolean {
  if (!name) return true;
  return /[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$]/.test(name);
}

export function isPendingStockName(name: string): boolean {
  const compact = name.replace(/\s+/g, '');
  return PENDING_STOCK_NAME_REGEX.test(compact);
}

export function isUnresolvedStockName(name: string, code?: string): boolean {
  if (!name) return true;
  if (isPendingStockName(name)) return true;
  return !!code && name === code;
}

export function toDisplayName(name: unknown, code?: string): string {
  const n = String(name ?? '').trim();
  const known = getKnownStockName(code);
  if (!n || isPendingStockName(n)) return known ?? (code ? String(code) : '종목명 확인중');
  if (code && n === code) return known ?? String(code);
  if (/^[0-9]{6}$/.test(n)) return known ?? n;
  if (isGarbledName(n)) return known ?? (code ? String(code) : n);
  return n;
}

/** confirm 다이얼로그 제목 접두사 — 실전/연습 모드 구분 */
export function livePrefix(viewMode: 'live' | 'paper'): string {
  return viewMode === 'live' ? '⚠️ [실전모드] ' : '[연습모드] ';
}

export function simplifyReason(reason: string | null | undefined, side: string): string {
  if (!reason) return side === 'BUY' ? '매수' : '매도';
  if (reason.includes('15:20') || reason.includes('강제 청산')) return '마감 청산';
  if (reason.includes('손절') || reason.toLowerCase().includes('stop_loss')) return '손절 매도';
  if (reason.match(/익절\([+-]?[\d.]+%\)/)) return '익절 매도';
  if (reason.match(/손절\([+-]?[\d.]+%\)/)) return '손절 매도';
  if ((reason.includes('수익') || reason.includes('익절')) && reason.includes('매도')) return '익절 매도';
  if (reason.includes('목표가')) return '목표가 도달';
  if (reason.includes('AI 스코어') || reason.includes('기술적 매수')) return 'AI 매수 신호';
  if (reason.includes('물타기') || reason.includes('추가 매수') || reason.includes('AVERAGE')) return '추가 매수';
  if (reason.includes('분할 매도') || reason.includes('PROFIT_TAKING')) return '분할 익절';
  if (reason.includes('CEO') || reason.includes('수동')) return '수동 매도';
  if (reason.includes('🚀') || reason.includes('모멘텀')) return side === 'BUY' ? 'AI 매수 신호' : '모멘텀 매도';
  if (reason.includes('📉') || reason.includes('반등')) return side === 'BUY' ? '반등 매수' : '반등 매도';
  if (reason.includes('저점') || reason.includes('기술적')) return side === 'BUY' ? '기술적 매수' : '기술 매도';
  return reason.length > 15 ? reason.slice(0, 15) + '…' : reason;
}
