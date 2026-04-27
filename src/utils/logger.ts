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

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'quantops' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, component, ...meta }) => {
          const comp = component ? `[${component}]` : '';
          const extra = Object.keys(meta).length > 1 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} ${level} ${comp} ${message}${extra}`;
        }),
      ),
    }),
    new DbTransport({ level: 'warn' }),
  ],
});
