/**
 * 해외주식 자동매매 공통 타입
 * 모든 overseas/ 모듈이 공유하는 인터페이스 정의
 */

/** AI 분석 결과 */
export interface AIDecision {
  code: string;
  action: string;
  confidence: number;
  reasoning: string;
}

/** Rolling Kelly 결과 (세이버메트릭스 확장) */
export interface KellyResult {
  fullKelly: number;
  halfKelly: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  sampleCount: number;
  // 세이버메트릭스 추가 지표
  profitFactor: number; // 총수익/총손실 (>1.0 = 수익 구조)
  rMultiple: number; // 평균 R배수 (avgWin/avgLoss)
  evPerTrade: number; // 기대값 %/건
  breakevenWinRate: number; // 손익분기 승률
}

/** 점진적 쿨다운 (완전한 버전) */
export interface GradualCooldown {
  level: number;
  cooldownMs: number;
  sizingPenalty: number;
  message: string;
}

/** 방어 모드 신호 */
export interface DefenseSignal {
  level: 'NONE' | 'CAUTION' | 'DANGER';
  positionReduction: number;
  blockNewBuys: boolean;
  trailTighten: number;
  reasons: string[];
}
