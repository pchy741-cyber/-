'use client';

import React from 'react';
import { Panel, Button, Spinner } from '@/components/ui';

export function NewsSummaryPanel({
  summary, summaryError, summaryLoading, summaryRefreshing, summaryHeadlines,
  summaryGeminiOk, summaryStale,
  aiEngineStatus, geminiTest, geminiTesting,
  testGemini, fetchSummary,
}: {
  summary: string;
  summaryError: string | null;
  summaryLoading: boolean;
  summaryRefreshing: boolean;
  summaryHeadlines: number;
  summaryGeminiOk: boolean;
  summaryStale: boolean;
  aiEngineStatus: { gemini: string; claude: string; activeEngine: string } | null;
  geminiTest: { ok: boolean; latencyMs: number; model: string; error: string | null; errorDetail: string | null; rawError: string; response?: string } | null;
  geminiTesting: boolean;
  testGemini: () => void;
  fetchSummary: (force: boolean) => void;
}) {
  // 캐시 텍스트가 있다는 것과 "지금 Gemini가 정상 응답했다"는 것은 다름 —
  // fallback(무료 요약) 출처거나 stale 캐시면 그렇게 명시한다.
  const badgeLabel =
    summaryLoading ? undefined :
    summary && summaryGeminiOk && !summaryStale ? 'Gemini 정상' :
    summary && summaryGeminiOk && summaryStale ? 'Gemini (캐시, 갱신중)' :
    summary && !summaryGeminiOk ? '요약(Gemini 미사용)' :
    summaryError === 'rss_failed' ? 'RSS 실패' :
    summaryError === 'gemini_quota' ? 'Gemini 한도 초과' :
    summaryError === 'no_key' ? 'API 키 없음' :
    summaryError ? 'Gemini 오류' : undefined;
  const badgeColorValue =
    summaryLoading ? undefined :
    summary && summaryGeminiOk && !summaryStale ? 'emerald' :
    summary ? 'amber' : 'rose';
  return (
    <Panel title="AI 시황 요약" badge={badgeLabel} badgeColor={badgeColorValue}>
      <div className="p-4 space-y-3">
        {summaryLoading ? (
          <div className="space-y-3 animate-pulse">
            <div className="flex items-center gap-2">
              <Spinner size="md" color="amber" className="shrink-0" />
              <span className="text-[10px] text-slate-500">Gemini 분석 중... (최대 45초)</span>
            </div>
            <div className="space-y-2">
              <div className="h-2.5 bg-white/[0.04] rounded w-full" />
              <div className="h-2.5 bg-white/[0.04] rounded w-4/5" />
              <div className="h-2.5 bg-white/[0.04] rounded w-3/5" />
            </div>
          </div>
        ) : summary ? (
          <p className="text-sm text-slate-200 leading-relaxed">{summary}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-400">
              {summaryError === 'rss_failed' && '글로벌 뉴스 RSS 수집에 실패했습니다. 네트워크 상태를 확인하세요.'}
              {summaryError === 'gemini_quota' && 'Gemini API 일일 무료 한도를 초과했습니다. 내일 다시 시도됩니다.'}
              {summaryError === 'no_key' && 'GEMINI_API_KEY가 설정되지 않았습니다.'}
              {summaryError === 'gemini_failed' && `Gemini API 호출에 실패했습니다${summaryHeadlines > 0 ? ` (뉴스 ${summaryHeadlines}건 수집됨)` : ''}.`}
              {summaryError === 'gemini_empty' && 'Gemini가 빈 응답을 반환했습니다.'}
              {summaryError === 'network' && '네트워크 오류로 요약을 불러오지 못했습니다.'}
              {!summaryError && '뉴스 요약을 불러오지 못했습니다.'}
            </p>
          </div>
        )}

        {/* 트레이딩봇 AI 엔진 상태 */}
        {aiEngineStatus && (
          <div className="rounded-lg px-3 py-2 text-xs bg-slate-900/60 border border-slate-700/40 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-slate-500 shrink-0">트레이딩봇 감지:</span>
            <span className={`flex items-center gap-1 ${aiEngineStatus.gemini === 'ok' ? 'text-emerald-400' : aiEngineStatus.gemini === 'quota' ? 'text-amber-400' : aiEngineStatus.gemini === 'error' ? 'text-rose-400' : 'text-slate-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${aiEngineStatus.gemini === 'ok' ? 'bg-emerald-400' : aiEngineStatus.gemini === 'quota' ? 'bg-amber-400' : aiEngineStatus.gemini === 'error' ? 'bg-rose-400' : 'bg-slate-600'}`} />
              Gemini: {aiEngineStatus.gemini === 'ok' ? '정상' : aiEngineStatus.gemini === 'quota' ? '할당량 초과' : aiEngineStatus.gemini === 'error' ? '오류' : aiEngineStatus.gemini}
            </span>
            <span className="text-slate-600">활성: {aiEngineStatus.activeEngine}</span>
          </div>
        )}

        {/* Gemini 직접 연결 테스트 결과 */}
        {geminiTest && (
          <div className={`rounded-lg px-3 py-2.5 text-xs space-y-1.5 border ${geminiTest.ok ? 'bg-emerald-950/40 border-emerald-700/40' : 'bg-rose-950/40 border-rose-700/40'}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-semibold ${geminiTest.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                {geminiTest.ok ? `✓ 연결 성공 (${geminiTest.model})` : `✗ 연결 실패 (${geminiTest.model})`}
              </span>
              {geminiTest.latencyMs > 0 && (
                <span className="text-slate-500">{geminiTest.latencyMs.toLocaleString()}ms</span>
              )}
            </div>
            {geminiTest.errorDetail && (
              <p className="text-amber-200/80 leading-relaxed">{geminiTest.errorDetail}</p>
            )}
            {geminiTest.rawError && (
              <pre className="text-rose-300/60 font-mono text-[10px] whitespace-pre-wrap break-all leading-relaxed max-h-20 overflow-y-auto">{geminiTest.rawError}</pre>
            )}
            {geminiTest.response && (
              <p className="text-emerald-300/70">응답: "{geminiTest.response}"</p>
            )}
          </div>
        )}

        {/* 버튼 행 */}
        {!summaryLoading && (
          <div className="flex items-center gap-2 justify-end flex-wrap">
            <Button variant="ghost" size="sm" className="flex items-center gap-1.5 bg-violet-900/30 text-violet-300 hover:bg-violet-800/40"
              disabled={geminiTesting} onClick={testGemini}>
              {geminiTesting ? (
                <Spinner size="xs" color="violet" as="span" />
              ) : (
                <span>⚡</span>
              )}
              Gemini 연결 테스트
            </Button>
            <Button variant="secondary" size="sm" className="flex items-center gap-1.5"
              disabled={summaryRefreshing} onClick={() => fetchSummary(true)}>
              {summaryRefreshing ? (
                <Spinner size="xs" color="slate" as="span" />
              ) : (
                <span>↻</span>
              )}
              다시 불러오기
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
