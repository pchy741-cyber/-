import { isMemoryMode, queryWithRetry } from '../pool.js';
import { memInsertRiskEvent } from '../memory-store.js';
import { logger } from '../../utils/logger.js';

export async function insertRiskEvent(event: {
  event_type: string;
  severity: 'WARNING' | 'CRITICAL';
  details?: unknown;
  action_taken: string;
}) {
  if (isMemoryMode()) {
    memInsertRiskEvent(event);
    return;
  }
  try {
    await queryWithRetry('INSERT INTO risk_events (event_type, severity, details, action_taken) VALUES ($1,$2,$3,$4)', [
      event.event_type,
      event.severity,
      event.details ? JSON.stringify(event.details) : null,
      event.action_taken,
    ]);
  } catch (err) {
    logger.error(`리스크 이벤트 기록 실패: ${err}`);
  }
}
