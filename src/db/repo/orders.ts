import { config } from '../../config/index.js';
import { isMemoryMode, queryWithRetry } from '../pool.js';
import {
  memGetOrdersByChain,
  memInsertOrder,
  memUpdateOrder,
  memUpdateOrderByKisOrderNo,
} from '../memory-store.js';
import type { Order } from '../models.js';

export async function insertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
  if (isMemoryMode()) return memInsertOrder(order);
  const { rows } = await queryWithRetry(
    `INSERT INTO orders (chain_id, stock_code, side, order_type, quantity, price,
       kis_order_no, kis_status, filled_quantity, filled_price, status, trading_mode,
       trigger_source, ai_reasoning, avg_buy_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      order.chain_id,
      order.stock_code,
      order.side,
      order.order_type,
      order.quantity,
      order.price,
      order.kis_order_no,
      order.kis_status,
      order.filled_quantity,
      order.filled_price,
      order.status,
      order.trading_mode,
      order.trigger_source,
      order.ai_reasoning,
      order.avg_buy_price ?? null,
    ],
  );
  return rows[0].id;
}

const ORDER_ALLOWED_COLS = new Set([
  'chain_id',
  'stock_code',
  'side',
  'order_type',
  'quantity',
  'price',
  'kis_order_no',
  'kis_status',
  'filled_quantity',
  'filled_price',
  'status',
  'trading_mode',
  'trigger_source',
  'ai_reasoning',
  'avg_buy_price',
]);

export async function updateOrder(id: string, updates: Partial<Order>) {
  if (isMemoryMode()) {
    memUpdateOrder(id, updates);
    return;
  }
  const keys = Object.keys(updates).filter((k) => ORDER_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  setClauses.push(`updated_at = NOW()`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await queryWithRetry(`UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1`, [id, ...values]);
}

export async function updateOrderByKisOrderNo(kisOrderNo: string, updates: Partial<Order>) {
  if (isMemoryMode()) {
    memUpdateOrderByKisOrderNo(kisOrderNo, updates);
    return;
  }
  const keys = Object.keys(updates).filter((k) => ORDER_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  setClauses.push(`updated_at = NOW()`);
  const values = keys.map((k) => (updates as Record<string, unknown>)[k]);
  await queryWithRetry(`UPDATE orders SET ${setClauses.join(', ')} WHERE kis_order_no = $1`, [kisOrderNo, ...values]);
}

export async function getOrdersByChain(chainId: string): Promise<Order[]> {
  if (isMemoryMode()) return memGetOrdersByChain(chainId);
  // Fix4: SELECT * → 필요 컬럼만 명시 + Fix6: LIMIT 500 안전가드
  const { rows } = await queryWithRetry(
    `SELECT id, chain_id, stock_code, side, order_type, quantity, price,
            kis_order_no, kis_status, filled_quantity, filled_price, status,
            trading_mode, trigger_source, ai_reasoning, avg_buy_price, created_at, updated_at
     FROM orders WHERE chain_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [chainId],
  );
  return rows;
}

export async function getPendingDomesticOrders(mode?: string): Promise<Order[]> {
  if (isMemoryMode()) return [];
  // 컨텍스트 기반 모드 결정: 명시적 파라미터 > AsyncLocalStorage > 글로벌 폴백
  let tradingMode = mode;
  if (!tradingMode) {
    try {
      const { getCtxIsPaper } = await import('../../config/context.js');
      tradingMode = getCtxIsPaper() ? 'paper' : 'live';
    } catch {
      tradingMode = config.tradingMode;
    }
  }
  // Fix4: SELECT * → 필요 컬럼만 명시
  const { rows } = await queryWithRetry(
    `SELECT id, chain_id, stock_code, side, order_type, quantity, price,
            kis_order_no, kis_status, filled_quantity, filled_price, status,
            trading_mode, trigger_source, ai_reasoning, avg_buy_price, created_at, updated_at
     FROM orders
     WHERE status IN ('PENDING', 'PARTIAL')
       AND (trigger_source IS NULL OR trigger_source != 'OVERSEAS')
       AND created_at >= NOW() - INTERVAL '2 hours'
       AND kis_order_no IS NOT NULL
       AND trading_mode = $1
     ORDER BY created_at ASC`,
    [tradingMode],
  );
  return rows;
}
