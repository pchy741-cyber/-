import winston from 'winston';
import Transport from 'winston-transport';

// WARN/ERROR 레벨을 system_log DB에 직접 저장 (로그 유실 방지)
class DbTransport extends Transport {
  // 500ms 이내 동일 메시지 중복 DB 기록 방지 (logger.warn + 호출부 logSystem() 이중 기록 차단)
  private readonly _recent = new Map<string, number>();

  log(info: any, callback: () => void) {
    setImmediate(() => this.emit('logged', info));
    // 순환참조 방지: logSystem은 나중에 주입
    const logFn = (DbTransport as any)._logSystem;
    if (logFn && (info.level === 'warn' || info.level === 'error')) {
      const component = info.component ?? 'SYSTEM';
      const level: 'ERROR' | 'WARN' = info.level === 'error' ? 'ERROR' : 'WARN';
      const dedupKey = `${level}:${component}:${String(info.message).slice(0, 120)}`;
      const now = Date.now();
      // 500ms 이내 중복이면 DB 기록 스킵
      if ((this._recent.get(dedupKey) ?? 0) > now - 500) {
        callback();
        return;
      }
      this._recent.set(dedupKey, now);
      // v10.11.2: 하드캡 500 + 강제 정리 (기존: 200 임계만 → 고빈도 로깅 시 무한 성장)
      if (this._recent.size > 200) {
        for (const [k, t] of this._recent) {
          if (t < now - 5000) this._recent.delete(k);
        }
        // 정리 후에도 500 초과면 가장 오래된 것부터 삭제
        if (this._recent.size > 500) {
          const entries = [...this._recent.entries()].sort((a, b) => a[1] - b[1]);
          for (let i = 0; i < entries.length - 200; i++) this._recent.delete(entries[i][0]);
        }
      }
      // level/message/component/timestamp 등 winston 표준 필드를 뺀 나머지가 실제 메타데이터(stack 등)
      const { level: _l, message: _m, component: _c, timestamp: _t, service: _s, ...meta } = info;
      const details = Object.keys(meta).length > 0 ? meta : undefined;
      logFn(level, component, String(info.message).slice(0, 500), details).catch(() => {});
    }
    callback();
  }

  static _logSystem:
    | ((
        level: 'ERROR' | 'WARN' | 'INFO' | 'TRADE',
        component: string,
        message: string,
        details?: unknown,
      ) => Promise<void>)
    | null = null;
}

export function injectDbLogger(
  logSystem: (
    level: 'ERROR' | 'WARN' | 'INFO' | 'TRADE',
    component: string,
    message: string,
    details?: unknown,
  ) => Promise<void>,
) {
  DbTransport._logSystem = logSystem;
}

// Cloud Run 감지: K_SERVICE 또는 CLOUD_RUN 환경변수 존재 시
const isCloudRun = !!(process.env.K_SERVICE || process.env.K_REVISION);

// Cloud Run 전용: severity 필드를 Cloud Logging이 인식하는 형태로 매핑
// https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
const SEVERITY_MAP: Record<string, string> = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
  debug: 'DEBUG',
};

// Cloud Run: JSON structured logging (Cloud Logging 자동 수집)
const cloudRunFormat = winston.format.printf(({ timestamp, level, message, component, mode, service, ...meta }) => {
  const severity = SEVERITY_MAP[level] ?? 'DEFAULT';
  const entry: Record<string, unknown> = {
    severity,
    message: component ? `[${component}] ${message}` : String(message),
    timestamp,
    component,
  };
  if (mode) entry.mode = mode;
  const extraKeys = Object.keys(meta);
  if (extraKeys.length > 0) entry.metadata = meta;
  return JSON.stringify(entry);
});

// 로컬: 컬러 + 사람이 읽기 쉬운 형태
const localFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, component, ...meta }) => {
    const comp = component ? `[${component}]` : '';
    const extra = Object.keys(meta).length > 1 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${comp} ${message}${extra}`;
  }),
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: 'ai-auto-bot' },
  transports: [
    new winston.transports.Console({
      format: isCloudRun ? cloudRunFormat : localFormat,
    }),
    new DbTransport({ level: 'warn' }),
  ],
});
