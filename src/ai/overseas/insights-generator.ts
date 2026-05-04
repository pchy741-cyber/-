import { getPool } from '../../db/client.js';
import { callVertexGemini } from '../../utils/vertex-gemini.js';
import { logger } from '../../utils/logger.js';

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
  const { rows } = await getPool().query(`
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
        AND created_at > b.created_at
        AND filled_price IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
    ) s ON TRUE
    WHERE b.side = 'BUY'
      AND b.status = 'FILLED'
      AND b.trigger_source = 'OVERSEAS'
      AND b.created_at >= NOW() - INTERVAL '30 days'
      AND b.filled_price IS NOT NULL
      AND b.filled_price > 0
    ORDER BY b.created_at DESC
    LIMIT 60
  `);

  return rows.map((r: Record<string, unknown>) => {
    const buyPrice = Number(r.buy_price);
    const sellPrice = Number(r.sell_price);
    const pnlPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
    const reasoning = String(r.buy_reasoning ?? '');
    const rsiMatch = reasoning.match(/RSI[=\s]?(\d+)/i);
    const entryRsi = rsiMatch ? Number(rsiMatch[1]) : null;
    const holdingHours = (new Date(r.sold_at as string).getTime() - new Date(r.bought_at as string).getTime()) / 3_600_000;
    return { code: String(r.code), pnlPct, entryRsi, holdingHours };
  });
}

function buildSummary(trades: TradeRecord[]): string {
  const wins = trades.filter(t => t.pnlPct >= 0);
  const losses = trades.filter(t => t.pnlPct < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);

  // RSI 구간별 성과
  const ranges = [
    { label: 'RSI<50',    min: 0,    max: 49.9 },
    { label: 'RSI 50-55', min: 50,   max: 55   },
    { label: 'RSI 55-60', min: 55.1, max: 60   },
    { label: 'RSI 60-65', min: 60.1, max: 65   },
    { label: 'RSI 65-70', min: 65.1, max: 70   },
    { label: 'RSI>70',    min: 70.1, max: 100  },
  ];
  const rsiLines = ranges.flatMap(r => {
    const bucket = trades.filter(t => t.entryRsi !== null && t.entryRsi >= r.min && t.entryRsi <= r.max);
    if (bucket.length === 0) return [];
    const w = bucket.filter(t => t.pnlPct >= 0).length;
    const avg = bucket.reduce((s, t) => s + t.pnlPct, 0) / bucket.length;
    return [`  ${r.label}: ${w}/${bucket.length}건 승률${((w / bucket.length) * 100).toFixed(0)}% 평균PnL${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`];
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
    .sort((a, b) => (b[1].pnl / b[1].total) - (a[1].pnl / a[1].total))
    .map(([code, v]) => `  ${code}: ${v.wins}/${v.total}건 승률${((v.wins / v.total) * 100).toFixed(0)}% 평균PnL${(v.pnl / v.total) >= 0 ? '+' : ''}${(v.pnl / v.total).toFixed(2)}%`);

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
    const { rows } = await getPool().query(
      "SELECT value FROM overseas_state WHERE key = 'ai_generated_insights'",
    );
    return rows.length > 0 ? String(rows[0].value) : '';
  } catch { return ''; }
}

export async function generateAndSaveInsights(): Promise<void> {
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
    const text = await callVertexGemini(INSIGHTS_PROMPT, summary, { temperature: 0.2, maxOutputTokens: 400 });

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
