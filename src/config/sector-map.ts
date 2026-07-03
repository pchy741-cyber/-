// ── 섹터 분류 (매수/매도/트레일링 전역 공유) ──
export const SECTOR_CLASS = {
  HIGH_BETA: ['EV', 'CRYPTO', 'AI_SEMI', 'GROWTH', 'BIOTECH'] as readonly string[],
  MEDIUM_BETA: [
    'TECH', 'INFRA', 'INDUSTRIAL', 'CLOUD', 'HEALTH', 'FINANCE', 'FINTECH',
    'ENERGY', 'JP_AUTO', 'JP_TECH', 'JP_BANK', 'JP_FINANCE', 'TW_SEMI', 'CN_ADR',
  ] as readonly string[],
  DEFENSE: ['DEFENSE', 'REIT', 'CONSUMER', 'UTILITY'] as readonly string[],
  DANGER_HIGH_BETA: ['AI_SEMI', 'GROWTH', 'EV', 'CRYPTO', 'BIOTECH', 'FINTECH', 'JP_AUTO', 'JP_TECH', 'CN_ADR'] as readonly string[],
} as const;

// ── 국내주식 섹터 맵 (Single Source of Truth) ──
export const SECTOR_MAP_KR: Readonly<Record<string, string>> = {
  '000660': '반도체', '005930': '반도체', '042700': '반도체',
  '005290': '반도체', '357780': '반도체', '403870': '반도체',
  '051910': '배터리', '006400': '배터리', '247540': '배터리',
  '373220': '배터리', '336260': '배터리', '003670': '배터리',
  '012450': '방산', '079550': '방산', '034020': '방산',
  '035420': '인터넷', '035720': '인터넷', '377300': '인터넷',
  '207940': '바이오', '068270': '바이오', '328130': '바이오',
  '196170': '바이오', '028300': '바이오',
  '055550': '금융', '105560': '금융', '316140': '금융',
  '267260': '전력', '009540': '조선', '066570': '가전',
};
