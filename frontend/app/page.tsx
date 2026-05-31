'use client';

import dynamic from 'next/dynamic';
import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui';

const Dashboard = dynamic(() => import('./dashboard'), { ssr: false });

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL || (window.location.port === '3000' ? 'http://localhost:8080' : window.location.origin))
    : (process.env.NEXT_PUBLIC_API_BASE_URL || '');

async function checkServerAuth(): Promise<boolean> {
  try {
    const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    const res = await fetch(`${base}/api/auth/me`, { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    return data.loggedIn === true || data.noPassword === true;
  } catch {
    return false;
  }
}

async function serverLogin(password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const base = BACKEND_URL.endsWith('/') ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (res.ok && data.ok) return { ok: true };
    return { ok: false, error: data.error ?? '로그인 실패' };
  } catch {
    return { ok: false, error: '서버 연결 오류' };
  }
}

function LoginScreen({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError('');
    const result = await serverLogin(password);
    if (result.ok) {
      onUnlock();
    } else {
      setError(result.error ?? '로그인 실패');
      setPassword('');
    }
    setLoading(false);
  }, [password, onUnlock]);

  return (
    <div className="fixed inset-0 bg-[#0b0f1a] flex items-center justify-center z-[9999]">
      <div className="w-full max-w-xs px-6 text-center">
        {/* 로고 */}
        <div className="mb-8">
          <h1 className="text-2xl font-black bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">QUANTOPS</h1>
          <p className="text-xs text-slate-600 mt-1">AI 자동매매 시스템</p>
        </div>

        {/* 잠금 아이콘 */}
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-slate-800/50 border border-slate-700/50 flex items-center justify-center">
          <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-400" viewBox="0 0 24 24">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 118 0v4" />
          </svg>
        </div>

        {/* 패스워드 입력 */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            placeholder="패스워드 입력"
            autoFocus
            className="w-full bg-slate-800/80 border border-slate-700 rounded-xl px-4 py-3 text-center text-base placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full py-3 flex items-center justify-center gap-2"
            disabled={loading || !password}
          >
            {loading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : '잠금 해제'}
          </Button>
        </form>

        {error && <p className="text-xs text-rose-400 mt-3">{error}</p>}
      </div>
    </div>
  );
}

export default function Page() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    checkServerAuth().then(ok => {
      setLoggedIn(ok);
      setChecked(true);
    });
  }, []);

  if (!checked) return null;
  if (!loggedIn) return <LoginScreen onUnlock={() => setLoggedIn(true)} />;
  return <Dashboard />;
}
