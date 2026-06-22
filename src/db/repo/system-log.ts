import { isMemoryMode, getPool } from '../pool.js';
import { memLogSystem } from '../memory-store.js';
import { logger } from '../../utils/logger.js';

let _lastLogErrorAt = 0;

export async function logSystem(
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE',
  component: string,
  message: string,
  details?: unknown,
) {
  if (isMemoryMode()) {
    memLogSystem(level, component, message, details);
    return;
  }
  try {
    await getPool().query('INSERT INTO system_log (level, component, message, details) VALUES ($1,$2,$3,$4)', [
      level,
      component,
      message,
      details ? JSON.stringify(details) : null,
    ]);
  } catch (err) {
    // DB 미연결 시 에러 스팸 방지: 60초에 1번만 경고
    const now = Date.now();
    if (now - _lastLogErrorAt > 60_000) {
      _lastLogErrorAt = now;
      logger.error(`시스템 로그 DB 기록 실패 (60초 스로틀): ${err}`, { component: 'DB' });
    }
  }
}
