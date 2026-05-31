import html2canvas from 'html2canvas';
import type { ScreenshotProps } from './screenshot-types';

export function buildDiagBanner(tabLabel: string, props: ScreenshotProps): HTMLDivElement {
  const { viewMode, dash, health, trades, killSwitch, strategy } = props;
  const el = document.createElement('div');
  el.id = '__diag_banner__';
  el.style.cssText = 'background:#111827;border-bottom:2px solid #1e3a5f;padding:10px 16px;font-family:monospace;font-size:12px;color:#94a3b8;display:flex;flex-wrap:wrap;gap:12px;align-items:center;';
  const pill = (label: string, value: string, color = '#64748b') =>
    `<span style="background:${color}22;border:1px solid ${color}44;border-radius:6px;padding:2px 8px;color:${color};font-weight:600;font-size:11px;">${label}: ${value}</span>`;
  const vmColor = viewMode === 'paper' ? '#f59e0b' : '#10b981';
  const tradingMode = dash?.tradingMode ?? health?.tradingMode ?? '?';
  const tmColor = tradingMode === 'paper' ? '#f59e0b' : '#10b981';
  const parts: string[] = [
    pill('TAB', tabLabel, '#3b82f6'),
    pill('VIEW', viewMode.toUpperCase(), vmColor),
    pill('TRADE', tradingMode.toUpperCase(), tmColor),
  ];
  if (viewMode !== tradingMode && tradingMode !== '?') {
    parts.push(`<span style="color:#ef4444;font-weight:bold;font-size:11px;">!! VIEW/TRADE 불일치</span>`);
  }
  const now = new Date();
  parts.push(pill('TIME', now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
  const mode = strategy?.mode ?? dash?.strategy?.mode;
  if (mode) parts.push(pill('MODE', mode, '#8b5cf6'));
  if (killSwitch?.kr?.active || killSwitch?.overseas?.active) {
    const scopes = [killSwitch?.kr?.active && 'KR', killSwitch?.overseas?.active && 'US'].filter(Boolean).join('+');
    parts.push(`<span style="color:#ef4444;font-weight:bold;">KILL ${scopes}</span>`);
  }
  const pv = dash?.portfolio?.totalValue;
  if (pv != null) parts.push(pill('자산', `${Math.round(pv).toLocaleString()}원`));
  el.innerHTML = parts.join('');
  return el;
}

/** MutationObserver 기반 DOM 안정화 대기 */
export async function waitForStable(el: Element, minWait = 300, maxWait = 3000): Promise<void> {
  return new Promise(resolve => {
    let lastMutation = Date.now();
    const observer = new MutationObserver(() => { lastMutation = Date.now(); });
    observer.observe(el, { childList: true, subtree: true, attributes: true });
    const startedAt = Date.now();
    const check = () => {
      const elapsed = Date.now() - startedAt;
      const sinceLast = Date.now() - lastMutation;
      if ((sinceLast > 500 && elapsed > minWait) || elapsed > maxWait) {
        observer.disconnect();
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    setTimeout(check, minWait);
  });
}

export async function captureTab(tabLabel: string, props: ScreenshotProps, modeOverride?: 'live' | 'paper'): Promise<string | null> {
  const mainEl = document.querySelector('main');
  if (!mainEl) return null;
  const effectiveMode = modeOverride ?? props.viewMode;
  const bannerProps = modeOverride ? { ...props, viewMode: modeOverride } : props;
  const banner = buildDiagBanner(tabLabel, bannerProps);
  mainEl.insertBefore(banner, mainEl.firstChild);
  mainEl.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 100));
  try {
    const fullHeight = Math.max(mainEl.scrollHeight, mainEl.offsetHeight, 800);
    const bgColor = effectiveMode === 'paper' ? '#0d0a06' : '#06080f';
    const cappedHeight = Math.min(fullHeight, 4000);
    const capturePromise = html2canvas(mainEl as HTMLElement, {
      backgroundColor: bgColor, scale: 1.5, useCORS: true, logging: false,
      windowWidth: 1200, windowHeight: cappedHeight, height: cappedHeight, y: 0, scrollY: 0,
      onclone: (doc: Document) => {
        const clonedMain = doc.querySelector('main');
        if (clonedMain) { (clonedMain as HTMLElement).style.overflow = 'visible'; (clonedMain as HTMLElement).style.height = 'auto'; }
      },
    });
    const timeoutPromise = new Promise<null>((_, reject) => setTimeout(() => reject(new Error('캡쳐 타임아웃 (10초)')), 10_000));
    const canvas = await Promise.race([capturePromise, timeoutPromise]);
    if (!canvas) return null;
    return canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
  } finally { banner.remove(); }
}

export function downloadPng(base64: string, filename: string) {
  const a = document.createElement('a');
  a.href = `data:image/jpeg;base64,${base64}`;
  a.download = filename.replace(/\.png$/, '.jpg');
  a.click();
}

/** 상대 시간 표시 (예: "5분 전") */
export function timeAgo(dateStr: string): string {
  const sec = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 전`;
}
