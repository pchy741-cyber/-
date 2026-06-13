export const CRITERIA: Record<string, { trades: number; wr: number; pf: number; mdd: number }> = {
  BREAKOUT: { trades: 20, wr: 0.50, pf: 1.3, mdd: -20 },
  DEFAULT: { trades: 30, wr: 0.55, pf: 1.5, mdd: -15 },
};

export const SIM_AMOUNTS = [1000, 3000, 5000, 10000];

export const STRATEGY_LABELS: Record<string, string> = {
  SWING: '스윙', BREAKOUT: '돌파', SCALPING: '스캘핑', SNIPER: '스나이퍼',
  EOD_BETTING: '장마감', BOTTOM_FISHING: '저점매수', DEFENSE: '방어', DIVIDEND: '배당',
  PULLBACK: '눌림', PARKING: '파킹',
};

/** trigger_source 한글 라벨 */
export const TRIGGER_LABELS: Record<string, string> = {
  TRACK_B: 'AI 추적', CLAUDE: 'Claude', GEMINI: 'Gemini',
  OVERSEAS: '해외', MANUAL: '수동', EXTERNAL: '외부신호',
  SNIPER: '스나이퍼', OPENING_BELL: '장시작', AFTER_HOURS: '시간외',
  CASH_PARKING: '파킹', EOD_BLUECHIP: '장마감',
};

export const STRATEGY_ICONS: Record<string, string> = {
  SWING: '〰', BREAKOUT: '⚡', SCALPING: '⏱', SNIPER: '◎',
  EOD_BETTING: '🌅', BOTTOM_FISHING: '⬇', DEFENSE: '🛡', DIVIDEND: '💰',
  PULLBACK: '↘', PARKING: '🅿',
};

export const GRAD_STEPS = [
  { key: 'paper', label: 'Paper', sub: '검증 중' },
  { key: 'testing', label: 'Testing', sub: '승인 대기' },
  { key: 'live', label: 'Live', sub: '실전 적용' },
] as const;
