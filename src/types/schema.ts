/**
 * 🗂️ 마스터 도메인 스키마 — SSoT (Single Source of Truth)
 *
 * CEO 지시 (2026-06-12): "데이터마스터스키마쓰고 정합성 마이그레이션 주의"
 *
 * 정책:
 *   - 모든 DB 도메인 타입은 src/db/models.ts (Zod 스키마)에서 정의
 *   - 이 파일은 통합 진입점 — 새 모듈은 여기서 import
 *   - 프론트엔드도 가능한 한 동일 타입을 참조 (현재 frontend/app/types/* 는 별도 — 추후 통합 검토)
 *
 * 중복 금지:
 *   - Order, TransactionChain, AIScore, PortfolioSnapshot, WatchlistItem, StrategyConfig
 *     이 6개는 절대 다른 곳에서 재정의 금지 (Zod 검증 일관성)
 *
 * 추가 타입이 필요할 때:
 *   - DB 매핑 → src/db/models.ts 에 Zod 스키마 추가 후 여기서 re-export
 *   - 비-DB 도메인 → src/types/ 하위에 별도 파일 + 여기서 re-export
 */

export {
  // 스키마 (런타임 검증용)
  WatchlistItemSchema,
  AIScoreSchema,
  TransactionChainSchema,
  OrderSchema,
  PortfolioSnapshotSchema,
  StrategyConfigSchema,
  TradeDecisionSchema,
  ScoringResultSchema,
  // 타입 (TS 추론용)
  type WatchlistItem,
  type AIScore,
  type TransactionChain,
  type Order,
  type PortfolioSnapshot,
  type StrategyConfig,
  type TradeDecision,
  type ScoringResult,
} from '../db/models.js';

// MDD 스냅샷 (risk/mdd-calculator.ts에서 정의)
export type { MonthlyMddSnapshot } from '../risk/mdd-calculator.js';

// 알림 모드 (notifications/mode-message.ts)
export type Mode = 'paper' | 'live';

// 캡쳐 진단 (api/routes/review/capture-trigger.ts)
export type { CaptureTrigger, CaptureSnapshot } from '../api/routes/review/capture-trigger.js';
