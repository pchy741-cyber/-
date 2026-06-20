/**
 * 📋 Google Sheets 매매일지 자동 백업 — CEO 모바일 확인용
 *
 * 무료: GCP service account (이미 quantops-trading에 있음)
 * 스코프: https://www.googleapis.com/auth/spreadsheets
 *
 * 동작:
 *  - 매일 18:00 KST 어제 매매 → Sheets에 append
 *  - 시트 형식: 날짜 / 종목 / 매수가 / 매도가 / PnL / 사유 / 모드
 *  - GOOGLE_SHEETS_ID env (시트 URL의 ID 부분)
 *
 * Gemini 미관여 — 단순 데이터 export
 */

import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

const COMP = 'SHEETS_JOURNAL';

interface JournalRow {
  closedAt: string;
  market: string;
  stockCode: string;
  stockName: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlPct: number;
  pnlKrw: number;
  closeReason: string;
  tradingMode: string;
}

async function fetchYesterdayTrades(): Promise<JournalRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      tc.closed_at,
      'KR' as market,
      tc.stock_code,
      COALESCE(w.stock_name, tc.stock_code) AS stock_name,
      tc.avg_buy_price,
      (SELECT AVG(o.filled_price) FROM orders o
        WHERE o.chain_id = tc.id AND o.side = 'SELL' AND o.status = 'FILLED' AND o.is_paper = tc.is_paper) AS exit_price,
      tc.total_quantity,
      (tc.realized_pnl / NULLIF(tc.total_invested, 0)) * 100 AS pnl_pct,
      tc.realized_pnl,
      tc.close_reason,
      CASE WHEN tc.is_paper THEN 'paper' ELSE 'live' END AS trading_mode
    FROM transaction_chains tc
    LEFT JOIN watchlist w ON w.stock_code = tc.stock_code
    WHERE tc.status = 'CLOSED'
      AND tc.closed_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul') - INTERVAL '1 day'
      AND tc.closed_at <  DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Seoul')
    ORDER BY tc.closed_at ASC
  `);
  return rows.map((r: Record<string, unknown>) => ({
    closedAt: new Date(r.closed_at as string).toISOString(),
    market: String(r.market ?? 'KR'),
    stockCode: String(r.stock_code ?? ''),
    stockName: String(r.stock_name ?? ''),
    entryPrice: Number(r.avg_buy_price ?? 0),
    exitPrice: Number(r.exit_price ?? 0),
    quantity: Number(r.total_quantity ?? 0),
    pnlPct: Math.round(Number(r.pnl_pct ?? 0) * 100) / 100,
    pnlKrw: Math.round(Number(r.realized_pnl ?? 0)),
    closeReason: String(r.close_reason ?? ''),
    tradingMode: String(r.trading_mode ?? ''),
  }));
}

export async function backupJournalToSheets(): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  if (!sheetId) {
    logger.debug('GOOGLE_SHEETS_ID 미설정 — Sheets 백업 스킵', { component: COMP });
    return;
  }

  try {
    const trades = await fetchYesterdayTrades();
    if (trades.length === 0) {
      logger.info('어제 매매 없음 — Sheets 백업 스킵', { component: COMP });
      return;
    }

    // dynamic import — googleapis 미설치 시 graceful skip
    let google: any;
    try {
      // @ts-expect-error - optional dependency
      const gMod = await import('googleapis');
      google = gMod.google ?? gMod.default?.google;
      if (!google) throw new Error('googleapis 로드 실패');
    } catch (importErr) {
      logger.info(`googleapis 패키지 미설치 — Sheets 백업 스킵 (npm i googleapis로 활성화): ${importErr}`, { component: COMP });
      return;
    }
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 헤더 행 (시트가 비어있을 때만 추가)
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A1:K1',
    });
    if (!headerCheck.data.values || headerCheck.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'A1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [
            ['Closed At', 'Market', 'Code', 'Name', 'Entry', 'Exit', 'Qty', 'PnL %', 'PnL KRW', 'Reason', 'Mode'],
          ],
        },
      });
    }

    // 데이터 append
    const values = trades.map((t) => [
      t.closedAt,
      t.market,
      t.stockCode,
      t.stockName,
      t.entryPrice,
      t.exitPrice,
      t.quantity,
      t.pnlPct,
      t.pnlKrw,
      t.closeReason,
      t.tradingMode,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'A:K',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    logger.info(`📋 Sheets 일지 백업: ${trades.length}건 추가`, { component: COMP });
  } catch (e) {
    logger.warn(`Sheets 백업 실패: ${e instanceof Error ? e.message : String(e)}`, { component: COMP });
  }
}
