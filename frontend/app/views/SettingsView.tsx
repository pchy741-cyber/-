'use client';

import React, { useState } from 'react';
import { Panel } from '@/components/ui';
import { api } from '../lib/utils';
import { StrategyTimelinePanel } from '../panels/SmallPanels';
import { parseNbSources } from './settings/settings-types';
import type { NbSource } from './settings/settings-types';
import { KillSwitchPanel } from './settings/KillSwitchPanel';
import { PushNotificationPanel } from './settings/PushNotificationPanel';
import { StrategySettingsPanel } from './settings/StrategySettingsPanel';
import { StrategyDocPanel } from './settings/StrategyDocPanel';
import { AiPipelinePanel } from './settings/AiPipelinePanel';
import { FeatureFlagsPanel } from './settings/FeatureFlagsPanel';

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

function SettingsView({ strategy, setStrategy, secrets, killSwitch, toggleKill, toast, confirm, onFeatureFlagChange }: any) {
  const [nbSources, setNbSources] = useState<NbSource[]>(() => parseNbSources(strategy?.notebooklm_prompt));

  // 프롬프트 로컬 상태 — strategy 최초 로드 시 한 번만 초기화
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

  React.useEffect(() => {
    setNbSources(parseNbSources(strategy?.notebooklm_prompt));
  }, [strategy?.notebooklm_prompt]);

  const buildBody = () => ({
    ...strategy,
    notebooklm_prompt: JSON.stringify(nbSources),
    gemini_prompt: geminiPrompt,
    claude_prompt: claudePrompt,
    strategy_document: strategyDoc,
    risk_prompt: riskPrompt,
  });

  const setField = async (field: string, val: string | number | boolean) => {
    const body = { ...buildBody(), [field]: val };
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(body) }); setStrategy(u); toast?.('설정 저장됨', 'ok'); } catch { toast?.('설정 저장 실패', 'err'); }
  };

  const saveStrategy = async () => {
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(buildBody()) }); setStrategy(u); toast?.('프롬프트 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };

  const saveStrategyDoc = async () => {
    try { const u = await api('/strategy', { method: 'PUT', body: JSON.stringify(buildBody()) }); setStrategy(u); toast?.('전략서 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };

  const saveSecrets = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = {};
    fd.forEach((v, k) => { if (typeof v === 'string' && v.trim()) body[k] = v.trim(); });
    if (!Object.keys(body).length) { toast?.('변경할 키를 입력하세요', 'info'); return; }
    try { await api('/secrets', { method: 'PUT', body: JSON.stringify(body) }); (e.target as HTMLFormElement).reset(); toast?.('API 키 저장 완료', 'ok'); } catch (err: any) { toast?.(err.message, 'err'); }
  };

  return (
    <div className="space-y-5 sm:space-y-6">
      <StrategyTimelinePanel strategy={strategy} />

      {/* KIS 미설정 경고 */}
      {(!secrets?.kis_appkey?.exists || !secrets?.kis_appsecret?.exists) && (
        <div className="bg-amber-950/30 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
          <span className="text-amber-400 text-lg shrink-0">!</span>
          <div>
            <p className="text-sm font-bold text-amber-300">한국투자증권 API 키 미설정</p>
            <p className="text-[11px] text-slate-400 mt-1">실전 매매를 위해 아래 API 키 관리에서 KIS Key, Secret, 계좌번호를 입력하세요. 현재 모의투자 모드로 동작합니다.</p>
          </div>
        </div>
      )}

      {/* 킬스위치 + 알림 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <KillSwitchPanel killSwitch={killSwitch} toggleKill={toggleKill} />
        <PushNotificationPanel toast={toast} confirm={confirm} />
      </div>

      {/* 전략 설정 */}
      <StrategySettingsPanel strategy={strategy} setField={setField} />

      {/* 전략서 + 리스크 */}
      {strategy && (
        <StrategyDocPanel
          strategyDoc={strategyDoc} setStrategyDoc={setStrategyDoc}
          riskPrompt={riskPrompt} setRiskPrompt={setRiskPrompt}
          strategyDocTab={strategyDocTab} setStrategyDocTab={setStrategyDocTab}
          onSave={saveStrategyDoc}
        />
      )}

      {/* AI 파이프라인 */}
      {strategy && (
        <AiPipelinePanel
          nbSources={nbSources} setNbSources={setNbSources}
          geminiPrompt={geminiPrompt} setGeminiPrompt={setGeminiPrompt}
          claudePrompt={claudePrompt} setClaudePrompt={setClaudePrompt}
          onSave={saveStrategy}
        />
      )}

      {/* API 키 */}
      <Panel title="API 키 관리">
        <form onSubmit={saveSecrets} autoComplete="off" className="px-6 py-5 space-y-3.5">
          <input type="text" name="fake_user" className="hidden" tabIndex={-1} />
          <input type="password" name="fake_pass" className="hidden" tabIndex={-1} />
          {[['gemini','Gemini AI'],['openai','OpenAI'],['anthropic','Anthropic AI'],['kis_appkey','KIS 앱키'],['kis_appsecret','KIS 시크릿'],['kis_account','KIS 계좌번호']].map(([k, l]) => (
            <div key={k} className="flex items-center gap-3">
              <span className="w-24 text-[12px] text-slate-400 shrink-0 font-medium">{l}</span>
              {secrets?.[k]?.exists && <span className="text-[9px] bg-emerald-900/40 text-emerald-400 px-2 py-0.5 rounded-full ring-1 ring-emerald-500/20 shrink-0">설정됨</span>}
              <input name={k} type="text" autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={secrets?.[k]?.masked || '미설정'} className="flex-1 bg-white/[0.05] border-0 ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all [-webkit-text-security:disc]" />
            </div>
          ))}
          <button type="submit" className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold transition-all shadow-sm mt-1">키 저장</button>
        </form>
      </Panel>

      {/* 앱 보안 */}
      <Panel title="앱 보안">
        <div className="px-6 py-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-[12px] text-slate-500 shrink-0 font-medium">잠금 PIN 변경</p>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const newPin = String(fd.get('pin') ?? '').trim();
              if (newPin.length < 4) { toast?.('PIN은 4자리 이상 입력하세요', 'err'); return; }
              const data = new TextEncoder().encode(newPin);
              const hash = await crypto.subtle.digest('SHA-256', data);
              const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
              localStorage.setItem('quantops_pin', hex);
              toast?.('PIN 변경 완료', 'ok');
              (e.target as HTMLFormElement).reset();
            }} className="flex gap-2.5 flex-1 max-w-sm">
              <input name="pin" type="password" inputMode="numeric" autoComplete="new-password" data-1p-ignore data-lpignore="true" maxLength={6} placeholder="새 PIN (4~6자리)" className="flex-1 bg-white/[0.05] border-0 ring-1 ring-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-center tracking-widest font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all" />
              <button type="submit" className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold shrink-0 transition-all shadow-sm">변경</button>
            </form>
            <button type="button" onClick={() => {
              localStorage.removeItem('quantops_cred_id');
              localStorage.removeItem('quantops_auth_ts');
              toast?.('생체인증 초기화 완료', 'ok');
            }} className="text-[11px] text-slate-600 hover:text-slate-400 shrink-0 transition-colors">생체인증 초기화</button>
          </div>
        </div>
      </Panel>

      <FeatureFlagsPanel toast={toast} confirm={confirm} onFlagChange={onFeatureFlagChange} />
    </div>
  );
}

export default SettingsView;
