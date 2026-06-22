/**
 * 상관관계 기반 포트폴리오 관리
 * 고상관 종목 그룹 내 동시 보유 제한으로 집중 리스크 방지
 */
import { logger } from '../../utils/logger.js';

// ── 고상관 종목 그룹 (실제 상관계수 기반) ──

const HIGH_CORR_GROUPS: { group: string; codes: string[]; maxHold: number }[] = [
  { group: 'AI_SEMI', codes: ['NVDA', 'AMD', 'AVGO', 'MRVL', 'MU', 'SMCI'], maxHold: 2 },
  { group: 'BIGTECH', codes: ['AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN'], maxHold: 2 },
  { group: 'DEFENSE', codes: ['LMT', 'RTX', 'GEV', 'PLTR', 'GE'], maxHold: 2 }, // GEV/PLTR/GE 추가
  { group: 'EV', codes: ['TSLA'], maxHold: 1 },
  { group: 'CLOUD', codes: ['CRM', 'NOW', 'SNOW', 'ORCL', 'AMZN'], maxHold: 2 },
  { group: 'INFRA', codes: ['ANET', 'VRT', 'ETN', 'PWR'], maxHold: 2 }, // AI 인프라 그룹 추가
  { group: 'TW_SEMI', codes: ['TSM', 'UMC'], maxHold: 1 }, // 대만 반도체 ADR
  { group: 'JP_ADR', codes: ['TM', 'SONY', 'MUFG'], maxHold: 2 }, // 일본 ADR (TSE코드→NYSE ADR)
  { group: 'HEALTH', codes: ['LLY', 'UNH', 'ABBV'], maxHold: 2 },
];

// ── 타입 ──

export interface CorrelationBlock {
  code: string;
  group: string;
  currentCount: number;
  maxAllowed: number;
  reason: string;
}

// ── 메인 ──

/**
 * 매수 필터에서 호출 — 같은 그룹 내 보유 초과 시 차단
 * @param buyCode     매수 대상 종목코드
 * @param currentHoldings  현재 보유 종목 Map (code → holding)
 * @returns 차단 시 CorrelationBlock, 통과 시 null
 */
export function checkCorrelationLimit(buyCode: string, currentHoldings: Map<string, any>): CorrelationBlock | null {
  // buyCode가 속한 그룹 모두 검사
  for (const { group, codes, maxHold } of HIGH_CORR_GROUPS) {
    if (!codes.includes(buyCode)) continue;

    // 같은 그룹 내 이미 보유 중인 종목 수 (buyCode 자체 제외)
    let count = 0;
    const held: string[] = [];
    for (const code of codes) {
      if (code === buyCode) continue;
      if (currentHoldings.has(code)) {
        count++;
        held.push(code);
      }
    }

    if (count >= maxHold) {
      const reason = `[${group}] 그룹 보유 한도 초과 (${count}/${maxHold}): ${held.join(', ')} 보유 중`;
      logger.info(`[Correlation] ${buyCode} 매수 차단 — ${reason}`);
      return {
        code: buyCode,
        group,
        currentCount: count,
        maxAllowed: maxHold,
        reason,
      };
    }
  }

  return null;
}

/**
 * 특정 종목이 속한 그룹 목록 반환 (디버그/로깅용)
 */
export function getGroupsForCode(code: string): string[] {
  return HIGH_CORR_GROUPS.filter((g) => g.codes.includes(code)).map((g) => g.group);
}
