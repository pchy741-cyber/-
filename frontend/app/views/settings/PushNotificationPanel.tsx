'use client';

import React, { useState, useEffect } from 'react';
import { Panel } from '@/components/ui';
import { api } from '../../lib/utils';
import type { PushStatus } from './settings-types';

export function PushNotificationPanel({ toast, confirm }: { toast?: (msg: string, type?: 'ok' | 'err' | 'info') => void; confirm?: (opts: { title: string; description?: string; confirmLabel?: string; confirmVariant?: string }) => Promise<boolean> }) {
  const [pushStatus, setPushStatus] = useState<PushStatus>({
    ready: false,
    publicKey: '',
    deviceCount: 0,
    subscribed: false,
    permissionState: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    registering: false,
    error: null,
  });

  // 알림 상태 초기화 + 자동 등록 (VAPID 키 변경 시 자동 재등록)
  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined') return;
      const supported = 'serviceWorker' in navigator && 'PushManager' in window;
      const perm: NotificationPermission | 'unsupported' = supported ? Notification.permission : 'unsupported';

      let serverStatus = { ready: false, publicKey: '', deviceCount: 0 };
      try { serverStatus = await api('/push/status'); } catch { /* ignore */ }

      let subscribed = false;
      if (supported && perm === 'granted') {
        try {
          const reg = await navigator.serviceWorker.ready;
          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            const akBuf = existing.options?.applicationServerKey as ArrayBuffer | null;
            if (akBuf && serverStatus.publicKey) {
              const b64 = btoa(String.fromCharCode(...new Uint8Array(akBuf)))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
              if (b64 !== serverStatus.publicKey) {
                console.info('[QUANTOPS] VAPID 키 변경 감지 → 재등록');
                await existing.unsubscribe();
              } else if (serverStatus.deviceCount === 0) {
                console.info('[QUANTOPS] 서버 구독 누락 감지 → 재등록');
                await existing.unsubscribe();
              } else {
                subscribed = true;
              }
            } else {
              subscribed = true;
            }
          }
        } catch { /* ignore */ }
      }

      setPushStatus(prev => ({ ...prev, ...serverStatus, subscribed, permissionState: perm }));

      if (supported && perm === 'granted' && !subscribed && serverStatus.ready && serverStatus.publicKey) {
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverStatus.publicKey });
          await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
          setPushStatus(prev => ({ ...prev, subscribed: true, deviceCount: prev.deviceCount + 1, error: null }));
        } catch (e: any) {
          console.warn('[QUANTOPS] 자동 푸시 등록 실패:', e.message);
          setPushStatus(prev => ({ ...prev, error: `자동 등록 실패: ${e.message} — 아래 "이 기기에 등록" 버튼을 눌러주세요` }));
        }
      }
    })();
  }, []);

  // 푸시 구독 주기적 헬스체크 — VAPID 키 변경 시 자동 재등록 (5분 간격, 탭 활성 시만)
  useEffect(() => {
    const checkAndRenew = async () => {
      if (typeof window === 'undefined' || document.visibilityState !== 'visible') return;
      const supported = 'serviceWorker' in navigator && 'PushManager' in window;
      if (!supported || Notification.permission !== 'granted') return;
      try {
        let serverStatus = { ready: false, publicKey: '', deviceCount: 0 };
        try { serverStatus = await api('/push/status'); } catch { return; }
        if (!serverStatus.ready || !serverStatus.publicKey) return;
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (!existing) {
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverStatus.publicKey });
          await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
          setPushStatus(prev => ({ ...prev, subscribed: true }));
          console.info('[QUANTOPS] 푸시 구독 자동 재등록 완료');
          return;
        }
        const akBuf = existing.options?.applicationServerKey as ArrayBuffer | null;
        if (akBuf && serverStatus.publicKey) {
          const b64 = btoa(String.fromCharCode(...new Uint8Array(akBuf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          if (b64 !== serverStatus.publicKey) {
            console.info('[QUANTOPS] VAPID 키 불일치 감지 → 재등록');
            await existing.unsubscribe();
            const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverStatus.publicKey });
            await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
            setPushStatus(prev => ({ ...prev, subscribed: true }));
          }
        }
      } catch (e: any) { console.warn('[QUANTOPS] 구독 헬스체크 실패:', e.message); }
    };
    const interval = setInterval(checkAndRenew, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', checkAndRenew);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', checkAndRenew); };
  }, []);

  return (
    <Panel title="알림 설정">
      <div className="px-6 py-5 space-y-4">
        {/* 상태 표시 바 */}
        <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.04] border border-white/[0.07]">
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            pushStatus.permissionState === 'unsupported' ? 'bg-slate-600' :
            pushStatus.permissionState === 'denied' ? 'bg-red-500' :
            pushStatus.subscribed && pushStatus.ready ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)] animate-pulse' :
            'bg-amber-400'
          }`} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-slate-200">
              {pushStatus.permissionState === 'unsupported' ? '알림 미지원 브라우저' :
               pushStatus.permissionState === 'denied' ? '알림 권한 차단됨' :
               !pushStatus.ready ? '서버 알림 초기화 중...' :
               pushStatus.subscribed ? '알림 활성 — 실시간 수신 중' :
               '알림 미등록'}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {pushStatus.permissionState === 'denied'
                ? '브라우저 주소창 자물쇠 → 알림 → 허용으로 변경 후 새로고침'
                : pushStatus.subscribed && pushStatus.ready
                ? `등록 기기 ${pushStatus.deviceCount}대 · 매수/매도/긴급 알림 즉시 수신`
                : !pushStatus.ready
                ? 'VAPID 키 로드 중 — 잠시 후 버튼을 눌러주세요'
                : '아래 버튼으로 이 기기에 알림을 등록하세요'}
            </p>
          </div>
          {pushStatus.subscribed && (
            <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full shrink-0 font-medium">ON</span>
          )}
        </div>

        {/* 에러 메시지 */}
        {pushStatus.error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
            <p className="text-[11px] text-red-400 font-medium">❌ 등록 실패</p>
            <p className="text-[11px] text-slate-400 mt-1">{pushStatus.error}</p>
          </div>
        )}

        {/* 버튼 영역 */}
        <div className="flex gap-2">
          <button
            disabled={pushStatus.registering || pushStatus.permissionState === 'denied' || pushStatus.permissionState === 'unsupported'}
            onClick={async () => {
              setPushStatus(prev => ({ ...prev, registering: true, error: null }));
              try {
                if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
                  setPushStatus(prev => ({ ...prev, registering: false, error: '이 브라우저는 푸시 알림을 지원하지 않습니다. iOS는 사파리에서 홈 화면에 추가 후 사용하세요.' }));
                  return;
                }
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                  setPushStatus(prev => ({ ...prev, registering: false, permissionState: 'denied', error: '알림 권한이 거부되었습니다. 브라우저 주소창 자물쇠 아이콘 → 알림 → 허용으로 변경해주세요.' }));
                  return;
                }
                const serverStatus = await api('/push/status');
                if (!serverStatus.ready || !serverStatus.publicKey) {
                  setPushStatus(prev => ({ ...prev, registering: false, error: '서버 알림 키 초기화 중입니다. 10초 후 다시 시도해주세요.' }));
                  return;
                }
                const reg = await navigator.serviceWorker.ready;
                const existing = await reg.pushManager.getSubscription();
                if (existing) await existing.unsubscribe();
                const sub = await reg.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: serverStatus.publicKey,
                });
                await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
                setPushStatus(prev => ({
                  ...prev,
                  registering: false,
                  subscribed: true,
                  ready: true,
                  permissionState: 'granted',
                  deviceCount: serverStatus.deviceCount + 1,
                  error: null,
                }));
                toast?.('이 기기에 알림 등록 완료 — 매수/매도 즉시 알림됩니다', 'ok');
              } catch (err: any) {
                setPushStatus(prev => ({ ...prev, registering: false, error: err.message || '알 수 없는 오류' }));
              }
            }}
            className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-xs font-semibold transition-all shadow-sm flex items-center justify-center gap-1.5"
          >
            {pushStatus.registering ? (
              <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block" /> 등록 중...</>
            ) : pushStatus.subscribed ? '📱 이 기기 재등록' : '📱 이 기기에 등록'}
          </button>
          <button
            onClick={async () => {
              try {
                const res = await api('/push/test', { method: 'POST' });
                if (res.ok) toast?.('테스트 알림 전송 완료', 'ok');
                else toast?.('서버 알림 미준비 — 기기 등록 먼저', 'err');
              } catch {
                toast?.('테스트 실패 — 기기 등록 여부 확인', 'err');
              }
            }}
            className="px-4 py-2.5 bg-white/[0.06] hover:bg-white/[0.1] rounded-xl text-xs text-slate-400 transition-all shrink-0"
          >테스트</button>
        </div>

        {/* 알림 초기화 */}
        <button
          onClick={async () => {
            if (confirm) { if (!await confirm({ title: '알림 초기화', description: '서버의 모든 구독을 삭제합니다. 이후 "이 기기 재등록"을 눌러 재등록하세요.', confirmLabel: '초기화', confirmVariant: 'danger' })) return; }
            try {
              const reg = await navigator.serviceWorker.ready;
              const existing = await reg.pushManager.getSubscription();
              if (existing) await existing.unsubscribe();
              await api('/push/subscriptions', { method: 'DELETE' });
              toast?.('알림 초기화 완료 — "이 기기 재등록" 버튼으로 재등록하세요', 'ok');
              setPushStatus(s => ({ ...s, subscribed: false }));
            } catch {
              toast?.('초기화 실패 — 다시 시도해 주세요', 'err');
            }
          }}
          className="w-full px-4 py-2 bg-rose-900/20 hover:bg-rose-900/35 ring-1 ring-rose-800/30 rounded-xl text-xs text-rose-400 transition-all"
        >🔄 알림 초기화 (안됨 → 여기 누른 후 재등록)</button>

        {/* 알림 종류 안내 */}
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '🟢', label: '매수 체결', desc: '종목·수량·금액 즉시' },
            { icon: '🔻', label: '매도/손절', desc: '손익률·금액 포함' },
            { icon: '🎉', label: '목표 수익', desc: '+5% 이상 매도 시' },
            { icon: '⚠️', label: '긴급 알림', desc: '킬스위치·시장 이상' },
          ].map(({ icon, label, desc }) => (
            <div key={label} className="flex items-start gap-2 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
              <span className="text-base leading-none mt-0.5">{icon}</span>
              <div>
                <p className="text-[11px] font-medium text-slate-300">{label}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* 기기 추가 안내 */}
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
          <p className="text-[11px] text-amber-400 font-medium mb-1">📱 폰·태블릿에서도 받으려면</p>
          <p className="text-[11px] text-slate-400">각 기기 브라우저에서 이 페이지를 열고 <b className="text-slate-300">"이 기기에 등록"</b>을 누르세요. 기기마다 따로 등록해야 합니다.</p>
          <p className="text-[11px] text-slate-500 mt-1">iPhone: 사파리 → 공유 → 홈 화면에 추가 → 홈 화면 앱에서 열기 → 등록</p>
        </div>
      </div>
    </Panel>
  );
}
