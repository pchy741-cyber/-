/**
 * 프론트엔드 → 백엔드 API 호출 유틸리티
 */

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error ?? `API 에러: ${res.status}`);
  }

  return res.json();
}

// ── 대시보드 ──
export const api = {
  getDashboard: () => request('/dashboard'),
  getHealth: () => request('/health'),

  // 감시 목록
  getWatchlist: () => request('/watchlist'),
  addWatchlist: (stockCode: string, stockName: string, market = 'KOSPI') =>
    request('/watchlist', {
      method: 'POST',
      body: JSON.stringify({ stock_code: stockCode, stock_name: stockName, market }),
    }),
  removeWatchlist: (stockCode: string) =>
    request(`/watchlist/${stockCode}`, { method: 'DELETE' }),

  // 매매 기록
  getTrades: (limit = 50) => request(`/trades?limit=${limit}`),

  // 시스템 로그
  getLogs: (limit = 100, component?: string) =>
    request(`/logs?limit=${limit}${component ? `&component=${component}` : ''}`),

  // Kill Switch
  getKillSwitch: () => request('/kill-switch'),
  activateKillSwitch: (reason: string) =>
    request('/kill-switch/activate', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  deactivateKillSwitch: () =>
    request('/kill-switch/deactivate', { method: 'POST' }),

  // 전략 설정
  getStrategy: () => request('/strategy'),
  updateStrategy: (config: {
    mode: string;
    gemini_prompt: string;
    gpt_prompt: string;
    claude_prompt: string;
    buy_threshold?: number;
    stop_loss_pct?: number;
    take_profit_pct?: number;
  }) => request('/strategy', { method: 'PUT', body: JSON.stringify(config) }),

  // 수동 Track A 실행
  runTrackA: (sources?: string) =>
    request('/run-track-a', {
      method: 'POST',
      body: JSON.stringify({ sources }),
    }),
};
