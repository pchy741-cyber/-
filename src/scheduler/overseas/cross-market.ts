/**
 * 크로스마켓 선행 신호 — 아시아장 종목 변동 → 미국 종목 방향 예측
 * 반도체 공급망 등 글로벌 상관관계 기반 선행 지표 활용
 */

import { getOverseasPrice } from '../../kis/overseas.js';
import { logger } from '../../utils/logger.js';

// ── 타입 ──

interface CrossMarketPair {
  asiaCode: string; // 아시아 종목 (e.g., '6857' 도쿄일렉트론)
  asiaExchange: string;
  usCode: string; // 연관 미국 종목 (e.g., 'NVDA')
  correlation: number; // 상관 강도
}

export interface CrossMarketSignal {
  usCode: string;
  asiaCode: string;
  asiaChangePct: number;
  signalType: 'BULLISH' | 'BEARISH';
  confidence: number; // 0~1
}

// ── 하드코딩 크로스마켓 페어 ──

const CROSS_PAIRS: CrossMarketPair[] = [
  // 일본 반도체 → 미국 반도체
  { asiaCode: '6857', asiaExchange: 'TSE', usCode: 'NVDA', correlation: 0.75 },
  { asiaCode: '6857', asiaExchange: 'TSE', usCode: 'AMD', correlation: 0.65 },
  { asiaCode: '8035', asiaExchange: 'TSE', usCode: 'AMAT', correlation: 0.7 },
  { asiaCode: '6861', asiaExchange: 'TSE', usCode: 'KLAC', correlation: 0.65 },
  // 대만 TSMC → 미국 반도체
  { asiaCode: '2330', asiaExchange: 'TPE', usCode: 'TSM', correlation: 0.9 },
  { asiaCode: '2330', asiaExchange: 'TPE', usCode: 'NVDA', correlation: 0.6 },
];

// ── 캐시 (1시간 — 아시아장 종료 후 변하지 않으므로) ──
let _crossCache: { signals: CrossMarketSignal[]; fetchedAt: number } | null = null;
const CROSS_CACHE_TTL = 60 * 60_000; // 1시간

/**
 * 아시아장 종목 변동 기반 미국 종목 방향 신호 생성
 * - changePct >= 3% 이상인 페어만 신호 생성
 * - confidence = correlation * min(1, abs(changePct) / 5)
 */
export async function getCrossMarketSignals(): Promise<CrossMarketSignal[]> {
  // 캐시 유효 시 반환
  if (_crossCache && Date.now() - _crossCache.fetchedAt < CROSS_CACHE_TTL) {
    return _crossCache.signals;
  }

  const signals: CrossMarketSignal[] = [];

  try {
    // 고유한 아시아 종목만 추출 (중복 API 호출 방지)
    const uniqueAsia = new Map<string, { code: string; exchange: string }>();
    for (const pair of CROSS_PAIRS) {
      const key = `${pair.asiaCode}_${pair.asiaExchange}`;
      if (!uniqueAsia.has(key)) {
        uniqueAsia.set(key, { code: pair.asiaCode, exchange: pair.asiaExchange });
      }
    }

    // 아시아 종목 현재가 병렬 조회
    const priceResults = new Map<string, number>();
    const pricePromises = [...uniqueAsia.entries()].map(async ([key, { code, exchange }]) => {
      try {
        const price = await getOverseasPrice(code, exchange);
        priceResults.set(key, price.changePct);
      } catch (err: any) {
        logger.warn(`크로스마켓 가격 조회 실패: ${code}(${exchange}) — ${err.message}`, { component: 'OVERSEAS' });
      }
    });
    await Promise.all(pricePromises);

    // 신호 생성
    for (const pair of CROSS_PAIRS) {
      const key = `${pair.asiaCode}_${pair.asiaExchange}`;
      const changePct = priceResults.get(key);
      if (changePct === undefined) continue;

      const absChange = Math.abs(changePct);
      // 3% 이상 변동만 신호
      if (absChange < 3) continue;

      const signalType: 'BULLISH' | 'BEARISH' = changePct > 0 ? 'BULLISH' : 'BEARISH';
      const confidence = pair.correlation * Math.min(1, absChange / 5);

      signals.push({
        usCode: pair.usCode,
        asiaCode: pair.asiaCode,
        asiaChangePct: changePct,
        signalType,
        confidence,
      });

      logger.info(
        `[CrossMarket] ${pair.asiaCode}(${pair.asiaExchange}) ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}% → ${pair.usCode} ${signalType} (conf=${confidence.toFixed(2)})`,
        { component: 'OVERSEAS' },
      );
    }

    // 같은 usCode에 대해 여러 신호가 있으면 가장 높은 confidence만 유지
    const bestByUS = new Map<string, CrossMarketSignal>();
    for (const sig of signals) {
      const existing = bestByUS.get(sig.usCode);
      if (!existing || sig.confidence > existing.confidence) {
        bestByUS.set(sig.usCode, sig);
      }
    }

    const deduped = [...bestByUS.values()];
    _crossCache = { signals: deduped, fetchedAt: Date.now() };
    return deduped;
  } catch (err: any) {
    logger.warn(`크로스마켓 신호 조회 실패: ${err.message}`, { component: 'OVERSEAS' });
    return _crossCache?.signals ?? [];
  }
}
