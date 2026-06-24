/**
 * 시스템 이벤트 로그 — 최근 실행 결과 추적, paper/live 분리
 * (health.ts에서 추출 → scheduler→api 역방향 의존 제거)
 *
 * v15: detail 필드 추가 — Track A/B, QA봇, 루프 등 세부 정보 표기
 */
import { hasCtx, getCtxIsPaper } from '../config/context.js';

export interface SystemEvent {
  component: string;
  status: 'success' | 'error' | 'running';
  message: string;
  detail?: string;    // 상세 정보 (Track A 5종목 분석, QA 3건 감지 등)
  timestamp: string;
  mode?: 'paper' | 'live';
  durationMs?: number; // 실행 소요 시간
}

const recentEvents: SystemEvent[] = [];
const MAX_EVENTS = 200; // 100 → 200 (디테일 강화로 더 많은 이력 유지)

export function logSystemEvent(
  component: string,
  status: 'success' | 'error' | 'running',
  message: string,
  opts?: { detail?: string; durationMs?: number },
) {
  let mode: 'paper' | 'live' | undefined;
  try { if (hasCtx()) mode = getCtxIsPaper() ? 'paper' : 'live'; } catch { /* 컨텍스트 없으면 undefined */ }
  recentEvents.unshift({
    component, status, message, timestamp: new Date().toISOString(), mode,
    detail: opts?.detail,
    durationMs: opts?.durationMs,
  });
  if (recentEvents.length > MAX_EVENTS) recentEvents.splice(MAX_EVENTS);
}

export function getRecentEvents(limit = 20, filterMode?: 'paper' | 'live'): SystemEvent[] {
  if (!filterMode) return recentEvents.slice(0, limit);
  return recentEvents.filter(e => !e.mode || e.mode === filterMode).slice(0, limit);
}
