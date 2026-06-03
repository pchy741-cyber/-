'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/utils';
import type { ToastFn } from '../../types';

interface Credential {
  id: string;
  device_name: string;
  created_at: string;
  last_used_at: string | null;
}

export function BiometricSection({ toast }: { toast?: ToastFn }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && !!window.PublicKeyCredential);
    loadCredentials();
  }, []);

  const loadCredentials = async () => {
    try {
      const data = await api('/auth/webauthn/credentials');
      setCredentials(data.credentials ?? []);
    } catch {
      // 초기 로드 실패 무시
    }
  };

  const handleRegister = useCallback(async () => {
    setLoading(true);
    try {
      // 1. 서버에서 등록 옵션 가져오기
      const options = await api('/auth/webauthn/register/options', { method: 'POST' });

      // 2. WebAuthn API 호출 (브라우저 네이티브)
      const { startRegistration } = await import('@simplewebauthn/browser');
      const regResp = await startRegistration({ optionsJSON: options });

      // 3. 서버에 검증 요청
      const deviceName = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone'
        : /Android/.test(navigator.userAgent) ? 'Android'
        : /Mac/.test(navigator.userAgent) ? 'Mac'
        : /Windows/.test(navigator.userAgent) ? 'PC' : '디바이스';

      const result = await api('/auth/webauthn/register/verify', {
        method: 'POST',
        body: JSON.stringify({ credential: regResp, deviceName }),
      });

      if (result.ok) {
        toast?.('생체인증 등록 완료', 'ok');
        loadCredentials();
      } else {
        toast?.(result.error ?? '등록 실패', 'err');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        toast?.('등록이 취소되었습니다', 'info');
      } else {
        toast?.((err as Error).message ?? '생체인증 등록 실패', 'err');
      }
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api(`/auth/webauthn/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast?.('디바이스 삭제됨', 'ok');
      setCredentials((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast?.('삭제 실패', 'err');
    }
  }, [toast]);

  if (!supported) {
    return (
      <div>
        <p className="text-[12px] text-slate-500 font-medium mb-2">생체인증 (지문/Face ID)</p>
        <p className="text-[11px] text-slate-600">이 브라우저는 생체인증을 지원하지 않습니다.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12px] text-slate-500 font-medium">생체인증 (지문/Face ID)</p>
        <button
          type="button"
          onClick={handleRegister}
          disabled={loading}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-[11px] font-semibold transition-all shadow-sm disabled:opacity-50 flex items-center gap-1.5"
        >
          {loading ? (
            <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          )}
          디바이스 등록
        </button>
      </div>

      {credentials.length > 0 ? (
        <div className="space-y-2">
          {credentials.map((cred) => (
            <div key={cred.id} className="flex items-center justify-between bg-white/[0.03] rounded-lg px-3 py-2 ring-1 ring-white/[0.06]">
              <div>
                <p className="text-[12px] text-slate-300 font-medium">{cred.device_name}</p>
                <p className="text-[10px] text-slate-600">
                  등록: {new Date(cred.created_at).toLocaleDateString('ko-KR')}
                  {cred.last_used_at && ` | 최근 사용: ${new Date(cred.last_used_at).toLocaleDateString('ko-KR')}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(cred.id)}
                className="text-[10px] text-rose-500 hover:text-rose-400 transition-colors"
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-slate-600">등록된 디바이스가 없습니다. 위 버튼으로 이 기기의 지문/Face ID를 등록하세요.</p>
      )}
    </div>
  );
}
