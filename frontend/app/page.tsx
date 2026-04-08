'use client';

import dynamic from 'next/dynamic';
import React, { useState, useEffect, useCallback } from 'react';

const Dashboard = dynamic(() => import('./dashboard'), { ssr: false });

// 잠금 해제 후 유효 시간 (ms) — 30분
const AUTH_DURATION = 30 * 60 * 1000;
const AUTH_KEY = 'quantops_auth_ts';

function isAuthenticated(): boolean {
  try {
    const ts = localStorage.getItem(AUTH_KEY);
    if (!ts) return false;
    return Date.now() - Number(ts) < AUTH_DURATION;
  } catch {
    return false;
  }
}

function setAuthenticated(): void {
  try { localStorage.setItem(AUTH_KEY, String(Date.now())); } catch {}
}

/**
 * Web Authentication API (생체인증/지문/Face ID)
 * - 모바일: 지문/얼굴 인식
 * - 데스크톱: Windows Hello / Touch ID
 * - 미지원 브라우저: PIN 폴백
 */
async function authenticateWithBiometric(): Promise<boolean> {
  // PublicKeyCredential 지원 확인
  if (!window.PublicKeyCredential) return false;

  try {
    // 생체인증 가능 여부 체크
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) return false;

    // 임시 챌린지 생성 (서버 미사용 — 클라이언트 단독 인증)
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);

    // 기존 credential ID가 있으면 로드
    const credIdStr = localStorage.getItem('quantops_cred_id');

    if (credIdStr) {
      // 기존 등록된 credential로 인증
      const credId = Uint8Array.from(atob(credIdStr), c => c.charCodeAt(0));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: credId, type: 'public-key', transports: ['internal'] }],
          userVerification: 'required',
          timeout: 60000,
        },
      }) as PublicKeyCredential | null;
      return !!assertion;
    } else {
      // 최초: credential 등록 + 인증
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'QUANTOPS', id: location.hostname },
          user: {
            id: new TextEncoder().encode('quantops-ceo'),
            name: 'CEO',
            displayName: 'QUANTOPS CEO',
          },
          pubKeyCredParams: [
            { alg: -7, type: 'public-key' },   // ES256
            { alg: -257, type: 'public-key' },  // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
          timeout: 60000,
        },
      }) as PublicKeyCredential | null;

      if (credential) {
        // credential ID 저장
        const rawId = new Uint8Array(credential.rawId);
        localStorage.setItem('quantops_cred_id', btoa(String.fromCharCode(...rawId)));
        return true;
      }
      return false;
    }
  } catch {
    return false;
  }
}

// PIN 폴백 (생체인증 미지원 시) — SHA-256 해시 저장
const DEFAULT_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'; // sha256('1234')

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 생체인증 가능 여부 체크
    if (window.PublicKeyCredential) {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(setBiometricAvailable)
        .catch(() => setBiometricAvailable(false));
    }
  }, []);

  // 페이지 진입 시 자동으로 생체인증 시도
  useEffect(() => {
    if (biometricAvailable) {
      handleBiometric();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biometricAvailable]);

  const handleBiometric = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const ok = await authenticateWithBiometric();
      if (ok) {
        setAuthenticated();
        onUnlock();
      } else {
        setError('인증 실패 — PIN을 입력하세요');
      }
    } catch {
      setError('인증 오류');
    } finally {
      setLoading(false);
    }
  }, [onUnlock]);

  const handlePin = async (e: React.FormEvent) => {
    e.preventDefault();
    const saved = localStorage.getItem('quantops_pin') || DEFAULT_PIN_HASH;
    const inputHash = await hashPin(pin);

    // 호환: 기존 평문 PIN이면 직접 비교 후 해시로 업그레이드
    const isOldPlaintext = saved.length < 64;
    const matched = isOldPlaintext ? (pin === saved) : (inputHash === saved);

    if (matched) {
      if (isOldPlaintext) localStorage.setItem('quantops_pin', inputHash); // 자동 해시 업그레이드
      setAuthenticated();
      onUnlock();
    } else {
      setError('PIN이 틀립니다');
      setPin('');
    }
  };

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

        {/* 생체인증 버튼 */}
        {biometricAvailable && (
          <button onClick={handleBiometric} disabled={loading}
            className="w-full py-3.5 mb-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2">
            {loading ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M17.81 4.47c-.08 0-.16-.02-.23-.06C15.66 3.42 14 3 12.01 3c-1.98 0-3.86.47-5.57 1.41-.24.13-.54.04-.68-.2-.13-.24-.04-.55.2-.68C7.82 2.52 9.86 2 12.01 2c2.13 0 3.99.47 6.03 1.52.25.13.34.43.21.67-.09.18-.26.28-.44.28zM3.5 9.72a.499.499 0 01-.41-.79c.99-1.4 2.25-2.51 3.75-3.3C8.35 4.86 10.12 4.5 12 4.5c1.88 0 3.65.36 5.16 1.13 1.5.79 2.76 1.9 3.75 3.3a.5.5 0 11-.82.57c-.9-1.29-2.08-2.31-3.46-3.03C15.24 5.71 13.58 5.5 12 5.5s-3.24.21-4.63.97c-1.38.72-2.56 1.74-3.46 3.03-.1.14-.25.22-.41.22zM9.75 21.79a.47.47 0 01-.35-.15c-.87-.87-1.34-1.43-2.01-2.64-.69-1.23-1.05-2.73-1.05-4.34 0-2.97 2.54-5.39 5.66-5.39s5.66 2.42 5.66 5.39c0 .28-.22.5-.5.5s-.5-.22-.5-.5c0-2.42-2.09-4.39-4.66-4.39-2.57 0-4.66 1.97-4.66 4.39 0 1.44.32 2.77.93 3.85.64 1.15 1.08 1.64 1.85 2.42.19.2.19.51 0 .71-.11.1-.24.15-.37.15zM16.09 16.95c-.28 0-.5-.22-.5-.5 0-1.98-1.6-3.59-3.59-3.59-1.98 0-3.59 1.61-3.59 3.59 0 1.07.25 2.07.68 2.95.1.22.01.49-.21.6-.22.1-.49.01-.6-.21-.49-1.01-.76-2.17-.76-3.34 0-2.53 2.06-4.59 4.59-4.59 2.53 0 4.59 2.06 4.59 4.59-.01.28-.23.5-.51.5h-.1zM12 21.35c-.23 0-.43-.16-.49-.39-.29-1.07-1.17-1.96-2.28-2.28-.24-.07-.39-.31-.32-.56.07-.24.31-.39.56-.32 1.37.39 2.49 1.5 2.87 2.83.07.24-.07.49-.31.56-.01.01-.02.01-.03.01z"/></svg>
                지문/생체 인증
              </>
            )}
          </button>
        )}

        {/* PIN 입력 */}
        <form onSubmit={handlePin} className="space-y-3">
          <div className="relative">
            <input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
              placeholder="PIN 입력"
              className="w-full bg-slate-800/80 border border-slate-700 rounded-xl px-4 py-3 text-center text-lg tracking-[0.5em] font-mono placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none" />
          </div>
          <button type="submit" disabled={pin.length < 4}
            className="w-full py-3 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded-xl text-sm font-medium transition-all">
            잠금 해제
          </button>
        </form>

        {error && <p className="text-xs text-rose-400 mt-3">{error}</p>}
        <p className="text-[10px] text-slate-700 mt-6">초기 PIN: 1234 (설정에서 변경)</p>
      </div>
    </div>
  );
}

export default function Page() {
  const [unlocked, setUnlocked] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setUnlocked(isAuthenticated());
    setChecked(true);
  }, []);

  if (!checked) return null;
  if (!unlocked) return <LockScreen onUnlock={() => setUnlocked(true)} />;
  return <Dashboard />;
}
