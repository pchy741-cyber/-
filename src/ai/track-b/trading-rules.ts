/**
 * 공통 매매 규칙 — Claude/Gemini/기술적 지표 모두 동일 적용
 *
 * 이 파일에서만 관리:
 * - BUY_BLOCKED_CODES: CEO 지시 매수 금지 종목
 * - PRIORITY_SECTOR_CODES: 우선 테마 (점수 보너스)
 * - IDLE_PARK_CODE: 유휴 현금 파킹 ETF
 */

/**
 * 매수 차단 목록 — 소형 투기주 + 파킹 ETF만 차단
 * 대형 우량주(셀트리온, 삼성바이오, 크래프톤 등)는 AI/기술적 판단에 위임
 */
export const BUY_BLOCKED_CODES = new Set([
  // ── 소형 투기성 바이오 ──
  '005690', // 파미셀
  '091480', // 이수앱지스
  '263860', // 지노믹트리
  '335890', // 비씨월드제약
  '311690', // 에이비엘바이오
  '395400', // SK바이오사이언스(스팩)
  // ── 소형 투기성 게임 ──
  '041270', // 부산정보기술
  '112610', // 씨에스게임테크
  '101730', // 위메이드맥스
  '067000', // 조이시티
  // ── 파킹/채권 ETF (수수료만 발생) ──
  '161510', // ARIRANG 단기채권액티브
  '360750', // KODEX S&P500 — 유휴 파킹 ETF
]);

/**
 * 우선 테마: 반도체 / 에너지 / 방산
 * 기술적 점수 +10 보너스 (technicalFallback) 또는 AI 컨텍스트에 명시
 */
export const PRIORITY_SECTOR_CODES = new Set([
  // 반도체
  '000660', // SK하이닉스
  '005935', // 삼성전자(우)
  '005930', // 삼성전자
  '042700', // 한미반도체
  '336370', // 솔브레인홀딩스
  // 에너지
  '015760', // 한국전력
  '034020', // 두산에너빌리티
  // 방산
  '012450', // 한화에어로스페이스
  '047050', // 포스코인터내셔널
  '064350', // 현대로템
  '272210', // 한화시스템
]);

/**
 * 대형 우선주: 시총 상위 반도체/방산 → 추가 점수 보너스 + buyThreshold 하향
 *
 * 문제: 대형주는 변동성이 낮아 AI 점수가 낮게 나오는 경향
 * → SWING buyThreshold 83점을 거의 못 넘음
 * → 반도체/방산 섹터 폭등해도 봇이 매수하지 않는 원인
 *
 * 해결: 대형 우선주에 대해:
 * 1. 기술점수 추가 보너스 (+20점, PRIORITY_SECTOR +10과 합산 = +30)
 * 2. buyThreshold 하향 (-8점: 83 → 75)
 * 3. 횡보장(ADX WEAK) 진입 허용
 */
export const MEGA_CAP_PRIORITY_CODES = new Map<string, { name: string; bonus: number; thresholdReduction: number }>([
  // 반도체 대형주 (시총 상위)
  ['005930', { name: '삼성전자', bonus: 20, thresholdReduction: 8 }],
  ['005935', { name: '삼성전자(우)', bonus: 20, thresholdReduction: 8 }],
  ['000660', { name: 'SK하이닉스', bonus: 20, thresholdReduction: 8 }],
  // 방산 대형주
  ['012450', { name: '한화에어로스페이스', bonus: 18, thresholdReduction: 6 }],
  ['272210', { name: '한화시스템', bonus: 15, thresholdReduction: 5 }],
  ['064350', { name: '현대로템', bonus: 15, thresholdReduction: 5 }],
  // 반도체 소재/장비
  ['042700', { name: '한미반도체', bonus: 12, thresholdReduction: 4 }],
]);

