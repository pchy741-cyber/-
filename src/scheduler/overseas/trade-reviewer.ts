/**
 * AI 자기진화 — 매매 복기
 * Gemini를 활용해 완료된 매매를 복기하고, 교훈 축적 및 섹터별 confidence 조정
 */

import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';

// ── 타입 ──

interface TradeReview {
  code: string;
  pnlPct: number;
  entryReason: string;
  exitReason: string;
  review: string; // Gemini 복기
  lesson: string; // 핵심 교훈
  parameterAdj?: {
    // 파라미터 조정 제안
    sectorConfAdj?: number; // 섹터별 confidence 조정
    sector?: string;
  };
}

// ── 쿨다운 캐시 (같은 종목 1시간 내 중복 복기 방지) ──
const _reviewCooldown = new Map<string, number>();
const REVIEW_COOLDOWN_MS = 60 * 60_000; // 1시간

// ── 섹터 confidence 조정 캐시 (30분) ──
const _sectorAdjCache = new Map<string, { adj: number; fetchedAt: number }>();
const SECTOR_ADJ_CACHE_TTL = 30 * 60_000; // 30분

/**
 * 매도 완료 후 호출 — Gemini로 복기
 * - 프롬프트: 매매 데이터 → 1줄 교훈 + confidence 조정 제안 JSON
 * - DB 저장: overseas_state 테이블 (`trade_review_{code}_{timestamp}`)
 * - 쿨다운: 같은 종목 1시간 내 중복 복기 방지
 */
export async function reviewCompletedTrade(params: {
  code: string;
  sector: string;
  pnlPct: number;
  holdingDays: number;
  entryReason: string;
  exitReason: string;
  entryRsi: number;
  exitRsi: number;
}): Promise<void> {
  const { code, sector, pnlPct, holdingDays, entryReason, exitReason, entryRsi, exitRsi } = params;

  try {
    // 쿨다운 체크
    const lastReview = _reviewCooldown.get(code);
    if (lastReview && Date.now() - lastReview < REVIEW_COOLDOWN_MS) {
      logger.info(`[TradeReview] ${code} 쿨다운 중 (1시간 내 복기 완료)`, { component: 'OVERSEAS' });
      return;
    }

    // 규칙기반 복기 (Gemini OFF 대응) 또는 Gemini 복기
    const { config: appCfg } = await import('../../config/index.js');
    let rawResponse = '';

    if (appCfg.geminiEnabled) {
      const systemPrompt = `당신은 주식 매매 복기 전문가입니다. 매매 결과를 분석하고 개선점을 제시합니다.
반드시 아래 JSON 형식으로만 응답하세요:
{"lesson": "1줄 교훈", "sectorConfAdj": 0.00}
- lesson: 이 매매에서 배울 수 있는 핵심 교훈 (한국어, 1줄)
- sectorConfAdj: 해당 섹터 confidence 임계치 조정값 (-0.05 ~ +0.05)
  - 손실 매매: 양수(+) → 더 보수적으로
  - 수익 매매: 음수(-) → 약간 공격적으로
  - 정상 범위: 0`;

      const userMessage = `매매 복기 요청:
- 종목: ${code} (섹터: ${sector})
- 수익률: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%
- 보유일: ${holdingDays.toFixed(0)}일
- 진입 사유: ${entryReason}
- 청산 사유: ${exitReason}
- 진입 RSI: ${entryRsi.toFixed(0)} → 청산 RSI: ${exitRsi.toFixed(0)}
- 결과: ${pnlPct > 0 ? '수익' : '손실'}`;

      rawResponse = await callVertexGemini(systemPrompt, userMessage, {
        temperature: 0.3,
        maxOutputTokens: 300,
        label: '해외-매매복기',
      });
    } else {
      // 규칙기반 복기 — 통계적 교훈 자동 생성
      const adj = pnlPct < -5 ? 0.03 : pnlPct < 0 ? 0.01 : pnlPct > 10 ? -0.02 : 0;
      const les =
        pnlPct < 0 && entryRsi > 65
          ? '고RSI 진입 패턴 — confidence 상향 필요'
          : pnlPct < 0
            ? `손실 ${pnlPct.toFixed(1)}% — ${exitReason}`
            : `수익 +${pnlPct.toFixed(1)}% (${holdingDays.toFixed(0)}일) — 정상`;
      rawResponse = JSON.stringify({ lesson: les, sectorConfAdj: adj });
    }

    // JSON 파싱
    let lesson = '복기 완료';
    let sectorConfAdj = 0;
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        lesson = parsed.lesson || lesson;
        sectorConfAdj = Math.max(-0.05, Math.min(0.05, Number(parsed.sectorConfAdj) || 0));
      }
    } catch {
      // JSON 파싱 실패 시 원본 텍스트를 교훈으로 사용
      lesson = rawResponse.slice(0, 100);
    }

    const review: TradeReview = {
      code,
      pnlPct,
      entryReason,
      exitReason,
      review: rawResponse.slice(0, 200),
      lesson,
      parameterAdj: sectorConfAdj !== 0 ? { sectorConfAdj, sector } : undefined,
    };

    // DB 저장
    const timestamp = Date.now();
    await getPool()
      .query(
        `INSERT INTO overseas_state (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
        [`trade_review_${code}_${timestamp}`, JSON.stringify(review)],
      )
      .catch(() => {});

    // 쿨다운 설정
    _reviewCooldown.set(code, Date.now());

    // 만료된 쿨다운 정리
    for (const [k, v] of _reviewCooldown) {
      if (Date.now() - v > REVIEW_COOLDOWN_MS) _reviewCooldown.delete(k);
    }

    // v10.8: 최근 50건만 유지, 나머지 정리 (DB 무한 팽창 방지)
    getPool()
      .query(
        `DELETE FROM overseas_state WHERE key LIKE 'trade_review_%'
         AND key NOT IN (SELECT key FROM overseas_state WHERE key LIKE 'trade_review_%' ORDER BY key DESC LIMIT 50)`,
      )
      .catch(() => {});

    logger.info(
      `[TradeReview] ${code} ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}% → "${lesson}" (confAdj=${sectorConfAdj > 0 ? '+' : ''}${sectorConfAdj.toFixed(2)})`,
      { component: 'OVERSEAS' },
    );
  } catch (err: any) {
    logger.warn(`매매 복기 실패(${code}): ${err.message}`, { component: 'OVERSEAS' });
  }
}

/**
 * 누적 교훈 조회 — overseas-job AI 컨텍스트에 삽입
 * 최근 10건의 교훈을 요약 문자열로 반환
 */
export async function getTradeReviewInsights(): Promise<string> {
  try {
    const { rows } = await getPool().query(`
      SELECT key, value FROM overseas_state
      WHERE key LIKE 'trade_review_%'
      ORDER BY key DESC
      LIMIT 10
    `);

    if (rows.length === 0) return '';

    const lessons: string[] = [];
    for (const row of rows) {
      try {
        const review = JSON.parse(row.value) as TradeReview;
        const prefix = review.pnlPct > 0 ? '+' : '';
        lessons.push(`${review.code}(${prefix}${review.pnlPct.toFixed(1)}%): ${review.lesson}`);
      } catch {
        /* skip malformed */
      }
    }

    if (lessons.length === 0) return '';

    return `[최근 매매 교훈 ${lessons.length}건]\n${lessons.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * 섹터별 confidence 조정값 조회
 * - 최근 5건 해당 섹터 매매 결과 기반
 * - 3연패 이상 → +0.05 (더 보수적)
 * - 3연승 이상 → -0.03 (약간 공격적)
 */
export async function getSectorConfidenceAdj(sector: string): Promise<number> {
  // 캐시 체크
  const cached = _sectorAdjCache.get(sector);
  if (cached && Date.now() - cached.fetchedAt < SECTOR_ADJ_CACHE_TTL) {
    return cached.adj;
  }

  try {
    const { rows } = await getPool().query(`
      SELECT value FROM overseas_state
      WHERE key LIKE 'trade_review_%'
      ORDER BY key DESC
      LIMIT 50
    `);

    // 해당 섹터 매매만 필터
    const sectorReviews: TradeReview[] = [];
    for (const row of rows) {
      try {
        const review = JSON.parse(row.value) as TradeReview;
        if (review.parameterAdj?.sector === sector) {
          sectorReviews.push(review);
          if (sectorReviews.length >= 5) break;
        }
      } catch {
        /* skip */
      }
    }

    if (sectorReviews.length < 3) {
      _sectorAdjCache.set(sector, { adj: 0, fetchedAt: Date.now() });
      return 0;
    }

    // 연속 손실/수익 판정
    const consecutive = sectorReviews.slice(0, 5);
    const allLoss = consecutive.length >= 3 && consecutive.slice(0, 3).every((r) => r.pnlPct < 0);
    const allWin = consecutive.length >= 3 && consecutive.slice(0, 3).every((r) => r.pnlPct > 0);

    let adj = 0;
    if (allLoss) {
      adj = 0.05; // 3연패 → 더 보수적
      logger.info(`[TradeReview] ${sector} 3연패 → confidence +0.05 (보수적)`, { component: 'OVERSEAS' });
    } else if (allWin) {
      adj = -0.03; // 3연승 → 약간 공격적
      logger.info(`[TradeReview] ${sector} 3연승 → confidence -0.03 (공격적)`, { component: 'OVERSEAS' });
    }

    _sectorAdjCache.set(sector, { adj, fetchedAt: Date.now() });
    return adj;
  } catch {
    return 0;
  }
}
