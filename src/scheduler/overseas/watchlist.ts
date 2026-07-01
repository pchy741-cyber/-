/**
 * 글로벌 감시 목록 & 유틸리티
 * Core 23종목 + Extended 16종목 = 39종목 하이브리드 후보군
 */
// ── Core 감시 목록 — 섹터 다각화 (미국 주력 + ADR, 23종목) ──
// 근거: 2025년 리서치 — 방산/산업인프라가 빅테크 대비 초과 수익 (방산 +60~87% vs FAANG +36%)
const CORE_WATCHLIST = [
  // 🤖 AI 반도체·인프라 (핵심 모멘텀 섹터)
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'AMD', name: 'AMD', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'ANET', name: 'Arista Networks', exchange: 'NYSE', region: 'US', sector: 'INFRA' },
  { code: 'VRT', name: 'Vertiv', exchange: 'NYSE', region: 'US', sector: 'INFRA' },
  // 🏛️ 빅테크 선별 (유동성 확보)
  { code: 'META', name: 'Meta', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  { code: 'AAPL', name: 'Apple', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  // 🛡️ 방산·항공우주 (2025 최강 섹터, 글로벌 군비 지출 +9.4% YoY)
  { code: 'RTX', name: 'RTX Corp', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'LMT', name: 'Lockheed Martin', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'GEV', name: 'GE Vernova', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  { code: 'PLTR', name: 'Palantir', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  // 🏭 산업·에너지인프라 (AI 데이터센터 전력 수요 폭증 수혜)
  { code: 'ETN', name: 'Eaton Corp', exchange: 'NYSE', region: 'US', sector: 'INDUSTRIAL' },
  { code: 'PWR', name: 'Quanta Services', exchange: 'NYSE', region: 'US', sector: 'INDUSTRIAL' },
  // ☁️ 클라우드·엔터프라이즈 소프트웨어
  { code: 'AMZN', name: 'Amazon', exchange: 'NASDAQ', region: 'US', sector: 'CLOUD' },
  { code: 'GOOGL', name: 'Alphabet', exchange: 'NASDAQ', region: 'US', sector: 'CLOUD' },
  { code: 'ORCL', name: 'Oracle', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  { code: 'NOW', name: 'ServiceNow', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  { code: 'MELI', name: 'MercadoLibre', exchange: 'NASDAQ', region: 'US', sector: 'GROWTH' },
  { code: 'AVGO', name: 'Broadcom', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  // 🇯🇵 일본 ADR (NYSE 상장 — 미국 세션 거래, 엔화 약세 수혜 수출주)
  { code: 'TM', name: 'Toyota Motor', exchange: 'NYSE', region: 'US', sector: 'JP_AUTO' },
  { code: 'SONY', name: 'Sony Group', exchange: 'NYSE', region: 'US', sector: 'JP_TECH' },
  { code: 'MUFG', name: 'Mitsubishi UFJ', exchange: 'NYSE', region: 'US', sector: 'JP_BANK' },
  // 🇹🇼 대만 ADR (NYSE 상장 — 미국 세션 거래, AI 반도체 공급망 핵심)
  { code: 'TSM', name: 'TSMC', exchange: 'NYSE', region: 'US', sector: 'TW_SEMI' },
  { code: 'UMC', name: 'United Micro', exchange: 'NYSE', region: 'US', sector: 'TW_SEMI' },
];

// ── Extended 감시 목록 — 섹터 다각화 + 모멘텀/볼륨 보조 후보 ──
// 전 섹터 커버리지 확보 → Core에 없는 기회 포착
const EXTENDED_WATCHLIST = [
  // 🤖 AI/반도체 추가
  { code: 'MRVL', name: 'Marvell Tech', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'MU', name: 'Micron', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  { code: 'SMCI', name: 'Super Micro', exchange: 'NASDAQ', region: 'US', sector: 'AI_SEMI' },
  // ☁️ SaaS/클라우드 추가
  { code: 'CRM', name: 'Salesforce', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  { code: 'SNOW', name: 'Snowflake', exchange: 'NYSE', region: 'US', sector: 'CLOUD' },
  // 🏭 인프라/산업 추가
  { code: 'CAT', name: 'Caterpillar', exchange: 'NYSE', region: 'US', sector: 'INDUSTRIAL' },
  { code: 'GE', name: 'GE Aerospace', exchange: 'NYSE', region: 'US', sector: 'DEFENSE' },
  // 💊 헬스케어 (비상관 섹터 다각화)
  { code: 'LLY', name: 'Eli Lilly', exchange: 'NYSE', region: 'US', sector: 'HEALTH' },
  { code: 'UNH', name: 'UnitedHealth', exchange: 'NYSE', region: 'US', sector: 'HEALTH' },
  // 💰 금융 (금리 수혜)
  { code: 'GS', name: 'Goldman Sachs', exchange: 'NYSE', region: 'US', sector: 'FINANCE' },
  { code: 'V', name: 'Visa', exchange: 'NYSE', region: 'US', sector: 'FINANCE' },
  // ⚡ EV/에너지전환
  { code: 'TSLA', name: 'Tesla', exchange: 'NASDAQ', region: 'US', sector: 'EV' },
  // 🎮 엔터테인먼트
  { code: 'NFLX', name: 'Netflix', exchange: 'NASDAQ', region: 'US', sector: 'TECH' },
  // 💊 헬스케어 추가
  { code: 'ABBV', name: 'AbbVie', exchange: 'NYSE', region: 'US', sector: 'HEALTH' },
  // 🇨🇳 중국 ADR (NYSE/NASDAQ 상장 — 실적발표 주가 직결, 고변동성 수익 기회)
  { code: 'BABA', name: 'Alibaba', exchange: 'NYSE', region: 'US', sector: 'CN_ADR' },
  { code: 'JD', name: 'JD.com', exchange: 'NASDAQ', region: 'US', sector: 'CN_ADR' },
  { code: 'PDD', name: 'PDD Holdings', exchange: 'NASDAQ', region: 'US', sector: 'CN_ADR' },
  { code: 'BIDU', name: 'Baidu', exchange: 'NASDAQ', region: 'US', sector: 'CN_ADR' },
  // ⛽ 에너지 (원유·가스 메이저 — 인플레이션 헤지, 고배당)
  { code: 'XOM', name: 'Exxon Mobil', exchange: 'NYSE', region: 'US', sector: 'ENERGY' },
  { code: 'CVX', name: 'Chevron', exchange: 'NYSE', region: 'US', sector: 'ENERGY' },
  // 🏢 REITs (디지털 인프라 — 5G/데이터센터 성장)
  { code: 'AMT', name: 'American Tower', exchange: 'NYSE', region: 'US', sector: 'REIT' },
  // 🛒 필수소비재 (경기방어 — 안정적 매출)
  { code: 'COST', name: 'Costco', exchange: 'NASDAQ', region: 'US', sector: 'CONSUMER' },
  // ⚡ 유틸리티 (클린에너지 — AI 데이터센터 전력 수혜)
  { code: 'NEE', name: 'NextEra Energy', exchange: 'NYSE', region: 'US', sector: 'UTILITY' },
  // 🧬 바이오텍 (mRNA 플랫폼 — 고변동 고수익)
  { code: 'MRNA', name: 'Moderna', exchange: 'NASDAQ', region: 'US', sector: 'BIOTECH' },
  // 🪙 크립토 (암호화폐 시장 프록시)
  { code: 'COIN', name: 'Coinbase', exchange: 'NASDAQ', region: 'US', sector: 'CRYPTO' },
  // 💳 핀테크 (디지털 결제 성장)
  { code: 'PYPL', name: 'PayPal', exchange: 'NASDAQ', region: 'US', sector: 'FINTECH' },
  { code: 'SQ', name: 'Block Inc', exchange: 'NYSE', region: 'US', sector: 'FINTECH' },
  // 🇯🇵 일본 ADR 추가 (3500조엔 경제부흥 투자 수혜 — 인프라·금융·제조)
  { code: 'SMFG', name: 'Sumitomo Mitsui', exchange: 'NYSE', region: 'US', sector: 'JP_BANK' },
  { code: 'HMC', name: 'Honda Motor', exchange: 'NYSE', region: 'US', sector: 'JP_AUTO' },
  { code: 'NMR', name: 'Nomura Holdings', exchange: 'NYSE', region: 'US', sector: 'JP_FINANCE' },
];

// ── 통합 감시 목록 (Core 24 + Extended 30 = 54종목, 전 섹터 커버) ──
// 모든 코드에서 GLOBAL_WATCHLIST를 사용 → 기존 호환성 유지
export const GLOBAL_WATCHLIST = [...CORE_WATCHLIST, ...EXTENDED_WATCHLIST];

// ── O(1) 조회용 Map 인덱스 (GLOBAL_WATCHLIST.find() 대체) ──
// code → WatchlistItem (동일 code 여러 거래소면 첫 번째 우선)
export const WATCHLIST_BY_CODE = new Map(GLOBAL_WATCHLIST.map((w) => [w.code, w]));
// "code:exchange" → WatchlistItem (거래소 특정 조회)
export const WATCHLIST_BY_CODE_EXCHANGE = new Map(
  GLOBAL_WATCHLIST.map((w) => [`${w.code}:${w.exchange}`, w]),
);

// 포지션 한도: getOverseasDynamic(portfolioUsd) 동적 함수 사용 (constants.ts)

/** try-catch 래퍼 — 실패 시 null 반환, 오류 무시 */
export async function safely<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export function resolveOverseasStockName(code: string, exchange: string): string {
  return (
    WATCHLIST_BY_CODE_EXCHANGE.get(`${code}:${exchange}`)?.name ??
    WATCHLIST_BY_CODE.get(code)?.name ??
    code
  );
}
