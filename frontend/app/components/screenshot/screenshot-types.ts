export type Tab = 'home' | 'trades' | 'journal' | 'watchlist' | 'news' | 'settings' | 'dividend' | 'strategy-lab';

export interface LoopStatus {
  active: boolean;
  phase: 'REVIEWING' | 'TRADING' | 'PAUSED' | 'STOPPED';
  totalRuns: number;
  lastRunAt: string | null;
  lastRunResult: 'ok' | 'error' | 'skipped' | null;
  startedAt: string | null;
  adaptiveIntervalMs: number;
  consecutiveErrors: number;
  marketPhase: 'PREMARKET' | 'OPEN_VOLATILE' | 'PRIME' | 'MIDDAY' | 'LUNCH' | 'POWER_HOUR' | 'CLOSED';
  brief: { regime: string; risk: string; narrative: string } | null;
  openMarkets: string[];
  anyMarketOpen: boolean;
  autoPilot?: { overridesSet: number; decisions: string[]; lastRunAt: string | null } | null;
}

export interface CopilotData {
  timestamp: string;
  mode: string;
  integrity: { id: string; status: 'ok' | 'warn' | 'danger'; label: string; detail: string }[];
  risk: { id: string; label: string; value: number; max: number; unit: string; level: 'ok' | 'warn' | 'danger' }[];
  actions: { type: string; icon: string; title: string; detail: string; urgency: 'high' | 'mid' | 'low' }[];
}

export interface XrayCheck {
  id: string;
  status: 'ok' | 'warn' | 'danger';
  label: string;
  detail: string;
}

export interface XrayData {
  ts: string;
  mode: string;
  summary: { danger: number; warn: number; ok: number; total: number };
  checks: XrayCheck[];
}

export interface ScreenshotProps {
  currentTab: Tab;
  setTab: (tab: Tab) => void;
  viewMode: 'live' | 'paper';
  switchViewMode: (mode: 'live' | 'paper') => void;
  dash?: any;
  health?: any;
  trades?: any[];
  killSwitch?: any;
  strategy?: any;
  loopStatus: LoopStatus | null;
  sseHealthScore?: number;
  toast?: (msg: string, type?: 'ok' | 'err' | 'info') => void;
}
