/**
 * 패턴 피드백 자동 적용 (#5)
 *
 * learned_insights 테이블의 고신뢰도 인사이트를 overseas_state에 저장 →
 * 매수/매도 로직에서 자동 반영
 *
 * 매일 19:55 실행 (자기학습 + Trade Tuner + Analytics Hub 후)
 */
import { getPool } from '../db/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';
import { setOverseasState } from '../scheduler/overseas/utils.js';

const COMP = 'PATTERN_APPLY';

interface PatternOverride {
  avoidSectors: string[]; // LOSS_PATTERN 섹터 → 매수 회피
  boostSectors: string[]; // WIN_PATTERN 섹터 → 매수 우선
  avoidStocks: string[]; // 반복 손실 종목 → 쿨다운 강화
  boostStocks: string[]; // 고승률 종목 → 적극 진입
  sizingHints: Array<{ sector: string; adjustment: number; reason: string }>;
  appliedAt: string;
  insightCount: number;
}

export async function runPatternAutoApply(isPaper = true): Promise<void> {
  const mode = isPaper ? 'paper' : 'live';
  logger.info(`🔄 패턴 자동적용 시작 (${mode})`, { component: COMP });

  try {
    // 고신뢰도 인사이트 조회 (confidence >= 0.70, sample_count >= 5)
    const { rows } = await getPool().query(
      `SELECT category, insight, confidence, sample_count, details
       FROM learned_insights
       WHERE is_paper = $1 AND confidence >= 0.70 AND sample_count >= 5
         AND insight LIKE '[해외]%'
       ORDER BY confidence DESC, sample_count DESC
       LIMIT 30`,
      [isPaper],
    );

    if (rows.length === 0) {
      logger.info(`⏭️ 패턴 자동적용 스킵 — 인사이트 없음 (${mode})`, { component: COMP });
      return;
    }

    const overrides: PatternOverride = {
      avoidSectors: [],
      boostSectors: [],
      avoidStocks: [],
      boostStocks: [],
      sizingHints: [],
      appliedAt: new Date().toISOString(),
      insightCount: rows.length,
    };

    for (const r of rows) {
      const category = String(r.category);
      const details = r.details ?? {};
      const confidence = Number(r.confidence);

      if (category === 'LOSS_PATTERN') {
        if (details.sector && confidence >= 0.75) {
          if (!overrides.avoidSectors.includes(details.sector)) {
            overrides.avoidSectors.push(details.sector);
          }
        }
        if (details.code && confidence >= 0.70) {
          if (!overrides.avoidStocks.includes(details.code)) {
            overrides.avoidStocks.push(details.code);
          }
        }
      }

      if (category === 'WIN_PATTERN') {
        if (details.sector && confidence >= 0.75) {
          if (!overrides.boostSectors.includes(details.sector)) {
            overrides.boostSectors.push(details.sector);
          }
        }
        if (details.code && confidence >= 0.75) {
          if (!overrides.boostStocks.includes(details.code)) {
            overrides.boostStocks.push(details.code);
          }
        }
      }

      if (category === 'SIZING' && details.bestSector && details.worstSector) {
        overrides.sizingHints.push({
          sector: details.bestSector,
          adjustment: 1.2,
          reason: `${details.bestSector} 우위 (승률 ${((details.bestWinRate ?? 0) * 100).toFixed(0)}%)`,
        });
        overrides.sizingHints.push({
          sector: details.worstSector,
          adjustment: 0.7,
          reason: `${details.worstSector} 열위 (승률 ${((details.worstWinRate ?? 0) * 100).toFixed(0)}%)`,
        });
      }
    }

    // overseas_state 저장
    const stateKey = `pattern_overrides_${mode}`;
    await setOverseasState(stateKey, JSON.stringify(overrides));

    // 리포트
    const applied = overrides.avoidSectors.length + overrides.boostSectors.length +
                    overrides.avoidStocks.length + overrides.boostStocks.length +
                    overrides.sizingHints.length;
    if (applied > 0) {
      const lines = [`🔄 패턴 자동적용 (${mode}) — ${rows.length}개 인사이트 → ${applied}개 오버라이드`];
      if (overrides.avoidSectors.length > 0) lines.push(`  ⛔ 회피 섹터: ${overrides.avoidSectors.join(', ')}`);
      if (overrides.boostSectors.length > 0) lines.push(`  ✅ 우선 섹터: ${overrides.boostSectors.join(', ')}`);
      if (overrides.avoidStocks.length > 0) lines.push(`  ⛔ 회피 종목: ${overrides.avoidStocks.join(', ')}`);
      if (overrides.boostStocks.length > 0) lines.push(`  ✅ 우선 종목: ${overrides.boostStocks.join(', ')}`);
      if (overrides.sizingHints.length > 0) lines.push(`  📊 사이징: ${overrides.sizingHints.length}개 조정`);

      const report = lines.join('\n');
      logger.info(report, { component: COMP });
      await sendTelegramMessage(report).catch(() => {});
    }
  } catch (e: any) {
    logger.error(`패턴 자동적용 실패: ${e.message}`, { component: COMP });
  }
}

/** 매수 필터에서 호출: 패턴 오버라이드 조회 (30분 캐시) */
const _patternCache: Record<string, { data: PatternOverride | null; expiresAt: number }> = {};
const PATTERN_CACHE_TTL = 30 * 60_000;

export async function getPatternOverrides(isPaper = true): Promise<PatternOverride | null> {
  const mode = isPaper ? 'paper' : 'live';
  const cached = _patternCache[mode];
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const raw = await (await import('../scheduler/overseas/utils.js')).getOverseasState(`pattern_overrides_${mode}`);
    const data = raw ? JSON.parse(raw) as PatternOverride : null;
    _patternCache[mode] = { data, expiresAt: Date.now() + PATTERN_CACHE_TTL };
    return data;
  } catch {
    return null;
  }
}
