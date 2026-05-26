/**
 * 해외주식 자동매매 공통 타입
 * 모든 overseas/ 모듈이 공유하는 인터페이스 정의
 */

/** AI 분석 결과 */
export interface AIDecision {
  code: string; action: string; confidence: number; reasoning: string;
}

/** Rolling Kelly 결과 */
export interface KellyResult {
  halfKelly: number; sampleCount: number;
}

/** 점진적 쿨다운 */
export interface GradualCooldown {
  level: number; message: string; sizingPenalty: number;
}

/** 방어 모드 신호 */
export interface DefenseSignal {
  level: 'NONE' | 'CAUTION' | 'DANGER';
  positionReduction: number;
  blockNewBuys: boolean;
  trailTighten: number;
  reasons: string[];
}
