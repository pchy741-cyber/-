import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { clearTokenCache, getAccessToken } from './auth.js';

interface KISRequestOptions {
  path: string;
  method?: 'GET' | 'POST';
  trId: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  hashkey?: string;
  /** 시세 조회 시 실거래 URL 사용 (모의투자 서버 미지원 API용) */
  useRealUrl?: boolean;
  /** 외부에서 rate limiter를 관리할 때 내부 limiter 스킵 */
  skipRateLimiter?: boolean;
}

interface KISResponse<T = unknown> {
  rtCd: string; // "0" = 성공
  msgCd: string;
  msg1: string;
  output?: T;
  output1?: T;
  output2?: T;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

// ── KIS API Rate Limiter (초당 20건 제한 대응) ──
// 토큰 버킷 알고리즘: 초당 최대 18건 (안전 마진 2건)
class RateLimiter {
  private queue: Array<{ resolve: () => void }> = [];
  private timestamps: number[] = [];
  private readonly maxPerSecond: number;
  private processing = false;

  constructor(maxPerSecond = 18) {
    this.maxPerSecond = maxPerSecond;
  }

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this.processQueue();
    });
  }

  private processQueue() {
    if (this.processing) return;
    this.processing = true;

    const tick = () => {
      if (this.queue.length === 0) {
        this.processing = false;
        return;
      }

      const now = Date.now();
      // 1초 이내 타임스탬프만 유지
      this.timestamps = this.timestamps.filter((t) => now - t < 1000);

      if (this.timestamps.length < this.maxPerSecond) {
        const item = this.queue.shift()!;
        this.timestamps.push(now);
        item.resolve();
        // 다음 요청 즉시 처리 시도
        if (this.queue.length > 0) {
          tick();
        } else {
          this.processing = false;
        }
      } else {
        // 가장 오래된 타임스탬프가 1초 지날 때까지 대기
        const waitMs = 1000 - (now - this.timestamps[0]) + 5; // 5ms 안전 마진
        setTimeout(tick, waitMs);
      }
    };

    tick();
  }

  get pendingCount() {
    return this.queue.length;
  }
}

// KIS API rate limit: 실전 20건/sec, 모의투자 1건/sec (실제 서버 엄격 — 초과 시 3~15초 재시도 방지)
const isPaper = config.isPaper;
export const kisRateLimiter = new RateLimiter(isPaper ? 1 : 15);
// 해외 전용 rate limiter (국내와 독립 — 서로 블로킹 방지)
export const overseasRateLimiter = new RateLimiter(isPaper ? 8 : 15);
// 시세/차트 조회 전용 rate limiter — 실거래 URL 사용하므로 paper 모드에도 8/sec 허용
export const marketDataRateLimiter = new RateLimiter(8);

/**
 * KIS REST API 범용 클라이언트
 * - 자동 인증 헤더 삽입
 * - 재시도 (5xx 에러)
 * - 응답 파싱
 */
export async function kisRequest<T = unknown>(options: KISRequestOptions): Promise<KISResponse<T>> {
  const { path, method = 'GET', trId, params, body, hashkey, useRealUrl, skipRateLimiter } = options;

  const baseUrl = useRealUrl ? 'https://openapi.koreainvestment.com:9443' : config.kis.baseUrl;
  const url = new URL(`${baseUrl}${path}`);
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    authorization: '',
    appkey: process.env.KIS_APP_KEY || config.kis.appKey,
    appsecret: process.env.KIS_APP_SECRET || config.kis.appSecret,
    tr_id: trId,
  };

  if (hashkey) {
    headers.hashkey = hashkey;
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // 매 시도마다 토큰 갱신 (LOGOUT 후 clearTokenCache() 시 새 토큰 발급)
    headers.authorization = `Bearer ${await getAccessToken()}`;

    // Rate Limiter 대기 (해외 호출은 별도 limiter 사용 → 여기서 스킵)
    if (!skipRateLimiter) await kisRateLimiter.acquire();

    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      // KIS가 토큰 만료 시 JSON 대신 평문 "LOGOUT" 반환 → 토큰 캐시 초기화 후 재시도
      const rawText = await res.text();
      if (!rawText || rawText.trim() === '') {
        if (attempt < MAX_RETRIES) {
          logger.warn(`KIS 빈 응답, 재시도 ${attempt}/${MAX_RETRIES}`, { component: 'KIS' });
          await sleep(2000 * attempt);
          continue;
        }
        throw new Error('KIS 빈 응답 — 반복 재시도 실패');
      }
      if (rawText.trim() === 'LOGOUT') {
        clearTokenCache();
        if (attempt < MAX_RETRIES) {
          logger.warn(`KIS 세션 만료 (LOGOUT), 토큰 갱신 후 재시도 ${attempt}/${MAX_RETRIES}`, { component: 'KIS' });
          continue;
        }
        throw new Error('KIS 세션 만료 (LOGOUT) — 토큰 재발급 후에도 실패');
      }

      const data = JSON.parse(rawText) as Record<string, unknown>;

      if (!res.ok || data.rt_cd !== '0') {
        const errMsg = `KIS API 오류 [${trId}]: ${data.msg_cd} - ${data.msg1}`;
        const msg = String(data.msg1 ?? '');

        // rate limit 초과 → 재시도하되 충분히 대기 (KIS는 HTTP 200으로 rate limit 보냄)
        if (msg.includes('초당') || msg.includes('거래건수')) {
          if (attempt < MAX_RETRIES) {
            logger.warn(`KIS rate limit 초과, ${attempt * 3}초 대기 후 재시도 ${attempt}/${MAX_RETRIES}`, { component: 'KIS' });
            await sleep(3000 * attempt); // 3초, 6초, 9초, 12초, 15초 대기
            continue;
          }
          throw new Error(errMsg);
        }

        // 4xx는 재시도 불가
        if (res.status >= 400 && res.status < 500) {
          throw new Error(errMsg);
        }

        // 5xx → 재시도
        if (attempt < MAX_RETRIES) {
          logger.warn(`KIS 5xx 에러, 재시도 ${attempt}/${MAX_RETRIES}`, { component: 'KIS' });
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw new Error(errMsg);
      }

      return {
        rtCd: data.rt_cd as string,
        msgCd: data.msg_cd as string,
        msg1: data.msg1 as string,
        output: data.output as T | undefined,
        output1: data.output1 as T | undefined,
        output2: data.output2 as T | undefined,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        logger.warn(`KIS 요청 실패, 재시도 ${attempt}/${MAX_RETRIES}: ${lastError.message}`, {
          component: 'KIS',
        });
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error('KIS API 요청 실패');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
