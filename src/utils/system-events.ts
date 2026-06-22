/**
 * 시스템 이벤트 로그 — 최근 실행 결과 추적, paper/live 분리
 * (health.ts에서 추출 → scheduler→api 역방향 의존 제거)
 */
import { hasCtx, getCtxIsPaper } from '../config/context.js';

export interface SystemEvent {
  component: string;
  status: 'success' | 'error' | 'running';
  message: string;
  timestamp: string;
  mode?: 'paper' | 'live';
}

const recentEvents: SystemEvent[] = [];
const MAX_EVENTS = 100;

export function logSystemEvent(component: string, status: 'success' | 'error' | 'running', message: string) {
  let mode: 'paper' | 'live' | undefined;
  try { if (hasCtx()) mode = getCtxIsPaper() ? 'paper' : 'live'; } catch { /* 컨텍스트 없으면 undefined */ }
  recentEvents.unshift({ component, status, message, timestamp: new Date().toISOString(), mode });
  if (recentEvents.length > MAX_EVENTS) recentEvents.splice(MAX_EVENTS);
}

export function getRecentEvents(limit = 10, filterMode?: 'paper' | 'live'): SystemEvent[] {
  if (!filterMode) return recentEvents.slice(0, limit);
  return recentEvents.filter(e => !e.mode || e.mode === filterMode).slice(0, limit);
}
