'use client';

import React, { useState, useEffect } from 'react';
import { Panel, NumInput, ConfirmModal, Sel } from '@/components/ui';
import { api, fmtWon } from '../lib/utils';
import { StrategyTimelinePanel } from '../panels/SmallPanels';

// NotebookLM 소스 타입
interface NbSource { id: string; title: string; content: string; created_at?: string; harm_suspected?: boolean; }

function parseNbSources(raw: string | null | undefined): NbSource[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as NbSource[];
  } catch { /* not JSON — legacy plain text */ }
  if (/[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$\n:#\[\]@!?/"'=]/.test(raw)) return [];
  return [{ id: crypto.randomUUID(), title: '기존 소스', content: raw }];
}

function SettingsView({ strategy, setStrategy, secrets, notebookRef, geminiRef, gptRef, claudeRef, killSwitch, toggleKill, withdrawConfig, setWithdrawConfig, withdrawHistory, setWithdrawHistory, allocConfig, setAllocConfig, toast }: any) {
  const [activeStep, setActiveStep] = useState<number>(0);

  // 알림 상태
  const [pushStatus, setPushStatus] = useState<{
    ready: boolean;
    publicKey: string;
    deviceCount: number;
    subscribed: boolean;
    permissionState: NotificationPermission | 'unsupported';
    registering: boolean;
    error: string | null;
  }>({
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
            // VAPID 키 변경 감지: 서버 키와 구독의 applicationServerKey 비교
            const akBuf = existing.options?.applicationServerKey as ArrayBuffer | null;
            if (akBuf && serverStatus.publicKey) {
              const b64 = btoa(String.fromCharCode(...new Uint8Array(akBuf)))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
              if (b64 !== serverStatus.publicKey) {
                // 키 불일치 → 기존 구독 해제, 재등록 트리거
                console.info('[QUANTOPS] VAPID 키 변경 감지 → 재등록');
                await existing.unsubscribe();
              } else if (serverStatus.deviceCount === 0) {
                // 브라우저엔 구독 있지만 서버 DB에 없음 (403 삭제 등) → 재등록
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
          // 구독 없음 → 자동 재등록
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverStatus.publicKey });
          await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
          setPushStatus(prev => ({ ...prev, subscribed: true }));
          console.info('[QUANTOPS] 푸시 구독 자동 재등록 완료');
          return;
        }
        // VAPID 키 불일치 → 재구독
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
    const interval = setInterval(checkAndRenew, 5 * 60 * 1000); // 5분
    document.addEventListener('visibilitychange', checkAndRenew);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', checkAndRenew); };
  }, []);

  const [nbSources, setNbSources] = useState<NbSource[]>(() => parseNbSources(strategy?.notebooklm_prompt));
  const [nbAddTitle, setNbAddTitle] = useState('');
  const [nbAddContent, setNbAddContent] = useState('');
  const [nbAdding, setNbAdding] = useState(false);
  const [nbEditId, setNbEditId] = useState<string | null>(null);
  const [nbEditTitle, setNbEditTitle] = useState('');
  const [nbEditContent, setNbEditContent] = useState('');
  const [nbPendingDeleteId, setNbPendingDeleteId] = useState<string | null>(null);

  // 프롬프트 로컬 상태 — strategy 최초 로드 시 한 번만 초기화, 이후 30초 폴링에 영향 받지 않음
  const DEFAULT_STRATEGY_DOC = `# 매매 전략서

## 투자 철학
- 추세 추종 + 분할 매수(3회)로 리스크 분산
- 손절은 기계적으로, 익절은 단계적으로
- 모의투자 단계 — 적극적 자동매매로 전략 검증이 최우선

## 종목 선정 기준
- AI 점수 70점 이상 + 기술적 점수 상위 종목 우선
- 반도체·방산·에너지 테마 종목 적극 편입 (시장 주도 섹터)
- 바이오 종목은 이벤트(임상결과·FDA) 없으면 보수적 접근
- 14일 내 손절 이력 종목 재진입 금지

## 매매 규칙
- 1종목 최대 투자금: 총 자산의 25%
- 분할 매수: 1차 진입 후 -3% 물타기 최대 2회
- 부분 익절 후 트레일링 스톱 자동 적용
- 당일 신규 매수는 장 시작 30분 이후부터

## 시장 상황별 대응
### 상승장 (코스피 +1% 이상)
- 공격적 비중 확대, 우선 테마 종목 비중 20% 추가

### 횡보장
- 스윙 비중 유지, 손절 기준 엄격 적용

### 하락장 / 갭다운 3% 이상
- 신규 매수 금지, 기존 포지션 손절 기준 절반으로 타이트하게
- 현금 비중 50% 이상 유지`;

  const DEFAULT_RISK_PROMPT = `## 리스크 운영 지시사항

### 일별 손실 한도 초과 시
- 당일 추가 매수 완전 금지
- 기존 포지션 손절 기준 절반으로 타이트하게 운영
- 다음날 장 시작 전 Track A 재분석 후 전략 재평가

### 급락 감지 시 (갭다운 -3% 이상 또는 장중 -2% 급락)
- 개장 후 30분간 신규 매수 완전 금지
- 기존 포지션 평가손 -5% 이상이면 즉시 청산
- 반등 시작 확인 후에만 신규 진입 허용

### 외부 충격 (정치·경제 뉴스) 감지 시
- 미국 관세·금리 인상·전쟁·대규모 파산 키워드 → 포지션 50% 즉시 축소
- 대통령/연준 의장 발언 예정일 → 당일 신규 매수 금지
- 외환위기 징후 (원/달러 급등) → 해외주식 비중 확대, 국내 현금화

### 연속 손실 시 (3거래일 연속 마이너스)
- 매매 사이즈 절반으로 축소
- Track A 재실행 후 포트폴리오 전면 재검토
- 손절 패턴 있는 종목은 watchlist에서 즉시 제거

### 수익 실현 원칙
- 누적 수익 10% 달성 시 수익분 30% 인출 예약 자동 설정
- 인출 후 남은 원금으로 동일 전략 반복`;

  const [geminiPrompt, setGeminiPrompt] = useState<string>(() => strategy?.gemini_prompt ?? '');
  const [claudePrompt, setClaudePrompt] = useState<string>(() => strategy?.claude_prompt ?? '');
  const [strategyDoc, setStrategyDoc] = useState<string>(() => strategy?.strategy_document || DEFAULT_STRATEGY_DOC);
  const [riskPrompt, setRiskPrompt] = useState<string>(() => strategy?.risk_prompt || DEFAULT_RISK_PROMPT);
  const [strategyDocTab, setStrategyDocTab] = useState<'doc' | 'risk'>('doc');
  const promptsInitialized = React.useRef(false);
  React.useEffect(() => {
    if (!promptsInitialized.current && strategy) {
      setGeminiPrompt(strategy.gemini_prompt ?? '');
      setClaudePrompt(strategy.claude_prompt ?? '');
      setStrategyDoc(strategy.strategy_document || DEFAULT_STRATEGY_DOC);
      setRiskPrompt(strategy.risk_prompt || DEFAULT_RISK_PROMPT);
      promptsInitialized.current = true;
    }
  }, [strategy]);

  // strategy 바뀌면 소스 파싱
  React.useEffect(() => {
    setNbSources(parseNbSources(strategy?.notebooklm_prompt));
  }, [strategy?.notebooklm_prompt]);

  const setField = async (field: string, val: string | number) => {
    const body = {
      ...strategy,
      notebooklm_prompt: JSON.stringify(nbSources),
      gemini_prompt: geminiPrompt,
      claude_prompt: claudePrompt,
      [field]: val,
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('설정 저장됨', 'ok'); } catch { toast?.('설정 저장 실패', 'err'); }
  };
  const saveStrategy = async () => {
    const body = {
      ...strategy,
      notebooklm_prompt: JSON.stringify(nbSources),
      gemini_prompt: geminiPrompt,
      claude_prompt: claudePrompt,
      strategy_document: strategyDoc,
      risk_prompt: riskPrompt,
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('프롬프트 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };
  const saveStrategyDoc = async () => {
    const body = {
      ...strategy,
      notebooklm_prompt: JSON.stringify(nbSources),
      gemini_prompt: geminiPrompt,
      claude_prompt: claudePrompt,
      strategy_document: strategyDoc,
      risk_prompt: riskPrompt,
    };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('전략서 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };
  const saveSecrets = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = {};
    fd.forEach((v, k) => { if (typeof v === 'string' && v.trim()) body[k] = v.trim(); });
    if (!Object.keys(body).length) { toast?.('변경할 키를 입력하세요', 'info'); return; }
    try { await api('/secrets', { method: 'PUT', body: JSON.stringify(body) }); (e.target as HTMLFormElement).reset(); toast?.('API 키 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };

  const steps = [
    { label: '참고 소스', sub: '소스 관리', color: 'amber', key: 'notebooklm_prompt',
      value: null, onChange: null,
      desc: 'AI 분석에 참고할 자료(뉴스 요약, 리서치 핵심 포인트)를 추가·삭제하세요. 여기서 등록한 소스가 매일 분석의 입력으로 사용됩니다.',
      placeholder: '' },
    { label: '분석 지시', sub: 'AI 분석 설정', color: 'blue', key: 'gemini_prompt',
      value: geminiPrompt, onChange: (v: string) => setGeminiPrompt(v),
      desc: 'AI가 종목을 분석할 때 따라야 할 규칙을 적어주세요. 예: "기관이 3일 이상 순매수한 종목만 보기", "소형주 제외" 등.',
      placeholder: `## CEO 추가 지시사항\n\n### 분석 우선순위\n1. 기관/외국인 수급 데이터를 최우선으로 분석하라. 3일 연속 순매수 종목만 주목.\n2. 최근 실적(영업이익) 증가 확인 필수. 적자전환 또는 실적 악화 종목은 즉시 제외.\n3. 52주 고점 대비 -10%~-25% 구간의 눌림목 종목을 우선 분석.\n\n### 제외 조건\n- 시가총액 5000억 미만 소형주\n- 테마주/급등주 (하루 +15% 이상)\n- 최근 30일 내 유상증자/CB 발행 종목` },
    { label: '매매 지시', sub: '매수·매도 규칙', color: 'emerald', key: 'claude_prompt',
      value: claudePrompt, onChange: (v: string) => setClaudePrompt(v),
      desc: 'AI가 실제로 사고팔 때 지켜야 할 규칙을 적어주세요. 예: "장 시작 30분은 매수 금지", "손절은 반드시 지켜라" 등.',
      placeholder: `## 매매 실행 추가 규칙\n\n### 매수 원칙\n- 장 시작 30분(09:00~09:30) 매수 금지\n- 14:30 이후 신규 매수 금지\n- 동일 종목 하루 1회만 매수\n\n### 매도 원칙\n- 손절은 반드시 지켜라. 감정적 판단 금지.\n- 2일 연속 하락 + 거래량 증가 시 즉시 매도\n- 익절 시 "조금 더" 판단 금지, 기계적 실행` },
  ];
  const colorMap: Record<string, { bg: string; border: string; text: string; dot: string; grad: string; activeBg: string }> = {
    amber:   { bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   text: 'text-amber-400',   dot: 'bg-amber-400',   grad: 'from-amber-500 to-orange-500', activeBg: 'bg-amber-950/20' },
    blue:    { bg: 'bg-blue-500/10',     border: 'border-blue-500/20',    text: 'text-blue-400',    dot: 'bg-blue-400',    grad: 'from-blue-500 to-cyan-500',    activeBg: 'bg-blue-950/20' },
    purple:  { bg: 'bg-purple-500/10',   border: 'border-purple-500/20',  text: 'text-purple-400',  dot: 'bg-purple-400',  grad: 'from-purple-500 to-pink-500',  activeBg: 'bg-purple-950/20' },
    emerald: { bg: 'bg-emerald-500/10',  border: 'border-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400', grad: 'from-emerald-500 to-teal-500', activeBg: 'bg-emerald-950/20' },
  };

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* ── 전략 이력 ── */}
      <StrategyTimelinePanel strategy={strategy} />

      {/* ── KIS 미설정 경고 ── */}
      {(!secrets?.kis_appkey?.exists || !secrets?.kis_appsecret?.exists) && (
        <div className="bg-amber-950/30 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
          <span className="text-amber-400 text-lg shrink-0">!</span>
          <div>
            <p className="text-sm font-bold text-amber-300">한국투자증권 API 키 미설정</p>
            <p className="text-[11px] text-slate-400 mt-1">실전 매매를 위해 아래 API 키 관리에서 KIS Key, Secret, 계좌번호를 입력하세요. 현재 모의투자 모드로 동작합니다.</p>
          </div>
        </div>
      )}

      {/* ── 상단: 킬스위치 + AI 실행 ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Panel title="긴급 제어">
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">자동매매 제어</p>
                <p className={`text-[12px] mt-1 font-medium ${(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? 'text-rose-400' : 'text-emerald-400'}`}>
                  현재: {(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? '매매 중단 중' : '자동매매 실행 중'}
                </p>
              </div>
              <button onClick={() => toggleKill()} className={`px-5 py-2.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-rose-700 hover:bg-rose-600 text-white'}`}>
                {(killSwitch?.kr?.active || killSwitch?.overseas?.active) ? '▶ 전체 재개' : '⏸ 전체 중단'}
              </button>
            </div>
            {/* 국내/해외 개별 상태 */}
            {(killSwitch?.kr?.active || killSwitch?.overseas?.active) && (
              <div className="space-y-2 pt-2 border-t border-white/[0.06]">
                {killSwitch?.kr?.active && (
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
                    <div className="min-w-0">
                      <p className="text-[12px] font-bold text-rose-400">국내 (KR) 중단 중</p>
                      {killSwitch.kr.reason && <p className="text-[10px] text-slate-500 mt-0.5 truncate">{killSwitch.kr.reason}</p>}
                    </div>
                    <button onClick={() => toggleKill('KR')} className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-600 hover:bg-amber-500 text-white shrink-0 transition-all">
                      국내 해제
                    </button>
                  </div>
                )}
                {killSwitch?.overseas?.active && (
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
                    <div className="min-w-0">
                      <p className="text-[12px] font-bold text-violet-400">해외 (US) 중단 중</p>
                      {killSwitch.overseas.reason && <p className="text-[10px] text-slate-500 mt-0.5 truncate">{killSwitch.overseas.reason}</p>}
                    </div>
                    <button onClick={() => toggleKill('OVERSEAS')} className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-violet-600 hover:bg-violet-500 text-white shrink-0 transition-all">
                      해외 해제
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </Panel>
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
                    // VAPID 키 최신 로드
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
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-1.5"
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

            {/* 알림 초기화 (VAPID 불일치 시 사용) */}
            <button
              onClick={async () => {
                if (!confirm('서버의 모든 구독을 삭제합니다. 이후 "이 기기 재등록"을 눌러 재등록하세요.')) return;
                try {
                  // 브라우저 구독도 해제
                  const reg = await navigator.serviceWorker.ready;
                  const existing = await reg.pushManager.getSubscription();
                  if (existing) await existing.unsubscribe();
                  // 서버 전체 삭제
                  await api('/push/subscriptions', { method: 'DELETE' });
                  toast?.('알림 초기화 완료 — "이 기기 재등록" 버튼으로 재등록하세요', 'ok');
                  setPushStatus(s => ({ ...s, subscribed: false }));
                } catch {
                  toast?.('초기화 실패 — 다시 시도해 주세요', 'err');
                }
              }}
              className="w-full px-4 py-2 bg-rose-900/20 hover:bg-rose-900/35 border border-rose-800/30 rounded-xl text-xs text-rose-400 transition-all"
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
      </div>
      {/* ── 전략 설정 ── */}
      {strategy && (
        <Panel title="전략 설정" badge={strategy.mode === 'SWING' ? '스윙' : strategy.mode === 'DEFENSE' ? '방어' : strategy.mode === 'SNIPER' ? '저격수' : '단타'} badgeColor={strategy.mode === 'SWING' ? 'blue' : strategy.mode === 'DEFENSE' ? 'rose' : strategy.mode === 'SNIPER' ? 'amber' : 'amber'}>
          <div className="px-6 py-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Sel label="매매 방식" value={strategy.mode} opts={[['SWING','스윙 (중단기)'],['DEFENSE','방어 (하락장)'],['SCALPING','단타 (당일)'],['SNIPER','🎯 저격수 (AI 88점+ 2종목 집중)']]} onChange={v => setField('mode', v)} />
              <Sel label="AI 확신도 (높을수록 신중)" value={strategy.buy_threshold} opts={[[70,'70점'],[75,'75점'],[78,'78점'],[80,'80점'],[83,'83점 (현재)'],[85,'85점'],[88,'88점'],[90,'90점']]} onChange={v => setField('buy_threshold', Number(v))} />
              <Sel label="손실 한계 (이 이상 빠지면 매도)" value={strategy.stop_loss_pct} opts={[[-1.5,'-1.5% (타이트)'],[-2,'-2%'],[-2.5,'-2.5%'],[-3,'-3% (현재)'],[-4,'-4%'],[-5,'-5% (여유)']]} onChange={v => setField('stop_loss_pct', Number(v))} />
              <Sel label="목표 수익 (이 이상 오르면 매도)" value={strategy.take_profit_pct} opts={[[3,'+3%'],[4,'+4%'],[5,'+5%'],[5.5,'+5.5% (현재)'],[6,'+6%'],[7,'+7%'],[8,'+8%']]} onChange={v => setField('take_profit_pct', Number(v))} />
            </div>
          </div>
        </Panel>
      )}

      {/* ── 전략서 + 리스크 운영 프롬프트 ── */}
      {strategy && (
        <div className="glass rounded-2xl overflow-hidden shadow-xl shadow-black/40">
          <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">나의 매매 철학 & 위기 대응</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">AI가 판단을 내릴 때 참고하는 나만의 투자 원칙을 적어두세요</p>
            </div>
            <button onClick={saveStrategyDoc} className="px-4 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-xs font-semibold transition-all">저장</button>
          </div>
          {/* 탭 */}
          <div className="flex border-b border-white/[0.04]">
            {([['doc', '전략서', '매매 철학·원칙'], ['risk', '리스크 프롬프트', 'AI 리스크 판단 지시']] as const).map(([id, label, sub]) => (
              <button key={id} onClick={() => setStrategyDocTab(id)}
                className={`flex-1 py-3 px-4 text-left transition-all relative ${strategyDocTab === id ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}>
                {strategyDocTab === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 to-fuchsia-500" />}
                <div className="text-[11px] font-bold text-slate-200">{label}</div>
                <div className="text-[9px] text-slate-600 mt-0.5">{sub}</div>
              </button>
            ))}
          </div>
          {strategyDocTab === 'doc' && (
            <div className="p-4 sm:p-5 bg-violet-950/10">
              <p className="text-[11px] text-slate-400 mb-3">
                매매 철학, 종목 선정 기준, 시장 상황별 대응 원칙 등을 자유롭게 작성하세요.
                AI 분석 맥락에 주입됩니다.
              </p>
              <textarea
                value={strategyDoc}
                onChange={e => setStrategyDoc(e.target.value)}
                rows={16}
                placeholder={`# 매매 전략서\n\n## 투자 철학\n- 추세 추종 + 분할 매수로 리스크 분산\n- 손절은 기계적으로, 익절은 단계적으로\n\n## 종목 선정 기준\n- 기관/외국인 수급 3일 연속 순매수\n- 52주 고점 대비 -10~-25% 눌림목\n- 최근 분기 실적 개선 확인 필수\n\n## 시장 상황별 대응\n### 상승장\n- 공격적 비중 확대, 익절 기준 상향\n\n### 횡보장\n- 스윙 비중 유지, 손절 기준 엄격 적용\n\n### 하락장 / 급락 시\n- 신규 매수 최소화, 기존 포지션 축소\n- 현금 비중 50% 이상 유지\n- RSS/뉴스 이상 신호 감지 시 즉시 킬스위치`}
                className="w-full bg-white/[0.04] border-0 ring-1 ring-violet-500/20 rounded-xl px-4 py-3.5 text-[12px] leading-relaxed resize-y font-mono text-slate-200 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
              />
            </div>
          )}
          {strategyDocTab === 'risk' && (
            <div className="p-4 sm:p-5 bg-rose-950/10">
              <p className="text-[11px] text-slate-400 mb-3">
                리스크 상황별 AI 판단 지시사항입니다. 급락장·하락장 대응, 포지션 축소 기준, 대통령 발언 등 외부 충격 대응 원칙을 작성하세요.
              </p>
              <textarea
                value={riskPrompt}
                onChange={e => setRiskPrompt(e.target.value)}
                rows={16}
                placeholder={`## 리스크 운영 지시사항\n\n### 하락장 감지 시\n- 전 종목 신규 매수 금지\n- 기존 포지션 -3% 이상 손실이면 즉시 청산\n- 현금 비중 60% 이상 유지\n\n### 급락 (-3% 이상 갭다운) 시\n- 개장 30분간 매수 완전 금지\n- 손절 기준 절반으로 타이트하게 운영\n\n### 외부 충격 (정치·경제 뉴스) 감지 시\n- RSS 뉴스에 미국 관세·금리·전쟁 키워드 → 포지션 50% 이상 즉시 축소\n- 대통령/연준 발언 → 당일 신규 매수 금지\n\n### 연속 손실 시 (3회 이상)\n- 매매 사이즈 절반으로 줄이기\n- Track A 재분석 후 재진입 여부 결정`}
                className="w-full bg-white/[0.04] border-0 ring-1 ring-rose-500/20 rounded-xl px-4 py-3.5 text-[12px] leading-relaxed resize-y font-mono text-slate-200 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-rose-500/40 transition-all"
              />
            </div>
          )}
        </div>
      )}

      {/* ── AI 파이프라인 프롬프트 (탭 UI) ── */}
      {strategy && (
        <div className="glass rounded-2xl overflow-hidden shadow-xl shadow-black/40">
          {/* 헤더 + 저장 버튼 */}
          <div className="px-6 py-4 border-b border-white/[0.05] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">AI 매매 지시 설정</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">AI가 분석하고 매매할 때 따르는 규칙을 탭별로 설정합니다</p>
            </div>
            <button onClick={saveStrategy} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-xs font-semibold transition-all">저장</button>
          </div>

          {/* 스텝 네비게이션 (가로 탭) */}
          <div className="flex border-b border-white/[0.04]">
            {steps.map((s, i) => {
              const sc = colorMap[s.color];
              const active = i === activeStep;
              return (
                <button key={s.label} onClick={() => setActiveStep(i)}
                  className={`flex-1 py-3 px-2 text-center transition-all relative ${active ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}>
                  {active && <div className={`absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r ${sc.grad}`} />}
                  <div className="flex items-center justify-center gap-1.5">
                    <div className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-black ${active ? `${sc.bg} ${sc.border} border ${sc.text}` : 'bg-slate-800 text-slate-500'}`}>{i + 1}</div>
                    <div className="text-left hidden sm:block">
                      <div className={`text-[11px] font-bold ${active ? sc.text : 'text-slate-400'}`}>{s.label}</div>
                      <div className="text-[9px] text-slate-600">{s.sub}</div>
                    </div>
                    <div className={`sm:hidden text-[11px] font-bold ${active ? sc.text : 'text-slate-400'}`}>{s.label}</div>
                  </div>
                  {i < steps.length - 1 && <span className="absolute right-0 top-1/2 -translate-y-1/2 text-slate-700 text-[10px]">&rarr;</span>}
                </button>
              );
            })}
          </div>

          {/* 모든 스텝 콘텐츠 (숨김 포함 — ref 유지를 위해 항상 렌더링) */}
          {steps.map((s, i) => {
            const sc = colorMap[s.color];
            const hidden = i !== activeStep;

            // ── Step 0: NotebookLM 소스 관리 ──
            if (i === 0) return (
              <div key={s.label} className={`p-4 sm:p-5 ${sc.activeBg} ${hidden ? 'hidden' : ''}`}>
                <p className="text-[11px] text-slate-400 mb-3">{s.desc}</p>

                {/* 소스 목록 */}
                <div className="space-y-2 mb-3">
                  {nbSources.length === 0 && (
                    <div className="text-[11px] text-slate-500 bg-slate-900/40 rounded-lg p-3 text-center">
                      소스가 없습니다. 아래에서 추가하세요.
                    </div>
                  )}
                  {nbSources.map((src) => {
                    const daysOld = src.created_at ? Math.floor((Date.now() - new Date(src.created_at).getTime()) / 86400000) : null;
                    const isHarmful = src.harm_suspected === true;
                    const isPendingDelete = nbPendingDeleteId === src.id;
                    return (
                    <div key={src.id} className={`bg-slate-900/60 border rounded-lg p-3 transition-all ${isHarmful ? 'border-rose-600/50 bg-rose-950/10' : 'border-amber-900/20'}`}>
                      {nbEditId === src.id ? (
                        <div className="space-y-2">
                          <input value={nbEditTitle} onChange={e => setNbEditTitle(e.target.value)}
                            className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                          <textarea value={nbEditContent} onChange={e => setNbEditContent(e.target.value)} rows={6}
                            className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                          <div className="flex gap-2">
                            <button onClick={() => {
                              setNbSources(prev => prev.map(x => x.id === src.id ? { ...x, title: nbEditTitle, content: nbEditContent } : x));
                              setNbEditId(null);
                            }} className="px-3 py-1 bg-amber-600 hover:bg-amber-500 rounded text-[11px] font-bold">저장</button>
                            <button onClick={() => setNbEditId(null)} className="px-3 py-1 bg-slate-700 rounded text-[11px] text-slate-400">취소</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-[11px] font-semibold text-amber-300 truncate">{src.title || '제목 없음'}</p>
                              {isHarmful && (
                                <span className="text-[9px] px-1.5 py-0.5 bg-rose-900/60 text-rose-300 rounded-full shrink-0 animate-pulse">⚠️ 수익 악영향 의심</span>
                              )}
                              {daysOld !== null && (
                                <span className="text-[9px] text-slate-600">{daysOld}일 전 등록</span>
                              )}
                            </div>
                            <p className="text-[10px] text-slate-400 mt-1 whitespace-pre-wrap line-clamp-3">{src.content}</p>
                          </div>
                          <div className="flex flex-col gap-1 shrink-0">
                            <button onClick={() => { setNbEditId(src.id); setNbEditTitle(src.title); setNbEditContent(src.content); setNbPendingDeleteId(null); }}
                              className="text-[10px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded">수정</button>
                            {/* 악영향 의심 토글 */}
                            <button onClick={() => setNbSources(prev => prev.map(x => x.id === src.id ? { ...x, harm_suspected: !x.harm_suspected } : x))}
                              className={`text-[9px] px-2 py-1 rounded transition-all ${isHarmful ? 'bg-rose-900/60 text-rose-300' : 'bg-slate-800 text-slate-500 hover:text-amber-400'}`}>
                              {isHarmful ? '⚠️ 플래그됨' : '⚠️ 악영향?'}
                            </button>
                            {/* 2단계 삭제 승인 */}
                            {isPendingDelete ? (
                              <button onClick={() => { setNbSources(prev => prev.filter(x => x.id !== src.id)); setNbPendingDeleteId(null); }}
                                className="text-[10px] px-2 py-1 bg-rose-600 text-white rounded font-bold animate-pulse">승인 삭제</button>
                            ) : (
                              <button onClick={() => setNbPendingDeleteId(src.id)}
                                className="text-[10px] px-2 py-1 bg-rose-900/40 text-rose-400 hover:bg-rose-800/40 rounded">삭제</button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>

                {/* 소스 추가 폼 */}
                {nbAdding ? (
                  <div className="bg-slate-900/60 border border-amber-700/30 rounded-lg p-3 space-y-2">
                    <input value={nbAddTitle} onChange={e => setNbAddTitle(e.target.value)}
                      placeholder="소스 제목 (예: 이번 주 시장 전망)"
                      className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                    <textarea value={nbAddContent} onChange={e => setNbAddContent(e.target.value)}
                      placeholder="뉴스 요약, 리서치 핵심 포인트 등 AI 분석에 참고할 내용을 붙여넣으세요..."
                      rows={6}
                      className="w-full bg-white/[0.05] border-0 ring-1 ring-white/[0.1] rounded-xl px-3.5 py-2.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all" />
                    <div className="flex gap-2">
                      <button onClick={() => {
                        if (!nbAddContent.trim()) return;
                        setNbSources(prev => [...prev, { id: crypto.randomUUID(), title: nbAddTitle.trim() || `소스 ${prev.length + 1}`, content: nbAddContent.trim(), created_at: new Date().toISOString() }]);
                        setNbAddTitle(''); setNbAddContent(''); setNbAdding(false);
                      }} className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-[11px] font-bold">추가</button>
                      <button onClick={() => { setNbAdding(false); setNbAddTitle(''); setNbAddContent(''); }}
                        className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-[11px] text-slate-400">취소</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setNbAdding(true)}
                    className="px-4 py-2 bg-amber-600/80 hover:bg-amber-600 rounded-lg text-[11px] font-bold">+ 소스 추가</button>
                )}
              </div>
            );

            // ── Steps 1–2: 텍스트에어리어 (controlled) ──
            return (
              <div key={s.label} className={`p-4 sm:p-5 ${sc.activeBg} ${hidden ? 'hidden' : ''}`}>
                <p className="text-[11px] text-slate-400 mb-3">{s.desc}</p>
                <textarea value={s.value ?? ''} onChange={e => s.onChange?.(e.target.value)} rows={10}
                  className="w-full bg-white/[0.04] border-0 ring-1 ring-white/[0.08] rounded-xl px-4 py-3.5 text-[11px] leading-relaxed resize-y font-mono text-slate-300 placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
                  placeholder={s.placeholder} />
              </div>
            );
          })}
        </div>
      )}

      {/* ── API 키 ── */}
      <div>
        <Panel title="API 키 관리">
          <form onSubmit={saveSecrets} autoComplete="off" className="px-6 py-5 space-y-3.5">
            {/* hidden dummy fields to absorb browser autofill */}
            <input type="text" name="fake_user" className="hidden" tabIndex={-1} />
            <input type="password" name="fake_pass" className="hidden" tabIndex={-1} />
            {[['gemini','Gemini AI'],['openai','OpenAI'],['anthropic','Anthropic AI'],['kis_appkey','KIS 앱키'],['kis_appsecret','KIS 시크릿'],['kis_account','KIS 계좌번호']].map(([k, l]) => (
              <div key={k} className="flex items-center gap-3">
                <span className="w-24 text-[12px] text-slate-400 shrink-0 font-medium">{l}</span>
                {secrets?.[k]?.exists && <span className="text-[9px] bg-emerald-900/40 text-emerald-400 px-2 py-0.5 rounded-full ring-1 ring-emerald-500/20 shrink-0">설정됨</span>}
                <input name={k} type="text" autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={secrets?.[k]?.masked || '미설정'} className="flex-1 bg-white/[0.05] border-0 ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all [-webkit-text-security:disc]" />
              </div>
            ))}
            <button type="submit" className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold transition-all mt-1">키 저장</button>
          </form>
        </Panel>

      </div>

      {/* ── 앱 보안 ── */}
      <Panel title="앱 보안">
        <div className="px-6 py-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-[12px] text-slate-500 shrink-0 font-medium">잠금 PIN 변경</p>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const newPin = String(fd.get('pin') ?? '').trim();
              if (newPin.length < 4) { alert('PIN은 4자리 이상'); return; }
              const data = new TextEncoder().encode(newPin);
              const hash = await crypto.subtle.digest('SHA-256', data);
              const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
              localStorage.setItem('quantops_pin', hex);
              toast?.('PIN 변경 완료', 'ok');
              (e.target as HTMLFormElement).reset();
            }} className="flex gap-2.5 flex-1 max-w-sm">
              <input name="pin" type="password" inputMode="numeric" autoComplete="new-password" data-1p-ignore data-lpignore="true" maxLength={6} placeholder="새 PIN (4~6자리)" className="flex-1 bg-white/[0.05] border-0 ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-center tracking-widest font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all" />
              <button type="submit" className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold shrink-0 transition-all">변경</button>
            </form>
            <button type="button" onClick={() => {
              localStorage.removeItem('quantops_cred_id');
              localStorage.removeItem('quantops_auth_ts');
              toast?.('생체인증 초기화 완료', 'ok');
            }} className="text-[11px] text-slate-600 hover:text-slate-400 shrink-0 transition-colors">생체인증 초기화</button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export default SettingsView;
