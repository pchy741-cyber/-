import { describe, expect, it, vi } from 'vitest';

// DB/config를 로드하는 의존성 mock — isHardBlocked 순수 로직만 격리 검증
vi.mock('../../../automation/community-sentinel.js', () => ({ isCommunityPumpBlocked: () => false }));
vi.mock('../../ai-overrides.js', () => ({ getOverride: () => undefined }));
vi.mock('../sell-cooldown.js', () => ({ isDailyStopLossBlocked: () => false }));
vi.mock('../trading-rules.js', () => ({
  BUY_BLOCKED_CODES: new Set<string>(),
  MEGA_CAP_PRIORITY_CODES: new Set<string>(['005930']),
}));
vi.mock('../../../utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { isHardBlocked } = await import('./hard-gates.js');
type HardGateInput = Parameters<typeof isHardBlocked>[0];

// v29 ① 완료기준: 14일 내 2회 손절 종목 매수 시도 → 차단 (스마트재진입 폐지 검증)
function baseInput(overrides: Partial<HardGateInput> = {}): HardGateInput {
  return {
    stock: { stock_code: '006340', stock_name: '대원전선' },
    openStockCodes: new Set<string>(),
    livePrices: new Map(),
    aiScoreMap: new Map(),
    tradingValues: new Map([['006340', 500_0000_0000]]), // 500억 = 유동성 통과
    ...overrides,
  } as HardGateInput;
}

describe('hard-gates v29 ① 반복손절 하드차단 (스마트재진입 폐지)', () => {
  it('14일 내 2회 손절 종목(repeatLoserCodes) → 매수 차단', () => {
    expect(isHardBlocked(baseInput({ repeatLoserCodes: new Set(['006340']) }))).toBe(true);
  });

  it('메가캡/주도주여도 반복손절이면 차단 (v29 우량주 면제 제거)', () => {
    const input = baseInput({
      stock: { stock_code: '005930', stock_name: '삼성전자' } as HardGateInput['stock'],
      repeatLoserCodes: new Set(['005930']),
      tradingValues: new Map([['005930', 5000_0000_0000]]),
    });
    expect(isHardBlocked(input)).toBe(true);
  });

  it('손실 이력(lossHistory) 종목 → 스마트재진입 없이 하드차단', () => {
    expect(isHardBlocked(baseInput({ lossHistory: new Map([['006340', { lossPct: -3.5 } as never]]) }))).toBe(true);
  });

  it('매도 후 쿨다운(recentlySoldCodes) → 고AI여도 4h 하드차단 (바이패스 없음)', () => {
    const input = baseInput({ recentlySoldCodes: new Set(['006340']), aiScoreMap: new Map([['006340', 95]]) });
    expect(isHardBlocked(input)).toBe(true);
  });

  it('손실이력 없고 반복손절 아니면 통과 (오탐 없음)', () => {
    expect(isHardBlocked(baseInput())).toBe(false);
  });
});
