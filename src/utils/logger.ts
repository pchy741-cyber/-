import winston from 'winston';
import Transport from 'winston-transport';

// WARN/ERROR 레벨을 system_log DB에 직접 저장 (로그 유실 방지)
class DbTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  log(info: any, callback: () => void) {
    setImmediate(() => this.emit('logged', info));
    // 순환참조 방지: logSystem은 나중에 주입
    const logFn = (DbTransport as any)._logSystem;
    if (logFn && (info.level === 'warn' || info.level === 'error')) {
      const component = info.component ?? 'SYSTEM';
      const level: 'ERROR' | 'WARN' = info.level === 'error' ? 'ERROR' : 'WARN';
      logFn(level, component, String(info.message).slice(0, 500)).catch(() => {});
    }
    callback();
  }

  static _logSystem: ((level: 'ERROR' | 'WARN' | 'INFO' | 'TRADE', component: string, message: string, details?: unknown) => Promise<void>) | null = null;
}

export function injectDbLogger(logSystem: (level: 'ERROR' | 'WARN' | 'INFO' | 'TRADE', component: string, message: string, details?: unknown) => Promise<void>) {
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
const cloudRunFormat = winston.format.printf(({ timestamp, level, message, component, service, ...meta }) => {
  const severity = SEVERITY_MAP[level] ?? 'DEFAULT';
  const entry: Record<string, unknown> = {
    severity,
    message: component ? `[${component}] ${message}` : String(message),
    timestamp,
    component,
  };
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
  level: 'info',
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
