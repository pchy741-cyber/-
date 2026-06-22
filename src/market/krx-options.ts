/**
 * KRX 옵션 플로우 — KOSPI200 P/C 비율 + VKOSPI (무료, 키 없음)
 *
 * - VKOSPI: 한국판 VIX. 20 이하 = 안정, 25 이상 = 공포, 30+ = 패닉
 * - P/C Ratio: Put/Call 미결제약정 비율. 높으면 하락 헤지 수요↑ = 기관 매도 선행
 * - KRX 공개 API (비공식, 로그인 불필요)
 * - 4시간 캐시
 */

import { logger } from '../utils/logger.js';
import { getKSTNow } from '../utils/time.js';

export interface KrxOptionsSignal {
  vkospi: number | null; // 변동성 지수 (VIX 한국판)
  pcRatio: number | null; // Put/Call 미결제약정 비율
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  scoreAdj: number; // Gemini 점수 보정 (-15~+10)
  fearLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'PANIC';
  summary: string;
}

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
let _cache: { data: KrxOptionsSignal; fetchedAt: number } | null = null;

// ── VKOSPI 수집 ────────────────────────────────────────────────────
async function fetchVkospi(): Promise<number | null> {
  // KRX 통계 API (비공식)
  const today = getKSTNow();
  const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, '');

  const url = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT03801',
    locale: 'ko_KR',
    tboxindIdx_finder_equidx0_2: 'VKOSPI',
    indIdx: '5',
    indIdx2: '1',
    strtDd: yyyymmdd,
    endDd: yyyymmdd,
    share: '1',
    money: '1',
    csvxls_isNo: 'false',
  });

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://data.krx.co.kr/',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(8_000),
    });
    // 409 Conflict: KRX 서버가 이전 요청을 아직 처리 중 — 잠시 대기 후 재시도
    if (res.status === 409 && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`KRX VKOSPI HTTP ${res.status}`);

    const data = (await res.json()) as { output?: Array<{ CLSPRC_IDX?: string }> };
    const val = parseFloat(data.output?.[0]?.CLSPRC_IDX ?? '');
    return Number.isFinite(val) ? val : null;
  }
  throw new Error('KRX VKOSPI 최대 재시도 초과');
}

// ── P/C Ratio 수집 ─────────────────────────────────────────────────
async function fetchPcRatio(): Promise<number | null> {
  const today = getKSTNow();
  const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, '');

  const url = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT12201',
    locale: 'ko_KR',
    trdDd: yyyymmdd,
    share: '1',
    money: '1',
    csvxls_isNo: 'false',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://data.krx.co.kr/',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`KRX P/C HTTP ${res.status}`);

  const data = (await res.json()) as { output?: Array<Record<string, string>> };
  // KOSPI200 옵션의 Put/Call OI 비율
  const row = data.output?.find((r) => r.ISU_NM?.includes('KOSPI200') || r.ISU_NM?.includes('코스피'));
  if (!row) return null;
  // 필드명 추정 (KRX API 변경 가능)
  const put = parseFloat(row.PUT_OI ?? row.MKTPRC_PUT ?? '');
  const call = parseFloat(row.CALL_OI ?? row.MKTPRC_CALL ?? '');
  if (!Number.isFinite(put) || !Number.isFinite(call) || call === 0) return null;
  return put / call;
}

// ── 종합 신호 계산 ─────────────────────────────────────────────────
function computeOptionsSignal(
  vkospi: number | null,
  pcRatio: number | null,
): Pick<KrxOptionsSignal, 'direction' | 'scoreAdj' | 'fearLevel' | 'summary'> {
  let adj = 0;
  const notes: string[] = [];

  // VKOSPI 공포 지수
  let fearLevel: KrxOptionsSignal['fearLevel'] = 'LOW';
  if (vkospi !== null) {
    if (vkospi >= 30) {
      fearLevel = 'PANIC';
      adj -= 15;
      notes.push(`VKOSPI ${vkospi.toFixed(1)}(패닉)`);
    } else if (vkospi >= 25) {
      fearLevel = 'HIGH';
      adj -= 8;
      notes.push(`VKOSPI ${vkospi.toFixed(1)}(공포)`);
    } else if (vkospi >= 20) {
      fearLevel = 'MEDIUM';
      adj -= 3;
      notes.push(`VKOSPI ${vkospi.toFixed(1)}(주의)`);
    } else {
      fearLevel = 'LOW';
      adj += 5;
      notes.push(`VKOSPI ${vkospi.toFixed(1)}(안정)`);
    }
  }

  // P/C Ratio: 1.0 이상 = 하락 헤지 수요 과다 = 단기 반등 역발상 신호
  if (pcRatio !== null) {
    if (pcRatio >= 1.3) {
      adj += 5;
      notes.push(`P/C ${pcRatio.toFixed(2)}(반등기대)`);
    } else if (pcRatio >= 1.0) {
      adj += 2;
      notes.push(`P/C ${pcRatio.toFixed(2)}(높음)`);
    } else if (pcRatio <= 0.5) {
      adj -= 5;
      notes.push(`P/C ${pcRatio.toFixed(2)}(낙관과다→주의)`);
    } else {
      notes.push(`P/C ${pcRatio.toFixed(2)}(중립)`);
    }
  }

  const clamped = Math.max(-15, Math.min(10, adj));
  const direction: KrxOptionsSignal['direction'] = clamped >= 3 ? 'BULLISH' : clamped <= -5 ? 'BEARISH' : 'NEUTRAL';
  return { direction, scoreAdj: clamped, fearLevel, summary: notes.join(' | ') || '옵션 데이터 없음' };
}

export async function getKrxOptionsSignal(): Promise<KrxOptionsSignal> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.data;

  const [vkospiResult, pcResult] = await Promise.allSettled([fetchVkospi(), fetchPcRatio()]);

  const vkospi = vkospiResult.status === 'fulfilled' ? vkospiResult.value : null;
  const pcRatio = pcResult.status === 'fulfilled' ? pcResult.value : null;

  const { direction, scoreAdj, fearLevel, summary } = computeOptionsSignal(vkospi, pcRatio);

  const signal: KrxOptionsSignal = { vkospi, pcRatio, direction, scoreAdj, fearLevel, summary };
  _cache = { data: signal, fetchedAt: Date.now() };
  logger.info(
    `📈 KRX 옵션 신호: ${direction} 공포=${fearLevel} (보정${scoreAdj > 0 ? '+' : ''}${scoreAdj}점) — ${summary}`,
    { component: 'KRX_OPT' },
  );
  return signal;
}
