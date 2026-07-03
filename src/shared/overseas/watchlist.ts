/**
 * 글로벌 감시 목록 & 유틸리티 — scheduler/overseas/watchlist.ts에서 추출
 * Core 23종목 + Extended 30종목 = 53종목 하이브리드 후보군
 */
// ── Core 감시 목록 — 섹터 다각화 (미국 주력 + ADR, 23종목) ──
export const CORE_WATCHLIST = [
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'AMD', name: 'AMD', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'ANET', name: 'Arista Networks', exchange: 'NYSE', region: 'US', sector: 'INFRA' },
  { code: 'VRT', name: 'Vertiv', exchange: 'NYSE', region: 'US', sector: 'INFRA' },
  { code: 'META', name: 'Meta', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  { code: 'AAPL', name: 'Apple', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  { code: 'RTX', name: 'RTX Corp', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'LMT', name: 'Lockheed Martin', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'GEV', name: 'GE Vernova', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'PLTR', name: 'Palantir', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'ETN', name: 'Eaton Corp', exchange: 'NYSE', region: 'US', sector: 'INDUSTRIAL' },
  { code: 'PWR', name: 'Quanta Services', exchange: 'NYSE', region: 'US', sector: 'INDUSTRIAL' },
  { code: 'AMZN', name: 'Amazon', exchange: 'NASDAQ', region: 'US', sector: 'CLOUD' },
  { code: 'GOOGL', name: 'Alphabet', exchange: 'NASDAQ', region: 'US', sector: 'CLOUD' },
  { code: 'ORCL', name: 'Oracle', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  { code: 'NOW', name: 'ServiceNow', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  { code: 'MELI', name: 'MercadoLibre', exchange: 'NASDAQ', region: 'US', sector: 'GROWTH' },
  { code: 'AVGO', name: 'Broadcom', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'TM', name: 'Toyota Motor', exchange: 'NYSE', region: 'US', sector: 'JP_AUTO' },
  { code: 'SONY', name: 'Sony Group', exchange: 'NYSE', region: 'US', sector: 'JP_TECH' },
  { code: 'MUFG', name: 'Mitsubishi UFJ', exchange: 'NYSE', region: 'US', sector: 'JP_BANK' },
  { code: 'TSM', name: 'TSMC', exchange: 'NYSE', region: 'US', sector: 'TW_SEMI' },
  { code: 'UMC', name: 'United Micro', exchange: 'NYSE', region: 'US', sector: 'TW_SEMI' },
];

export const EXTENDED_WATCHLIST = [
  { code: 'MRVL', name: 'Marvell Tech', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'MU', name: 'Micron', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'SMCI', name: 'Super Micro', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'CRM', name: 'Salesforce', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  { code: 'SNOW', name: 'Snowflake', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  { code: 'CAT', name: 'Caterpillar', exchange: 'NYSE', region: 'US', sector: 'INDUSTRIAL' },
  { code: 'GE', name: 'GE Aerospace', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'LLY', name: 'Eli Lilly', exchange: 'NYSE', region: 'US', sector: 'HEALTH' },
  { code: 'UNH', name: 'UnitedHealth', exchange: 'NYSE', region: 'US', sector: 'HEALTH' },
  { code: 'GS', name: 'Goldman Sachs', exchange: 'NYSE', region: 'US', sector: 'FINANCE' },
  { code: 'V', name: 'Visa', exchange: 'NYSE', region: 'US', sector: 'FINANCE' },
  { code: 'TSLA', name: 'Tesla', exchange: 'NASDAQ', region: 'US', sector: 'EV' },
  { code: 'NFLX', name: 'Netflix', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  { code: 'ABBV', name: 'AbbVie', exchange: 'NYSE', region: 'US', sector: 'HEALTH' },
  { code: 'BABA', name: 'Alibaba', exchange: 'NYSE', region: 'US', sector: 'CN_ADR' },
  { code: 'JD', name: 'JD.com', exchange: 'NASDAQ', region: 'US', sector: 'CN_ADR' },
  { code: 'PDD', name: 'PDD Holdings', exchange: 'NASDAQ', region: 'US', sector: 'CN_ADR' },
  { code: 'BIDU', name: 'Baidu', exchange: 'NASDAQ', region: 'US', sector: 'CN_ADR' },
  { code: 'XOM', name: 'Exxon Mobil', exchange: 'NYSE', region: 'US', sector: 'ENERGY' },
  { code: 'CVX', name: 'Chevron', exchange: 'NYSE', region: 'US', sector: 'ENERGY' },
  { code: 'AMT', name: 'American Tower', exchange: 'NYSE', region: 'US', sector: 'REIT' },
  { code: 'COST', name: 'Costco', exchange: 'NASDAQ', region: 'US', sector: 'CONSUMER' },
  { code: 'NEE', name: 'NextEra Energy', exchange: 'NYSE', region: 'US', sector: 'UTILITY' },
  { code: 'MRNA', name: 'Moderna', exchange: 'NASDAQ', region: 'US', sector: 'BIOTECH' },
  { code: 'VRTX', name: 'Vertex Pharma', exchange: 'NASDAQ', region: 'US', sector: 'BIOTECH' },
  { code: 'CRSP', name: 'CRISPR Therapeutics', exchange: 'NASDAQ', region: 'US', sector: 'BIOTECH' },
  { code: 'COIN', name: 'Coinbase', exchange: 'NASDAQ', region: 'US', sector: 'CRYPTO' },
  { code: 'PYPL', name: 'PayPal', exchange: 'NASDAQ', region: 'US', sector: 'FINTECH' },
  { code: 'SQ', name: 'Block Inc', exchange: 'NYSE', region: 'US', sector: 'FINTECH' },
  { code: 'SMFG', name: 'Sumitomo Mitsui', exchange: 'NYSE', region: 'US', sector: 'JP_BANK' },
  { code: 'HMC', name: 'Honda Motor', exchange: 'NYSE', region: 'US', sector: 'JP_AUTO' },
  { code: 'NMR', name: 'Nomura Holdings', exchange: 'NYSE', region: 'US', sector: 'JP_FINANCE' },
];

// ── 레버리지/인버스 ETF (3x Bull/Bear + VIX) ──
export const LEVERAGED_WATCHLIST = [
  // 3x Bull
  { code: 'TQQQ', name: 'ProShares UltraPro QQQ', exchange: 'NASDAQ', region: 'US', sector: 'LEV_BULL' },
  { code: 'SOXL', name: 'Direxion Semi Bull 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BULL' },
  { code: 'UPRO', name: 'ProShares UltraPro S&P500', exchange: 'AMEX', region: 'US', sector: 'LEV_BULL' },
  { code: 'FNGU', name: 'MicroSectors FANG+ 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BULL' },
  { code: 'TNA', name: 'Direxion SmallCap Bull 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BULL' },
  { code: 'LABU', name: 'Direxion Biotech Bull 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BULL' },
  // 2x Bull
  { code: 'QLD', name: 'ProShares Ultra QQQ', exchange: 'NASDAQ', region: 'US', sector: 'LEV_BULL' },
  // 3x Bear (인버스)
  { code: 'SQQQ', name: 'ProShares UltraPro Short QQQ', exchange: 'NASDAQ', region: 'US', sector: 'LEV_BEAR' },
  { code: 'SOXS', name: 'Direxion Semi Bear 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BEAR' },
  { code: 'SPXS', name: 'Direxion S&P500 Bear 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BEAR' },
  { code: 'FNGD', name: 'MicroSectors FANG+ -3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BEAR' },
  { code: 'TZA', name: 'Direxion SmallCap Bear 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BEAR' },
  { code: 'LABD', name: 'Direxion Biotech Bear 3X', exchange: 'AMEX', region: 'US', sector: 'LEV_BEAR' },
  // 2x Bear (인버스)
  { code: 'QID', name: 'ProShares UltraShort QQQ', exchange: 'NASDAQ', region: 'US', sector: 'LEV_BEAR' },
  // VIX
  { code: 'UVXY', name: 'ProShares Ultra VIX', exchange: 'AMEX', region: 'US', sector: 'LEV_BEAR' },
];

export const GLOBAL_WATCHLIST = [...CORE_WATCHLIST, ...EXTENDED_WATCHLIST, ...LEVERAGED_WATCHLIST];

export const WATCHLIST_BY_CODE = new Map(GLOBAL_WATCHLIST.map((w) => [w.code, w]));
export const WATCHLIST_BY_CODE_EXCHANGE = new Map(
  GLOBAL_WATCHLIST.map((w) => [`${w.code}:${w.exchange}`, w]),
);
