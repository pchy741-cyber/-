// ═══════════════════════════════════════
// 종목명 매핑 — 해외 종목 폴백용
// 국내 종목명은 서버 응답(stock_name)을 우선 사용
// ═══════════════════════════════════════

export const KNOWN_STOCK_NAMES: Record<string, string> = {
  // 해외
  AAPL: 'Apple', NVDA: 'NVIDIA', MSFT: 'Microsoft', GOOGL: 'Google',
  AMZN: 'Amazon', TSLA: 'Tesla', META: 'Meta',
  AMD: 'AMD', AVGO: 'Broadcom', QCOM: 'Qualcomm',
  TSM: 'TSMC', INTC: 'Intel', MU: 'Micron',
  VOO: 'S&P500 ETF', SCHD: '배당 ETF', QQQ: 'NASDAQ ETF',
  // 국내 (서버 응답 없을 때 폴백)
  '005930': '삼성전자', '000660': 'SK하이닉스', '005380': '현대자동차',
  '005490': 'POSCO홀딩스', '035420': 'NAVER', '035720': '카카오',
  '006400': '삼성SDI', '051910': 'LG화학', '373220': 'LG에너지솔루션',
  '068270': '셀트리온', '207940': '삼성바이오로직스', '196170': '알테오젠',
  '012450': '한화에어로스페이스', '267260': 'HD현대일렉트릭',
  '042700': '한미반도체', '009150': '삼성전기', '028300': 'HLB',
  '352820': '하이브', '214150': '클래시스', '328130': '루닛',
  '403870': 'HPSP', '454910': '두산로보틱스',
};

export function getKnownStockName(code?: unknown): string | undefined {
  const c = String(code ?? '').trim();
  if (!c) return undefined;
  return KNOWN_STOCK_NAMES[c.toUpperCase()] ?? KNOWN_STOCK_NAMES[c];
}
