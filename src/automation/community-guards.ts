/**
 * Community Guards — Anti-Pump, FOMO, Dry Pullback, Cross-Validation, Compliance
 *
 * 순수 함수 모듈: 외부 API 호출 없음, 테스트 용이.
 * community-sentinel.ts에서 호출하여 사용.
 *
 * 절대 원칙:
 * - 커뮤니티 데이터 단독 매수 금지
 * - 상방 가점 최대 +5, 하방 감점 최대 -20 (비대칭)
 * - RED source 데이터 저장 금지
 * - YELLOW source 원문 저장 금지
 */

import type { DailyCandle } from '../kis/market.js';

// ── Pump-and-Dump Keywords ──

export const PUMP_KEYWORDS = [
  '확정', '100%', '급등예고', '작전', '세력',
  '특급', '비밀', '인사이더', '보장', '손실없',
  '무조건', '원금보장', '수익보장', '환불',
  '쩜상', '상한가간다', '따라와',
];

export const FOMO_KEYWORDS = [
  '지금이라도', '늦기전에', '안사면후회', '무조건매수', '올라타',
  '바닥이다', '최저점', '못참겠다', '따라잡자', '몰빵',
];

// ── Anti-Pump Guard ──

export interface PumpRiskInput {
  mentionZ: number;
  changePct1D: number;       // 당일 등락률 %
  changePct3D: number;       // 3일 등락률 %
  marketCapKrw?: number;     // 시가총액 (원)
  hasDartDisclosure: boolean;
  hasConsensus: boolean;
  pumpKeywordHits: number;
  fomoKeywordHits: number;
}

export interface PumpRiskResult {
  pumpRiskScore: number;  // 0~100
  blockEntry: boolean;
  fomoPenalty: number;    // 0~20
  reasonCodes: string[];
}

/**
 * Anti-Pump Guard: 고점 설거지, 선취매, 프런트러닝, 작전주 차단
 */
export function assessPumpRisk(input: PumpRiskInput): PumpRiskResult {
  let pumpRiskScore = 0;
  let fomoPenalty = 0;
  let blockEntry = false;
  const reasonCodes: string[] = [];

  const { mentionZ, changePct1D, changePct3D, marketCapKrw, hasDartDisclosure, hasConsensus, pumpKeywordHits, fomoKeywordHits } = input;
  const isSmallCap = marketCapKrw != null && marketCapKrw < 300_000_000_000; // 3000억 미만

  // Rule 1: 소형주 + 언급 급증 + 1일 급등 → 작전주 의심
  if (isSmallCap && mentionZ >= 3.0 && changePct1D >= 8) {
    blockEntry = true;
    pumpRiskScore += 40;
    reasonCodes.push('SMALLCAP_MENTION_SURGE_PRICE_SPIKE');
  }

  // Rule 2: 소형주 + 극단적 언급 급증 → 무조건 차단
  if (isSmallCap && mentionZ >= 4.0) {
    blockEntry = true;
    pumpRiskScore += 50;
    reasonCodes.push('SMALLCAP_EXTREME_MENTION');
  }

  // Rule 3: 언급 급증 + 3일 20%+ 급등 → FOMO 과열
  if (mentionZ >= 3.0 && changePct3D >= 20) {
    fomoPenalty += 15;
    reasonCodes.push('FOMO_3D_SURGE');
  } else if (mentionZ >= 3.0 && changePct3D >= 15) {
    // Rule 4: 언급 급증 + 3일 15%+ → 중간 과열 (Rule 3과 상호배타)
    fomoPenalty += 10;
    reasonCodes.push('FOMO_3D_HOT');
  }

  // Rule 5: 극단적 언급 + 3일 25%+ → 최고 과열 + 차단
  if (mentionZ >= 4.0 && changePct3D >= 25) {
    fomoPenalty = 20;
    blockEntry = true;
    reasonCodes.push('EUPHORIA_BLOCK');
  }

  // Rule 6: 펌프 키워드 다수 감지
  if (pumpKeywordHits >= 3) {
    pumpRiskScore += 20;
    reasonCodes.push('PUMP_KEYWORDS_HIGH');
  } else if (pumpKeywordHits >= 1) {
    pumpRiskScore += 8;
    reasonCodes.push('PUMP_KEYWORDS_DETECTED');
  }

  // Rule 7: FOMO 키워드 감지
  if (fomoKeywordHits >= 2) {
    fomoPenalty += 5;
    reasonCodes.push('FOMO_KEYWORDS');
  }

  // Rule 8: 언급 급증인데 DART/컨센서스 뒷받침 없음 → 근거 없는 급등
  if (mentionZ >= 3.0 && !hasDartDisclosure && !hasConsensus) {
    pumpRiskScore += 15;
    reasonCodes.push('NO_FUNDAMENTAL_BACKING');
  }

  // 최종 클램프
  pumpRiskScore = Math.min(100, pumpRiskScore);
  fomoPenalty = Math.min(20, fomoPenalty);

  // pumpRiskScore 기반 최종 차단
  if (pumpRiskScore >= 80) blockEntry = true;

  return { pumpRiskScore, blockEntry, fomoPenalty, reasonCodes };
}

// ── Dry Pullback Detector ──

/**
 * 마름 눌림목 검증: 거래량 급감 조정 타점 확인
 *
 * 조건:
 * 1. 최근 5일 내 고점에서 -3% ~ -8% 조정
 * 2. 거래량 2일+ 연속 감소
 * 3. 현재가 > 20일 이동평균 (추세 건재)
 * 4. 최근 5일 내 거래량 급증 돌파가 있었음
 */
export function checkDryPullback(candles: DailyCandle[]): boolean {
  if (candles.length < 5) return false;

  const recent = candles.slice(0, 5);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const currentClose = recent[0].close;

  // 1. 조정 깊이: 3~8%
  const pullbackPct = ((recentHigh - currentClose) / recentHigh) * 100;
  if (pullbackPct < 3 || pullbackPct > 8) return false;

  // 2. 거래량 2일+ 연속 감소
  let volumeDeclineCount = 0;
  for (let i = 0; i < Math.min(3, recent.length - 1); i++) {
    if (recent[i].volume < recent[i + 1].volume) volumeDeclineCount++;
  }
  if (volumeDeclineCount < 2) return false;

  // 3. 20일 이동평균 위 (데이터 충분 시)
  if (candles.length >= 20) {
    const ma20 = candles.slice(0, 20).reduce((s, c) => s + c.close, 0) / 20;
    if (currentClose < ma20) return false;
  }

  // 4. 최근 5일 내 거래량 급증 돌파 확인 (5일 평균 대비 2배+)
  if (candles.length >= 10) {
    const vol5dAvg = candles.slice(5, 10).reduce((s, c) => s + c.volume, 0) / 5;
    const hadHighVolume = recent.some((c) => c.volume > vol5dAvg * 2.0);
    if (!hadHighVolume) return false;
  }

  return true;
}

// ── Cross-Validation Guard ──

export interface CrossValidationInput {
  hasDartNoNegative: boolean;    // DART 악재 없음
  fundamentalScore?: number;      // 펀더멘탈 점수 (0~100)
  hasInstitutionalBuy: boolean;   // 기관 3일 순매수
  hasForeignBuy: boolean;         // 외국인 3일 순매수
  hasSufficientLiquidity: boolean; // 거래대금 충분
  hasTechnicalSetup: boolean;     // 기술적 눌림목/돌파 구조
}

/**
 * 교차검증 Guard: 커뮤니티 후보 → 워치리스트 편입 조건
 * 5개 조건 중 최소 3개 충족 필요
 */
export function crossValidate(input: CrossValidationInput): { passed: boolean; score: number } {
  let score = 0;

  if (input.hasDartNoNegative) score++;
  if (input.fundamentalScore != null && input.fundamentalScore >= 70) score++;
  if (input.hasInstitutionalBuy || input.hasForeignBuy) score++;
  if (input.hasSufficientLiquidity) score++;
  if (input.hasTechnicalSetup) score++;

  return { passed: score >= 3, score };
}

// ── Community Score Adjustment ──

export interface CommunityScoreInput {
  mentionZ: number;
  posRatio: number;       // 0.0~1.0
  negRatio: number;       // 0.0~1.0
  pumpRisk: PumpRiskResult;
  dryPullbackValid: boolean;
  crossValidated: boolean;
}

/**
 * 커뮤니티 점수 조정 계산 (v16.1: 비대칭 확대 — 최대 +8, 최소 -20)
 *
 * v16.1 변경:
 * - 가점 상한 +5→+8 (긍정+교차검증+눌림목+적정언급)
 * - 긍정 심리 60%+에서 55%+로 완화 (약한 긍정도 인정)
 * - 중간 가점 구간 추가 (+5: 긍정+교차검증)
 */
export function computeCommunityAdj(input: CommunityScoreInput): number {
  const { mentionZ, posRatio, negRatio, pumpRisk, dryPullbackValid, crossValidated } = input;

  // HARD: 펌프 감지 → 최대 감점
  if (pumpRisk.blockEntry) return -20;

  // FOMO 과열 패널티
  if (pumpRisk.fomoPenalty >= 15) return -15;

  // pumpRiskScore 기반 감점
  if (pumpRisk.pumpRiskScore >= 60) return -15;
  if (pumpRisk.pumpRiskScore >= 40) return -8;

  // 부정 심리 지배
  if (negRatio > 0.7) return -10;
  if (negRatio > 0.5) return -5;

  // 언급 급증 (과열 경계)
  if (mentionZ > 2.5) return -5;

  // v16.1: 긍정 + 교차검증 + 마름 눌림목 = 최고 가점 (+8)
  if (posRatio > 0.55 && crossValidated && dryPullbackValid && mentionZ >= 1.0 && mentionZ < 2.5) {
    return 8;
  }

  // v16.1: 긍정 + 교차검증 = 중간 가점 (+5)
  if (posRatio > 0.55 && crossValidated && mentionZ >= 0.5 && mentionZ < 2.5) {
    return 5;
  }

  // v16.1: 긍정만 (교차검증 없이) = 약한 가점 (+2)
  if (posRatio > 0.6 && mentionZ >= 0.5 && mentionZ < 2.0) {
    return 2;
  }

  // 데이터 부족 / 중립
  return 0;
}
