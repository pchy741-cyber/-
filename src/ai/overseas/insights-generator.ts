import OpenAI from 'openai';
import { getCtxIsPaper } from '../../config/context.js';
import { getPool } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';

const INSIGHTS_PROMPT = `당신은 알고리즘 트레이딩 퍼포먼스 분석 전문가입니다.
최근 30일 해외주식 자동매매 실적 데이터를 분석하여
다음 매매 사이클을 개선할 3~5가지 실행 가능한 인사이트를 생성하세요.

분석 초점:
1. 어떤 RSI 구간에서 진입 시 승률이 높았나?
2. 어떤 종목/섹터에서 수익이 집중됐나?
3. 평균 보유 시간 — 너무 빨리 팔았나, 너무 오래 들고 있었나?
4. 손실 거래의 공통 패턴은?
5. 앞으로 집중할 전략 조정 포인트

각 인사이트는 구체적 숫자 근거 포함. 한 줄씩, 간결하게.
JSON만 응답: {"insights":["인사이트1","인사이트2",...]}`;

interface TradeRecord {
  code: string;
  pnlPct: number;
  entryRsi: number | null;
  holdingHours: number;
}

async function fetchCompletedTrades(): Promise<TradeRecord[]> {
  const tradingMode = getCtxIsPaper() ? 'paper' : 'live';
  const { rows } = await getPool().query(
    `
    SELECT
      b.stock_code AS code,
      b.filled_price AS buy_price,
      b.created_at  AS bought_at,
      b.ai_reasoning AS buy_reasoning,
      s.filled_price AS sell_price,
      s.created_at  AS sold_at
    FROM orders b
    JOIN LATERAL (
      SELECT filled_price, created_at
      FROM orders
      WHERE stock_code = b.stock_code
        AND side = 'SELL'
        AND status = 'FILLED'
        AND trigger_source = 'OVERSEAS'
        AND (trading_mode = $1::text OR ($1::text = 'paper' AND trading_mode = 'p_arch'))
        AND created_at > b.created_at
        AND filled_price IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
    ) s ON TRUE
    WHERE b.side = 'BUY'
      AND b.status = 'FILLED'
      AND b.trigger_source = 'OVERSEAS'
      AND (b.trading_mode = $1::text OR ($1::text = 'paper' AND b.trading_mode = 'p_arch'))
      AND b.created_at >= NOW() - INTERVAL '30 days'
      AND b.filled_price IS NOT NULL
      AND b.filled_price > 0
    ORDER BY b.created_at DESC
    LIMIT 60
  `,
    [tradingMode],
  );

  return rows.map((r: Record<string, unknown>) => {
    const buyPrice = Number(r.buy_price);
    const sellPrice = Number(r.sell_price);
    const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
    const reasoning = String(r.buy_reasoning ?? '');
    const rsiMatch = reasoning.match(/RSI[=\s]?(\d+)/i);
    const entryRsi = rsiMatch ? Number(rsiMatch[1]) : null;
    const holdingHours =
      (new Date(r.sold_at as string).getTime() - new Date(r.bought_at as string).getTime()) / 3_600_000;
    return { code: String(r.code), pnlPct, entryRsi, holdingHours };
  });
}

function buildSummary(trades: TradeRecord[]): string {
  const wins = trades.filter((t) => t.pnlPct >= 0);
  const losses = trades.filter((t) => t.pnlPct < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);

  // RSI 구간별 성과
  const ranges = [
    { label: 'RSI<50', min: 0, max: 49.9 },
    { label: 'RSI 50-55', min: 50, max: 55 },
    { label: 'RSI 55-60', min: 55.1, max: 60 },
    { label: 'RSI 60-65', min: 60.1, max: 65 },
    { label: 'RSI 65-70', min: 65.1, max: 70 },
    { label: 'RSI>70', min: 70.1, max: 100 },
  ];
  const rsiLines = ranges.flatMap((r) => {
    const bucket = trades.filter((t) => t.entryRsi !== null && t.entryRsi >= r.min && t.entryRsi <= r.max);
    if (bucket.length === 0) return [];
    const w = bucket.filter((t) => t.pnlPct >= 0).length;
    const avg = bucket.reduce((s, t) => s + t.pnlPct, 0) / bucket.length;
    return [
      `  ${r.label}: ${w}/${bucket.length}건 승률${((w / bucket.length) * 100).toFixed(0)}% 평균PnL${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`,
    ];
  });

  // 종목별 성과 (2건 이상)
  const byCode = new Map<string, { wins: number; total: number; pnl: number }>();
  for (const t of trades) {
    const e = byCode.get(t.code) ?? { wins: 0, total: 0, pnl: 0 };
    e.total++;
    e.pnl += t.pnlPct;
    if (t.pnlPct >= 0) e.wins++;
    byCode.set(t.code, e);
  }
  const codeLines = Array.from(byCode.entries())
    .filter(([, v]) => v.total >= 2)
    .sort((a, b) => b[1].pnl / b[1].total - a[1].pnl / a[1].total)
    .map(
      ([code, v]) =>
        `  ${code}: ${v.wins}/${v.total}건 승률${((v.wins / v.total) * 100).toFixed(0)}% 평균PnL${(v.pnl / v.total) >= 0 ? '+' : ''}${(v.pnl / v.total).toFixed(2)}%`,
    );

  const avgWinHold = wins.length > 0 ? wins.reduce((s, t) => s + t.holdingHours, 0) / wins.length : 0;
  const avgLossHold = losses.length > 0 ? losses.reduce((s, t) => s + t.holdingHours, 0) / losses.length : 0;

  return [
    `총 ${trades.length}건 완결 매매 (최근 30일)`,
    `전체 승률 ${((wins.length / trades.length) * 100).toFixed(0)}% (${wins.length}승 ${losses.length}패) | 평균 PnL ${(totalPnl / trades.length) >= 0 ? '+' : ''}${(totalPnl / trades.length).toFixed(2)}%`,
    '',
    '【RSI 진입 구간별 성과】',
    ...rsiLines,
    '',
    '【보유 시간】',
    `수익 거래 평균 ${avgWinHold.toFixed(1)}h | 손실 거래 평균 ${avgLossHold.toFixed(1)}h`,
    '',
    ...(codeLines.length > 0 ? ['【종목별 성과 (2건↑)】', ...codeLines] : []),
  ].join('\n');
}

export async function getAIGeneratedInsights(): Promise<string> {
  try {
    const { rows } = await getPool().query("SELECT value FROM overseas_state WHERE key = 'ai_generated_insights'");
    return rows.length > 0 ? String(rows[0].value) : '';
  } catch {
    return '';
  }
}

export async function generateAndSaveInsights(): Promise<void> {
  const { config } = await import('../../config/index.js');
  if (!config.geminiEnabled) {
    logger.info('💡 인사이트 생성 스킵 (Gemini OFF)', { component: 'INSIGHTS' });
    return;
  }
  try {
    // 4시간 이내 재생성 방지
    const { rows: tsRows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = 'insights_updated_at'",
    );
    if (tsRows.length > 0) {
      const age = Date.now() - new Date(tsRows[0].value as string).getTime();
      if (age < 4 * 60 * 60 * 1000) return;
    }

    const trades = await fetchCompletedTrades();
    if (trades.length < 3) {
      logger.info('💡 인사이트 생성 스킵 — 데이터 부족 (3건 미만)', { component: 'OVERSEAS_INSIGHTS' });
      return;
    }

    const summary = buildSummary(trades);
    const text = await callVertexGemini(INSIGHTS_PROMPT, summary, {
      temperature: 0.2,
      maxOutputTokens: 400,
      label: '해외-인사이트',
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 없음');

    const parsed = JSON.parse(jsonMatch[0]) as { insights?: unknown[] };
    const insights = Array.isArray(parsed.insights) ? parsed.insights.map(String).slice(0, 5) : [];
    if (insights.length === 0) return;

    const value = insights.map((s, i) => `${i + 1}. ${s}`).join('\n');
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ('ai_generated_insights', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [value],
    );
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ('insights_updated_at', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [new Date().toISOString()],
    );
    logger.info(`💡 AI 인사이트 생성 완료 (${insights.length}건): ${insights[0]}`, { component: 'OVERSEAS_INSIGHTS' });
  } catch (e) {
    logger.warn(`AI 인사이트 생성 실패: ${(e as Error).message}`, { component: 'OVERSEAS_INSIGHTS' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 국내(KR) 인사이트 — Track B 완결 거래 기반, GPT-4o-mini로 생성
// ─────────────────────────────────────────────────────────────────────────────

const KR_INSIGHTS_KEY = 'kr_ai_insights';
const KR_INSIGHTS_TS_KEY = 'kr_insights_updated_at';
const KR_SIGNALS_KEY = 'kr_insight_signals';

export interface KRInsightSignals {
  thresholdAdj: number;   // 매수 임계값 보정 (-5 ~ +5, 양수=엄격, 음수=완화)
  updatedAt: string;
}

async function fetchCompletedTradesKR(): Promise<TradeRecord[]> {
  const tradingMode = getCtxIsPaper() ? 'paper' : 'live';
  const { rows } = await getPool().query(
    `
    SELECT
      b.stock_code AS code,
      b.filled_price AS buy_price,
      b.created_at  AS bought_at,
      b.ai_reasoning AS buy_reasoning,
      s.filled_price AS sell_price,
      s.created_at  AS sold_at
    FROM orders b
    JOIN LATERAL (
      SELECT filled_price, created_at
      FROM orders
      WHERE stock_code = b.stock_code
        AND side = 'SELL'
        AND status = 'FILLED'
        AND trigger_source != 'OVERSEAS'
        AND trading_mode = $1
        AND created_at > b.created_at
        AND filled_price IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
    ) s ON TRUE
    WHERE b.side = 'BUY'
      AND b.status = 'FILLED'
      AND b.trigger_source != 'OVERSEAS'
      AND b.trading_mode = $1
      AND b.created_at >= NOW() - INTERVAL '30 days'
      AND b.filled_price IS NOT NULL
      AND b.filled_price > 0
    ORDER BY b.created_at DESC
    LIMIT 60
  `,
    [tradingMode],
  );

  return rows.map((r: Record<string, unknown>) => {
    const buyPrice = Number(r.buy_price);
    const sellPrice = Number(r.sell_price);
    const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
    const reasoning = String(r.buy_reasoning ?? '');
    const rsiMatch = reasoning.match(/RSI[=\s]?(\d+)/i);
    const entryRsi = rsiMatch ? Number(rsiMatch[1]) : null;
    const holdingHours =
      (new Date(r.sold_at as string).getTime() - new Date(r.bought_at as string).getTime()) / 3_600_000;
    return { code: String(r.code), pnlPct, entryRsi, holdingHours };
  });
}

/** 국내 인사이트 신호 조회 — Track B 매수 임계값 보정용 */
export async function getKRInsightSignals(): Promise<KRInsightSignals | null> {
  try {
    const { rows } = await getPool().query(`SELECT value FROM overseas_state WHERE key = $1`, [KR_SIGNALS_KEY]);
    if (rows.length === 0) return null;
    return JSON.parse(String(rows[0].value)) as KRInsightSignals;
  } catch {
    return null;
  }
}

/** 국내 인사이트 조회 (캐시된 것) — Track A GPT scoring 프롬프트에 주입용 */
export async function getKRInsights(): Promise<string> {
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM overseas_state WHERE key = $1`,
      [KR_INSIGHTS_KEY],
    );
    return rows.length > 0 ? String(rows[0].value) : '';
  } catch {
    return '';
  }
}

/** 국내 인사이트 생성 (4시간 간격, GPT-4o-mini 사용) */
export async function generateKRInsights(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  try {
    // 4시간 이내 재생성 방지
    const { rows: tsRows } = await getPool().query(
      `SELECT value FROM overseas_state WHERE key = $1`,
      [KR_INSIGHTS_TS_KEY],
    );
    if (tsRows.length > 0) {
      const age = Date.now() - new Date(tsRows[0].value as string).getTime();
      if (age < 4 * 60 * 60 * 1000) return;
    }

    const trades = await fetchCompletedTradesKR();
    if (trades.length < 3) {
      logger.info('💡 국내 인사이트 스킵 — 데이터 부족 (3건 미만)', { component: 'KR_INSIGHTS' });
      return;
    }

    const summary = buildSummary(trades);
    const client = new OpenAI({ apiKey, timeout: 90_000 });
    let res: import('openai').OpenAI.ChatCompletion | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          stream: false,
          max_tokens: 400,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                '당신은 알고리즘 트레이딩 퍼포먼스 분석 전문가입니다. 최근 30일 국내주식 자동매매 실적을 분석하여 다음 매매 사이클을 개선할 3~5가지 실행 가능한 인사이트를 생성하고, 매수 임계값 조정 신호를 추출하세요.\n\nthresholdAdj 규칙: 정수 -5~+5. 승률>65%이면 -2(진입 완화), 승률<40%이면 +4(더 엄격), 그 외 0. 데이터 부족(10건 미만)이면 0.\n\nJSON만 응답: {"insights":["인사이트1","인사이트2",...],"thresholdAdj":0}',
            },
            { role: 'user', content: summary },
          ],
        });
        break;
      } catch (retryErr) {
        const msg = (retryErr as Error).message ?? '';
        if (attempt < 2 && (msg.includes('Premature close') || msg.includes('ECONNRESET') || msg.includes('timeout'))) {
          logger.warn(`국내 인사이트 재시도 ${attempt + 1}/2 — ${msg}`, { component: 'KR_INSIGHTS' });
          await new Promise((r) => setTimeout(r, (attempt + 1) * 5_000));
          continue;
        }
        throw retryErr;
      }
    }
    if (!res) throw new Error('재시도 소진');

    const text = res.choices[0]?.message?.content ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON 없음');

    const parsed = JSON.parse(jsonMatch[0]) as { insights?: unknown[]; thresholdAdj?: unknown };
    const insights = Array.isArray(parsed.insights) ? parsed.insights.map(String).slice(0, 5) : [];
    if (insights.length === 0) return;

    const rawAdj = typeof parsed.thresholdAdj === 'number' ? parsed.thresholdAdj : 0;
    const thresholdAdj = Math.max(-5, Math.min(5, Math.round(rawAdj)));

    const value = insights.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const signals: KRInsightSignals = { thresholdAdj, updatedAt: new Date().toISOString() };
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [KR_INSIGHTS_KEY, value],
    );
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [KR_SIGNALS_KEY, JSON.stringify(signals)],
    );
    await getPool().query(
      `INSERT INTO overseas_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [KR_INSIGHTS_TS_KEY, new Date().toISOString()],
    );
    logger.info(
      `💡 국내 인사이트 생성 완료 (${insights.length}건, thresholdAdj=${thresholdAdj > 0 ? '+' : ''}${thresholdAdj}): ${insights[0]}`,
      { component: 'KR_INSIGHTS' },
    );
  } catch (e) {
    logger.warn(`국내 인사이트 생성 실패: ${(e as Error).message}`, { component: 'KR_INSIGHTS' });
  }
}
