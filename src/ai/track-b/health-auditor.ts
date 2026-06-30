/**
 * Track B 포트폴리오 헬스 감사관 v1
 *
 * Track B 유휴 시(매도 결정 없을 때)에만 실행.
 * 기존 뉴스/커뮤니티 수집 잡과 완전 분리 — 캐시 읽기만, 재수집 없음.
 *
 * 역할:
 * 1. 오염 신호 탐지: AI 점수 높은데 실제 PnL 음수인 종목
 * 2. 뉴스 위험 감지: 당일 뉴스 중 스코어에 미반영된 부정 신호
 * 3. 손해 악영향 종목 플래그: 지속 손실 + 점수 괴리 종목 → 텔레그램 경보
 *
 * 토큰 정책:
 * - USE_CLAUDE_CLI=true: Claude Max 구독(Sonnet) 사용
 * - API 키 모드: Haiku fallback (비용 최소화)
 * - 쿨다운 20분 — 매 3분 Track B 사이클마다 호출해도 과금 방지
 */

import { getOpenChains, getLatestScores } from '../../db/client.js';
import { getTodayNews } from '../../automation/news-collector.js';
import { callClaudeCli, isClaudeCliEnabled } from '../../utils/claude-cli.js';
import { logTokenUsage, calcClaudeApiCost, calcClaudeCliCost } from '../../utils/ai-token-logger.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';
import { getKSTNow } from '../../utils/time.js';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';

const COMP = 'HEALTH_AUDIT';
const COOLDOWN_MS = 20 * 60 * 1000; // 20분 쿨다운
const MAX_TOKENS = 1500;
const MODEL_API = 'claude-haiku-4-5-20251001';

const _lastRunAt = new Map<'paper' | 'live', number>();

interface AuditFinding {
  contaminated: Array<{ code: string; score: number; pnlPct: number; reason: string }>;
  newsRisk: Array<{ code: string; headline: string; risk: string }>;
  actions: Array<{ code: string; action: 'FLAG_REVIEW' | 'CLEAR_SCOREBLIND'; reason: string }>;
}

/**
 * 포트폴리오 헬스 감사 실행
 * track-b-job.ts에서 filtered.length === 0 일 때 fire-and-forget으로 호출
 */
export async function runPortfolioHealthAudit(modeKey: 'paper' | 'live'): Promise<void> {
  // paper 모드는 스킵 — 가짜 포트폴리오에 Max 토큰 낭비 방지
  if (modeKey === 'paper') return;

  // 쿨다운: 20분 이내 재실행 방지
  const last = _lastRunAt.get(modeKey) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return;
  _lastRunAt.set(modeKey, Date.now());

  logger.info('🔍 포트폴리오 헬스 감사 시작 (Track B 유휴 시간 활용)', { component: COMP });

  try {
    // 1. 오픈 포지션 수집
    const openChains = await getOpenChains(false); // live 모드
    if (openChains.length === 0) {
      logger.info('헬스 감사: 오픈 포지션 없음 — 스킵', { component: COMP });
      return;
    }

    // 2. AI 점수 조회 (기존 캐시)
    const stockCodes = [...new Set(openChains.map((c) => c.stock_code))];
    const scores = await getLatestScores(stockCodes);
    const scoreMap = new Map(scores.map((s) => [s.stock_code, s]));

    // 3. 당일 뉴스 (기존 메모리 캐시만 읽기 — 재수집 안함)
    const newsMap = getTodayNews();

    // 4. 컨텍스트 구성
    const kst = getKSTNow();
    const timeStr = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')} KST`;

    const positionLines = openChains.map((chain) => {
      const avgBuy = Number(chain.avg_buy_price) || 0;
      // current_price may or may not exist on chain — use best available
      const curPrice = (chain as any).current_price ? Number((chain as any).current_price) : 0;
      const pnlPct = avgBuy > 0 && curPrice > 0
        ? (((curPrice - avgBuy) / avgBuy) * 100).toFixed(1)
        : '?';
      const score = scoreMap.get(chain.stock_code);
      const scoreStr = score ? `AI=${score.composite_score?.toFixed(0)}점/${score.signal}` : 'AI=없음';
      const days = chain.opened_at
        ? Math.floor((Date.now() - new Date(chain.opened_at).getTime()) / 86400000)
        : '?';
      return `${chain.stock_code} PnL=${pnlPct}% ${scoreStr} 보유${days}일 ${chain.total_quantity}주`;
    }).join('\n');

    const newsLines: string[] = [];
    for (const code of stockCodes) {
      const items = newsMap.get(code);
      if (!items || items.length === 0) continue;
      const headlines = items.slice(0, 2).map((n) => n.title).join(' / ');
      newsLines.push(`${code}: ${headlines}`);
    }
    const newsBlock = newsLines.length > 0 ? newsLines.join('\n') : '당일 뉴스 없음';

    const systemPrompt = `당신은 퀀트 포트폴리오 감사관입니다. 오픈 포지션의 AI 점수 신뢰성과 뉴스 위험을 분석합니다.
반드시 JSON만 반환하세요. 설명 텍스트 없음.
JSON 형식:
{
  "contaminated": [{"code":"종목코드","score":숫자,"pnlPct":숫자,"reason":"설명"}],
  "newsRisk": [{"code":"종목코드","headline":"뉴스제목","risk":"위험설명"}],
  "actions": [{"code":"종목코드","action":"FLAG_REVIEW|CLEAR_SCOREBLIND","reason":"설명"}]
}`;

    const userPrompt = `현재 시각: ${timeStr}

## 오픈 포지션 (PnL + AI점수)
${positionLines}

## 당일 뉴스 헤드라인
${newsBlock}

분석 기준:
1. 오염 신호: AI 점수 65+ 이면서 PnL -4% 이하 → AI가 틀린 것, contaminated에 추가
2. 뉴스 위험: 부정적 뉴스(하락, 손실, 악재, 규제, 취소, 피해)가 있는 종목 → newsRisk에 추가
3. 즉시 조치: 위 두 조건 모두 해당되는 종목 → actions에 FLAG_REVIEW 추가

오염 없으면 contaminated=[], 뉴스위험 없으면 newsRisk=[], 조치 없으면 actions=[]`;

    // 5. Claude 호출 (Max CLI 또는 API fallback)
    let rawText: string;
    const useCli = isClaudeCliEnabled();

    if (useCli) {
      rawText = await callClaudeCli({
        systemPrompt,
        userPrompt,
        model: 'haiku', // 헬스 감사는 haiku — sonnet은 매매 판단용으로 아끼기
        timeoutMs: 30_000,
      });
      const est = Math.ceil(rawText.length / 4);
      logTokenUsage({
        provider: 'claude-cli', model: 'haiku',
        inputTokens: Math.ceil(userPrompt.length / 4), outputTokens: est,
        costUsd: calcClaudeCliCost(), label: 'health-audit',
      });
    } else {
      const apiKey = config.ai.anthropicKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey.startsWith('your_')) {
        logger.warn('헬스 감사: API 키 없음 — 스킵', { component: COMP });
        return;
      }
      const anthropic = new Anthropic({ apiKey });
      const response = await anthropic.messages.create({
        model: MODEL_API,
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') throw new Error('응답 없음');
      rawText = textBlock.text;
      logTokenUsage({
        provider: 'claude-api', model: 'claude-haiku-4-5',
        inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
        costUsd: calcClaudeApiCost(response.usage.input_tokens, response.usage.output_tokens),
        label: 'health-audit',
      });
    }

    // 6. JSON 파싱
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      logger.warn('헬스 감사: JSON 파싱 실패', { component: COMP });
      return;
    }

    const findings: AuditFinding = JSON.parse(jsonMatch[1]);

    // 7. 결과 로깅
    const totalIssues = findings.contaminated.length + findings.newsRisk.length;
    logger.info(
      `🔍 헬스 감사 완료: 오염신호=${findings.contaminated.length}건, 뉴스위험=${findings.newsRisk.length}건, 조치=${findings.actions.length}건`,
      { component: COMP },
    );

    for (const c of findings.contaminated) {
      logger.warn(
        `🚨 오염신호: ${c.code} AI=${c.score}점 실손익=${c.pnlPct}% — ${c.reason}`,
        { component: COMP },
      );
    }
    for (const n of findings.newsRisk) {
      logger.warn(
        `📰 뉴스위험: ${n.code} "${n.headline}" → ${n.risk}`,
        { component: COMP },
      );
    }

    // 8. 심각한 이슈 텔레그램 알림 (오염 2건 이상 또는 즉시조치 존재)
    if (totalIssues >= 2 || findings.actions.length > 0) {
      const lines: string[] = [`🔍 포트폴리오 헬스 감사 (${timeStr})`];
      if (findings.contaminated.length > 0) {
        lines.push('\n🚨 AI 오염 신호:');
        for (const c of findings.contaminated) {
          lines.push(`  ${c.code} AI=${c.score}점 실PnL=${c.pnlPct}% — ${c.reason}`);
        }
      }
      if (findings.newsRisk.length > 0) {
        lines.push('\n📰 뉴스 위험:');
        for (const n of findings.newsRisk.slice(0, 3)) {
          lines.push(`  ${n.code}: ${n.risk}`);
        }
      }
      if (findings.actions.length > 0) {
        lines.push('\n⚡ 권고 조치:');
        for (const a of findings.actions) {
          lines.push(`  ${a.code} → ${a.action}: ${a.reason}`);
        }
      }
      await sendTelegramMessage(lines.join('\n')).catch(() => {});
    }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`헬스 감사 실패: ${msg}`, { component: COMP });
    // 실패해도 Track B 메인 흐름에 영향 없음
  }
}
