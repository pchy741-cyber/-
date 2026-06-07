export type ViewMode = 'live' | 'paper';
export type MarketTab = 'KR' | 'US';
export type ToastFn = (msg: string, type?: 'ok' | 'err' | 'info') => void;

export { type ConfirmOptions } from '../lib/hooks';
export type ConfirmFn = (opts: import('../lib/hooks').ConfirmOptions) => Promise<boolean>;

export interface DashTheme {
  bg: string;
  side: string;
  main1: string;
  main2: string;
  accent: string;
  border: string;
  bar: string;
}
