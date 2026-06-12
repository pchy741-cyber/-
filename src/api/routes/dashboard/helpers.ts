/**
 * 대시보드 공통 헬퍼 — 종목명, 환율, 캐시 관리
 */

// ── 환율 캐시 (1시간 TTL, 실패 시 1420 폴백) ──
let _fxCache = { rate: 1420, fetchedAt: 0 };

const GARBLED_NAME_REGEX = /[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$]/;
const PENDING_STOCK_NAME_REGEX = /^(?:종목(?:명)?확인중|확인중)$/;

export const KNOWN_GLOBAL_STOCK_NAMES: Record<string, string> = {
  AAPL: 'Apple',
  NVDA: 'NVIDIA',
  MSFT: 'Microsoft',
  GOOGL: 'Google',
  AMZN: 'Amazon',
  ORCL: 'Oracle',
  NOW: 'ServiceNow',
  META: 'Meta',
  '7203': 'Toyota',
  '6758': 'Sony',
  '6861': 'Keyence',
  '2330': 'TSMC',
  '2317': 'Foxconn',
  '2454': 'MediaTek',
};

export const KNOWN_KR_STOCK_NAMES: Record<string, string> = {
  '000100': '유한양행',
  '000660': 'SK하이닉스',
  '000720': '현대건설',
  '001040': 'CJ',
  '003670': '포스코퓨처엠',
  '005290': '동진쎄미켐',
  '005380': '현대자동차',
  '005490': 'POSCO홀딩스',
  '005930': '삼성전자',
  '006400': '삼성SDI',
  '009150': '삼성전기',
  '009540': 'HD한국조선해양',
  '010130': '고려아연',
  '010950': 'S-Oil',
  '012450': '한화에어로스페이스',
  '017670': 'SK텔레콤',
  '018260': '삼성에스디에스',
  '028300': 'HLB',
  '030200': 'KT',
  '032830': '삼성생명',
  '034020': '두산에너빌리티',
  '034730': 'SK',
  '035420': 'NAVER',
  '035720': '카카오',
  '036490': 'SK머티리얼즈',
  '042700': '한미반도체',
  '051910': 'LG화학',
  '055550': '신한지주',
  '058470': '리노공업',
  '066570': 'LG전자',
  '068270': '셀트리온',
  '079550': 'LIG넥스원',
  '086520': '에코프로',
  '105560': 'KB금융',
  '112040': '위메이드',
  '114800': 'KODEX 인버스',
  '161510': 'ARIRANG 단기채권액티브',
  '196170': '알테오젠',
  '207940': '삼성바이오로직스',
  '214150': '클래시스',
  '247540': '에코프로비엠',
  '251340': 'TIGER 200선물인버스2X',
  '252670': 'KODEX 200선물인버스2X',
  '263750': '펄어비스',
  '267260': 'HD현대일렉트릭',
  '277810': '레인보우로보틱스',
  '316140': '우리금융지주',
  '328130': '루닛',
  '333940': 'KODEX 단기채권PLUS',
  '336260': '두산퓨얼셀',
  '336370': '솔루스첨단소재',
  '357780': '솔브레인',
  '373220': 'LG에너지솔루션',
  '377300': '카카오페이',
  '383220': 'F&F',
  '403870': 'HPSP',
  '454910': '두산로보틱스',
};

export function isInvalidStockName(name: unknown, stockCode?: string): boolean {
  const n = String(name ?? '').trim();
  const compact = n.replace(/\s+/g, '');
  if (!n) return true;
  if (PENDING_STOCK_NAME_REGEX.test(compact)) return true;
  if (stockCode && n === stockCode) return true;
  if (/^[0-9]{6}$/.test(n)) return true;
  return GARBLED_NAME_REGEX.test(n);
}

export function getKnownStockName(code: string): string | undefined {
  return KNOWN_GLOBAL_STOCK_NAMES[code] ?? KNOWN_KR_STOCK_NAMES[code];
}

export async function getFxRate(): Promise<number> {
  const now = Date.now();
  if (now - _fxCache.fetchedAt < 60 * 60 * 1000) return _fxCache.rate;
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(2000) });
    const data = (await resp.json()) as any;
    const krw = data?.rates?.KRW;
    if (krw && krw > 1000 && krw < 2000) {
      _fxCache = { rate: Math.round(krw), fetchedAt: now };
    }
  } catch {
    /* 폴백 유지 */
  }
  return _fxCache.rate;
}

// ── 대시보드 캐시 — src/cache/dashboard-cache.ts 에서 re-export (의존방향 수정) ──
export {
  getDashBuildingByMode,
  getDashCache,
  getDashCacheTTL,
  hardInvalidateDashboardCache,
  hardInvalidateMode,
  invalidateCurrentModeCache,
  invalidateDashboardCache,
  invalidateModeCache,
  setDashCache,
} from '../../../cache/dashboard-cache.js';
