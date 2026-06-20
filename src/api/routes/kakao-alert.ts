/**
 * 카카오페이 주식 알림 Webhook
 *
 * 사용법 (Android Tasker / MacroDroid):
 *   알림 앱 = "카카오페이" 감지 → HTTP POST /api/kakao-alert
 *   Body: { "app": "카카오페이", "title": "...", "text": "알림 내용" }
 *
 * 동작:
 *   1. 알림 텍스트에서 종목명/종목코드 추출
 *   2. AI 점수 조회 (80점+ 시에만 매수 후보 등록)
 *   3. 텔레그램 알림 발송 + 선택적 자동매수 트리거
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { getScoreBasedParams, STRATEGY_PARAMS } from '../../config/constants.js';
import { config } from '../../config/index.js';
import { getCtxIsPaper } from '../../config/context.js';
import { createChain, getOpenChains, getPool, logSystem } from '../../db/client.js';
import { invalidateBalanceCache } from '../../kis/account.js';
import { getCurrentPrice } from '../../kis/market.js';
import { notifyBuy } from '../../notifications/web-push.js';
import { addPaperInvestment, getPaperBalance } from '../../risk/engine.js';
import { sendTelegramMessage } from '../../notifications/telegram.js';
import { logger } from '../../utils/logger.js';

export const kakaoAlertRoutes = new Hono();

// 종목명 → 코드 매핑 (주요 종목만, 나머지는 텍스트 파싱)
const NAME_TO_CODE: Record<string, string> = {
  삼성전자: '005930',
  SK하이닉스: '000660',
  현대차: '005380',
  기아: '000270',
  LG에너지솔루션: '373220',
  삼성바이오로직스: '207940',
  KB금융: '105560',
  신한지주: '055550',
  하나금융지주: '086790',
  NAVER: '035420',
  카카오: '035720',
  셀트리온: '068270',
  삼성SDI: '006400',
  LG화학: '051910',
  POSCO홀딩스: '005490',
  현대모비스: '012330',
  LG전자: '066570',
  SK이노베이션: '096770',
  한화에어로스페이스: '012450',
  HD현대중공업: '329180',
  HD한국조선해양: '009540',
  한국항공우주: '047810',
  LIG넥스원: '079550',
  현대로템: '064350',
  HPSP: '403870',
  알테오젠: '196170',
  리노공업: '058470',
  테이팩스: '055490',
};

/** 알림 텍스트에서 종목명/코드 추출 */
function parseStockFromText(text: string): { code: string; name: string } | null {
  // 1. [종목명] 패턴
  const bracketMatch = text.match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    const name = bracketMatch[1].trim();
    const code = NAME_TO_CODE[name];
    if (code) return { code, name };
  }

  // 2. 6자리 숫자 코드 직접 포함 (e.g. "005930")
  const codeMatch = text.match(/\b(\d{6})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    const name = Object.entries(NAME_TO_CODE).find(([, c]) => c === code)?.[0] ?? code;
    return { code, name };
  }

  // 3. 알려진 종목명 검색
  for (const [name, code] of Object.entries(NAME_TO_CODE)) {
    if (text.includes(name)) return { code, name };
  }

  return null;
}

/** 알림 신호 유형 분류 */
function classifySignal(text: string): 'BUY_TARGET' | 'LOSS_ALERT' | 'PRICE_ALERT' | 'UNKNOWN' {
  if (/목표가|상한가|돌파|급등|52주|신고가/.test(text)) return 'BUY_TARGET';
  if (/하락|손절|급락|-[3-9]%|-[1-9][0-9]%|저점|위험/.test(text)) return 'LOSS_ALERT';
  if (/현재가|알림가|도달/.test(text)) return 'PRICE_ALERT';
  return 'UNKNOWN';
}

kakaoAlertRoutes.post('/kakao-alert', async (c) => {
  // ── 인증: X-Webhook-Secret 헤더 검증 (Tasker에서 동일 시크릿 설정 필요) ──
  const webhookSecret = process.env.KAKAO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Webhook secret not configured — reject all requests for security
    logger.warn(`[KAKAO_ALERT] KAKAO_WEBHOOK_SECRET 미설정 — 요청 거부`, { component: 'KAKAO' });
    return c.json({ error: 'webhook secret not configured' }, 503);
  }
  const provided = c.req.header('X-Webhook-Secret') ?? '';
  // Timing-safe comparison to prevent timing attacks
  const secretBuf = Buffer.from(webhookSecret, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  const lenMatch = secretBuf.length === providedBuf.length;
  // Use fixed-length buffers to avoid length-based timing leaks
  const FIXED_LEN = 256;
  const sBuf = Buffer.alloc(FIXED_LEN);
  const pBuf = Buffer.alloc(FIXED_LEN);
  secretBuf.copy(sBuf, 0, 0, Math.min(secretBuf.length, FIXED_LEN));
  providedBuf.copy(pBuf, 0, 0, Math.min(providedBuf.length, FIXED_LEN));
  if (!lenMatch || !timingSafeEqual(sBuf, pBuf)) {
    logger.warn(`[KAKAO_ALERT] 인증 실패 — 잘못된 시크릿`, { component: 'KAKAO' });
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: { app?: string; title?: string; text?: string; package?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const rawText = `${body.title ?? ''} ${body.text ?? ''}`.trim();
  if (!rawText) return c.json({ ok: false, reason: 'empty text' });

  logger.info(`[KAKAO_ALERT] 수신: ${rawText.slice(0, 100)}`, { component: 'KAKAO' });

  const stock = parseStockFromText(rawText);
  const signal = classifySignal(rawText);

  await logSystem(
    'INFO',
    'KAKAO_ALERT',
    `알림수신: ${rawText.slice(0, 80)} | 종목=${stock?.code ?? '?'} 신호=${signal}`,
  );

  if (!stock) {
    logger.info(`[KAKAO_ALERT] 종목 추출 실패 — 무시: ${rawText.slice(0, 60)}`, { component: 'KAKAO' });
    return c.json({ ok: true, parsed: false, reason: '종목 파싱 불가' });
  }

  // AI 점수 + 열린 포지션 조회
  const [scoreRows, openChains] = await Promise.all([
    getPool()
      .query('SELECT composite_score, confidence FROM ai_scores WHERE stock_code=$1 ORDER BY score_date DESC LIMIT 1', [
        stock.code,
      ])
      .then((r) => r.rows[0] ?? null)
      .catch(() => null),
    getOpenChains(getCtxIsPaper()).catch(() => [] as import('../../db/models.js').TransactionChain[]),
  ]);

  const aiEntry = scoreRows;
  const aiScore = Number(aiEntry?.composite_score ?? 0);
  const confidence = Number(aiEntry?.confidence ?? 0);
  const alreadyOpen = openChains.some((c) => c.stock_code === stock.code);

  let action = '관망';
  let emoji = '👀';

  if (signal === 'BUY_TARGET' && aiScore >= 80 && confidence >= 0.65 && !alreadyOpen) {
    action = '★ 매수 후보 (조건충족)';
    emoji = '🚀';

    // 연습모드: 3분 파이프라인 대기 없이 즉시 매수 실행
    if (getCtxIsPaper()) {
      try {
        const priceData = await getCurrentPrice(stock.code);
        const curPrice = priceData.currentPrice;
        if (curPrice && curPrice > 0) {
          const balance = await getPaperBalance();
          const totalCapital = balance.totalEvalAmount + balance.orderableCash;
          const { stopLossPct, takeProfitPct } = getScoreBasedParams(aiScore);
          const slFraction = Math.abs(stopLossPct) / 100;
          const computed = Math.round((totalCapital * 0.015) / slFraction);
          const dynCap = Math.round(totalCapital * 0.05); // 카카오 이벤트 매수: 최대 5% 비중
          const amount_krw = Math.max(Math.min(computed, dynCap), 10000);
          const quantity = Math.floor(amount_krw / curPrice);
          if (quantity >= 1) {
            const fakeOrderNo = `KKO${Date.now().toString(36).toUpperCase()}`;
            const chainId = await createChain({
              stock_code: stock.code,
              status: 'OPEN',
              strategy_mode: 'SWING',
              avg_buy_price: curPrice,
              total_quantity: quantity,
              total_invested: quantity * curPrice,
              realized_pnl: 0,
              target_profit_pct: takeProfitPct,
              stop_loss_pct: stopLossPct,
              max_averaging_count: STRATEGY_PARAMS.SWING.maxAveragingCount,
              current_averaging_count: 0,
              is_paper: true,
            });
            await getPool().query(
              `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price, filled_quantity, filled_price, kis_order_no, status, trading_mode, trigger_source, ai_reasoning)
               VALUES ($1, $2, 'BUY', 'MARKET', $3, $4, $3, $4, $5, 'FILLED', 'paper', 'KAKAO', $6)`,
              [
                chainId,
                stock.code,
                quantity,
                curPrice,
                fakeOrderNo,
                `카카오알림 즉시매수 AI${aiScore}점 conf=${confidence.toFixed(2)}`,
              ],
            );
            addPaperInvestment(quantity * curPrice);
            invalidateBalanceCache();
            action = `✅ 즉시매수 완료 (${quantity}주 @${curPrice.toLocaleString()}원)`;
            emoji = '✅';
            await notifyBuy(
              stock.code,
              quantity,
              curPrice,
              `카카오알림 즉시매수 AI${aiScore}점`,
            ).catch(() => {});
          }
        }
      } catch (e) {
        logger.warn(`[KAKAO_ALERT] 즉시매수 실패 (Telegram만 발송): ${e}`, { component: 'KAKAO' });
      }
    }
  } else if (signal === 'BUY_TARGET' && aiScore >= 70 && !alreadyOpen) {
    action = '매수 검토 (점수 낮음)';
    emoji = '📊';
  } else if (signal === 'LOSS_ALERT' && alreadyOpen) {
    action = '⚠️ 보유 중 하락 알림';
    emoji = '🔴';
  } else if (alreadyOpen) {
    action = '보유 중';
    emoji = '📌';
  }

  const msg =
    `${emoji} <b>카카오페이 알림</b>\n` +
    `종목: ${stock.name} (${stock.code})\n` +
    `신호: ${signal}\n` +
    `AI점수: ${aiScore}점 conf=${confidence.toFixed(2)}\n` +
    `판단: ${action}\n` +
    `원문: ${rawText.slice(0, 80)}`;

  await sendTelegramMessage(msg).catch(() => {});

  logger.info(`[KAKAO_ALERT] ${stock.name}(${stock.code}) ${signal} AI=${aiScore} → ${action}`, { component: 'KAKAO' });

  return c.json({
    ok: true,
    parsed: true,
    stock: stock.code,
    signal,
    aiScore,
    action,
  });
});

/** 테스트용: 알림 파싱만 확인 (실제 실행 없음) */
kakaoAlertRoutes.post('/kakao-alert/test', async (c) => {
  const webhookSecret2 = process.env.KAKAO_WEBHOOK_SECRET;
  if (!webhookSecret2) {
    return c.json({ error: 'webhook secret not configured' }, 503);
  }
  const provided2 = c.req.header('X-Webhook-Secret') ?? '';
  const sBuf2 = Buffer.from(webhookSecret2, 'utf8');
  const pBuf2 = Buffer.from(provided2, 'utf8');
  const FIXED2 = 256;
  const s2 = Buffer.alloc(FIXED2);
  const p2 = Buffer.alloc(FIXED2);
  sBuf2.copy(s2, 0, 0, Math.min(sBuf2.length, FIXED2));
  pBuf2.copy(p2, 0, 0, Math.min(pBuf2.length, FIXED2));
  if (sBuf2.length !== pBuf2.length || !timingSafeEqual(s2, p2)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: { text?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid' }, 400);
  }
  const text = body.text ?? '';
  const stock = parseStockFromText(text);
  const signal = classifySignal(text);
  return c.json({ stock, signal, text });
});
