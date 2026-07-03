/**
 * US→Korea 여파(Ripple Effect) 엔진
 *
 * 미국 시장 야간 결과 → 한국 종목별 점수 보정
 *
 * 문제: 메타가 데이터센터 축소 → SK하이닉스 -4% 같은 공급망 여파를
 *       기존 시스템(market-routing, crash-profit)은 "전체 시장 Risk-Off"로만 반영.
 *       섹터/종목 단위의 세분화된 보정이 없었음.
 *
 * 해법: US 개별 종목 + 섹터 ETF 등락 → 공급망 매핑 → ai_overrides scoreAdj 주입
 *       TTL 3시간 (08:35~11:35) → Track B 매수 필터에 자동 반영
 *
 * 실행: 08:35 KST 월~금 (모닝브리프 08:10/08:40 이후, Track B 09:00 이전)
 */

import { logger } from '../utils/logger.js';
import { getUSSectorSignals, type USSectorSnapshot } from '../market/us-sector-signals.js';
import { setOverride } from '../ai/ai-overrides.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { SECTOR_MAP_KR } from '../config/sector-map.js';

const COMP = 'US_RIPPLE';

// ── US 개별 종목 → 한국 종목 공급망 매핑 ──

interface SupplyChainLink {
  usSymbol: string;
  usName: string;
  krCode: string;
  krName: string;
  weight: number;  // 영향 강도 (0.5~1.0)
  reason: string;
}

const SUPPLY_CHAIN_MAP: SupplyChainLink[] = [
  // 반도체 공급망: NVDA/AMD → 삼성전자/SK하이닉스 (HBM, DRAM 납품)
  { usSymbol: 'NVDA', usName: 'NVIDIA', krCode: '000660', krName: 'SK하이닉스', weight: 1.0, reason: 'HBM 최대 공급사' },
  { usSymbol: 'NVDA', usName: 'NVIDIA', krCode: '005930', krName: '삼성전자', weight: 0.7, reason: 'HBM/DRAM 공급' },
  { usSymbol: 'AMD', usName: 'AMD', krCode: '000660', krName: 'SK하이닉스', weight: 0.7, reason: 'HBM 공급' },
  { usSymbol: 'AMD', usName: 'AMD', krCode: '005930', krName: '삼성전자', weight: 0.5, reason: 'DRAM 공급' },
  { usSymbol: 'AVGO', usName: 'Broadcom', krCode: '000660', krName: 'SK하이닉스', weight: 0.6, reason: 'AI칩 메모리' },
  { usSymbol: 'MU', usName: 'Micron', krCode: '000660', krName: 'SK하이닉스', weight: 0.8, reason: '메모리 경쟁사 연동' },
  { usSymbol: 'MU', usName: 'Micron', krCode: '005930', krName: '삼성전자', weight: 0.8, reason: '메모리 경쟁사 연동' },

  // 빅테크 데이터센터 CAPEX → SK하이닉스 (HBM 수요)
  { usSymbol: 'META', usName: 'Meta', krCode: '000660', krName: 'SK하이닉스', weight: 0.8, reason: '데이터센터 HBM 수요' },
  { usSymbol: 'META', usName: 'Meta', krCode: '005930', krName: '삼성전자', weight: 0.5, reason: '서버 메모리 수요' },
  { usSymbol: 'GOOGL', usName: 'Google', krCode: '000660', krName: 'SK하이닉스', weight: 0.6, reason: 'AI 인프라 투자' },
  { usSymbol: 'AMZN', usName: 'Amazon', krCode: '000660', krName: 'SK하이닉스', weight: 0.6, reason: 'AWS 서버 메모리' },
  { usSymbol: 'MSFT', usName: 'Microsoft', krCode: '000660', krName: 'SK하이닉스', weight: 0.6, reason: 'Azure AI 인프라' },

  // Apple → 삼성전자 (OLED, 메모리), LG전자 (부품)
  { usSymbol: 'AAPL', usName: 'Apple', krCode: '005930', krName: '삼성전자', weight: 0.7, reason: 'OLED/메모리 공급' },
  { usSymbol: 'AAPL', usName: 'Apple', krCode: '066570', krName: 'LG전자', weight: 0.5, reason: '부품 공급' },

  // Tesla → 배터리 공급망
  { usSymbol: 'TSLA', usName: 'Tesla', krCode: '373220', krName: 'LG에너지솔루션', weight: 0.9, reason: '배터리 독점 공급' },
  { usSymbol: 'TSLA', usName: 'Tesla', krCode: '051910', krName: 'LG화학', weight: 0.7, reason: '배터리 소재' },
  { usSymbol: 'TSLA', usName: 'Tesla', krCode: '006400', krName: '삼성SDI', weight: 0.6, reason: '배터리 공급' },
  { usSymbol: 'TSLA', usName: 'Tesla', krCode: '247540', krName: '에코프로BM', weight: 0.5, reason: '양극재 공급' },

  // 반도체 장비: AMAT/ASML → 삼성전자/SK하이닉스 (장비 구매사)
  { usSymbol: 'AMAT', usName: 'AMAT', krCode: '005930', krName: '삼성전자', weight: 0.5, reason: '반도체 장비 구매' },
  { usSymbol: 'AMAT', usName: 'AMAT', krCode: '000660', krName: 'SK하이닉스', weight: 0.5, reason: '반도체 장비 구매' },

  // 인터넷/클라우드 → 네이버/카카오 (심리적 연동)
  { usSymbol: 'GOOGL', usName: 'Google', krCode: '035420', krName: '네이버', weight: 0.4, reason: '검색 플랫폼 심리 연동' },
  { usSymbol: 'META', usName: 'Meta', krCode: '035720', krName: '카카오', weight: 0.4, reason: 'SNS 플랫폼 심리 연동' },

  // 바이오: 미국 바이오 섹터 → 한국 바이오
  { usSymbol: 'LLY', usName: 'Eli Lilly', krCode: '207940', krName: '삼바', weight: 0.4, reason: '바이오 섹터 심리' },
  { usSymbol: 'LLY', usName: 'Eli Lilly', krCode: '068270', krName: '셀트리온', weight: 0.4, reason: '바이오 섹터 심리' },
];

// ── US 섹터 ETF → 한국 섹터 매핑 ──

interface SectorMapping {
  usSector: string;    // us-sector-signals.ts의 sector 코드
  krSectors: string[]; // SECTOR_MAP_KR의 한국 섹터명
  weight: number;      // 영향 강도
}

const SECTOR_TO_KR: SectorMapping[] = [
  { usSector: 'TECH', krSectors: ['반도체', '인터넷'], weight: 0.6 },
  { usSector: 'HEALTHCARE', krSectors: ['바이오'], weight: 0.5 },
  { usSector: 'FINANCE', krSectors: ['금융'], weight: 0.5 },
  { usSector: 'INDUSTRIAL', krSectors: ['방산', '조선'], weight: 0.4 },
  { usSector: 'CONSUMER', krSectors: ['가전'], weight: 0.4 },
  { usSector: 'ENERGY', krSectors: ['배터리'], weight: 0.3 },
];

// ── Yahoo Finance 개별 종목 등락률 조회 (us-sector-signals.ts 패턴 재사용) ──

async function fetchQuoteChangePct(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2d&interval=1d`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantOps/1.0)' },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number };
        }>;
      };
    };

    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose;
    if (!prevClose || prevClose <= 0) return null;
    return ((meta.regularMarketPrice - prevClose) / prevClose) * 100;
  } catch {
    return null;
  }
}

// ── 핵심: 여파 점수 계산 ──

interface RippleSignal {
  krCode: string;
  krName: string;
  scoreAdj: number;
  sources: string[];  // 어떤 US 종목/섹터에서 신호가 왔는지
}

/**
 * 개별 US 종목 변동 → 한국 종목 점수 보정 계산
 * changePct가 양수면 한국 종목에 양의 보정, 음수면 음의 보정
 */
function calcStockRipple(
  changePct: number,
  weight: number,
): number {
  // |changePct| < 2% → 노이즈, 무시
  if (Math.abs(changePct) < 2.0) return 0;

  // 보정값 = changePct × weight × 1.5 (증폭 계수)
  // 하락 여파가 상승보다 더 강력 (비대칭: 공포가 탐욕보다 빠름)
  const amplifier = changePct < 0 ? 2.0 : 1.2;
  const raw = changePct * weight * amplifier;

  // 클램프: -15 ~ +10 (scoreAdj 범위 내)
  return Math.max(-15, Math.min(10, Math.round(raw)));
}

/**
 * 섹터 ETF 변동 → 해당 한국 섹터 종목들에 점수 보정
 */
function calcSectorRipple(changePct: number, weight: number): number {
  if (Math.abs(changePct) < 1.5) return 0;

  const amplifier = changePct < 0 ? 1.5 : 1.0;
  const raw = changePct * weight * amplifier;

  // 섹터 기반은 약하게: -8 ~ +5
  return Math.max(-8, Math.min(5, Math.round(raw)));
}

// ── 메인 함수 ──

export async function runUSRippleEffect(): Promise<void> {
  const t0 = Date.now();
  logger.info('🌊 [US_RIPPLE] 미국→한국 여파 분석 시작', { component: COMP });

  try {
    // 1. US 개별 핵심 종목 가격 병렬 조회
    const uniqueUSSymbols = [...new Set(SUPPLY_CHAIN_MAP.map((l) => l.usSymbol))];
    const usPrices = new Map<string, number>();

    // 배치 5개씩 (Yahoo Finance rate limit 방지)
    const BATCH = 5;
    for (let i = 0; i < uniqueUSSymbols.length; i += BATCH) {
      const batch = uniqueUSSymbols.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((s) => fetchQuoteChangePct(s)));
      for (let j = 0; j < batch.length; j++) {
        if (results[j] !== null) usPrices.set(batch[j], results[j]!);
      }
      if (i + BATCH < uniqueUSSymbols.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // 2. US 섹터 ETF 데이터 (기존 모듈 재사용)
    let sectorSnapshot: USSectorSnapshot | null = null;
    try {
      sectorSnapshot = await getUSSectorSignals();
    } catch {
      logger.warn('[US_RIPPLE] US 섹터 ETF 조회 실패 — 개별 종목만 사용', { component: COMP });
    }

    // 3. 종목별 여파 신호 집계
    const rippleMap = new Map<string, RippleSignal>();

    // 3a. 개별 US 종목 → 한국 종목 (공급망 기반, 강한 신호)
    for (const link of SUPPLY_CHAIN_MAP) {
      const changePct = usPrices.get(link.usSymbol);
      if (changePct === undefined) continue;

      const adj = calcStockRipple(changePct, link.weight);
      if (adj === 0) continue;

      const existing = rippleMap.get(link.krCode);
      const source = `${link.usSymbol}(${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)→${link.reason}`;

      if (!existing) {
        rippleMap.set(link.krCode, {
          krCode: link.krCode,
          krName: link.krName,
          scoreAdj: adj,
          sources: [source],
        });
      } else {
        // 같은 한국 종목에 여러 US 신호 → 가장 극단적인 값 사용
        if (Math.abs(adj) > Math.abs(existing.scoreAdj)) {
          existing.scoreAdj = adj;
        }
        existing.sources.push(source);
      }
    }

    // 3b. 섹터 ETF → 한국 섹터 종목들 (약한 신호, 개별 종목 신호 없을 때 보완)
    if (sectorSnapshot) {
      for (const mapping of SECTOR_TO_KR) {
        const sectorSignal = sectorSnapshot.sectors.find((s) => s.sector === mapping.usSector);
        if (!sectorSignal) continue;

        const sectorAdj = calcSectorRipple(sectorSignal.changePct, mapping.weight);
        if (sectorAdj === 0) continue;

        // 해당 한국 섹터의 모든 종목에 적용
        for (const [krCode, krSector] of Object.entries(SECTOR_MAP_KR)) {
          if (!mapping.krSectors.includes(krSector)) continue;

          const existing = rippleMap.get(krCode);
          const source = `${sectorSignal.symbol}(${sectorSignal.changePct > 0 ? '+' : ''}${sectorSignal.changePct.toFixed(1)}%)→${mapping.usSector}섹터`;

          if (!existing) {
            rippleMap.set(krCode, {
              krCode,
              krName: krSector,
              scoreAdj: sectorAdj,
              sources: [source],
            });
          } else if (existing.sources.length === 0) {
            // 개별 종목 신호가 이미 있으면 섹터 신호는 무시 (중복 방지)
            // 여기서는 sources.length > 0이면 이미 개별 신호가 있으므로 스킵
          }
        }
      }
    }

    // 4. ai_overrides에 주입
    const appliedSignals: RippleSignal[] = [];
    for (const signal of rippleMap.values()) {
      if (signal.scoreAdj === 0) continue;

      try {
        await setOverride(
          'signal',
          `${signal.krCode}_scoreAdj`,
          signal.scoreAdj,
          `US여파: ${signal.sources.slice(0, 2).join(', ')}`,
          180, // 3시간 TTL (08:35→11:35)
        );
        // Paper 모드에도 동일 적용
        await setOverride(
          'signal',
          `${signal.krCode}_scoreAdj`,
          signal.scoreAdj,
          `US여파: ${signal.sources.slice(0, 2).join(', ')}`,
          180,
          true, // isPaper
        );
        appliedSignals.push(signal);
      } catch (err) {
        logger.warn(`[US_RIPPLE] 오버라이드 설정 실패 ${signal.krCode}: ${err}`, { component: COMP });
      }
    }

    // 5. 로깅 + 텔레그램
    const elapsed = Date.now() - t0;
    const fetched = usPrices.size;
    const applied = appliedSignals.length;

    logger.info(
      `🌊 [US_RIPPLE] 완료 — US종목 ${fetched}/${uniqueUSSymbols.length}건 조회, ${applied}건 한국 종목 보정 (${elapsed}ms)`,
      { component: COMP },
    );

    if (applied > 0) {
      // 지수 정보
      const qqqChange = sectorSnapshot?.indices.find((i) => i.symbol === 'QQQ')?.changePct;
      const spyChange = sectorSnapshot?.indices.find((i) => i.symbol === 'SPY')?.changePct;

      const indexLine = [
        qqqChange != null ? `QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(1)}%` : null,
        spyChange != null ? `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(1)}%` : null,
      ]
        .filter(Boolean)
        .join(' | ');

      // 주요 US 종목 등락
      const usLines = [...usPrices.entries()]
        .filter(([, pct]) => Math.abs(pct) >= 2.0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 8)
        .map(([sym, pct]) => `${sym} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`)
        .join(' | ');

      // 한국 종목 보정 내역
      const krLines = appliedSignals
        .sort((a, b) => a.scoreAdj - b.scoreAdj) // 패널티 큰 순
        .map((s) => {
          const arrow = s.scoreAdj > 0 ? '📈' : '📉';
          return `  ${arrow} ${s.krName}(${s.krCode}): ${s.scoreAdj > 0 ? '+' : ''}${s.scoreAdj}점`;
        })
        .join('\n');

      const msg = [
        `🌊 US→KR 여파 분석 (${applied}건)`,
        indexLine ? `\n📊 ${indexLine}` : '',
        usLines ? `\n🇺🇸 주요 변동: ${usLines}` : '',
        `\n🇰🇷 한국 종목 점수 보정:`,
        krLines,
        `\n⏱ TTL: 3시간 (09:00~11:35 유효)`,
      ].join('\n');

      await sendTelegramMessage(msg).catch(() => {});
    } else {
      logger.info('[US_RIPPLE] 유의미한 여파 없음 — 보정 스킵', { component: COMP });
    }
  } catch (err) {
    logger.error(`🌊 [US_RIPPLE] 실패: ${err}`, { component: COMP });
  }
}
