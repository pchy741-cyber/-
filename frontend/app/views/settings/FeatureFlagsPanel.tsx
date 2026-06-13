'use client';

import React, { useState, useEffect } from 'react';
import { Panel } from '@/components/ui';
import { api } from '../../lib/utils';
import type { ToastFn, ConfirmFn, FeatureFlag } from '../../types';

export function FeatureFlagsPanel({ toast, confirm, onFlagChange }: { toast: ToastFn; confirm: ConfirmFn; onFlagChange?: (key: string, enabled: boolean) => void }) {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);

  useEffect(() => {
    api('/feature-flags').then(r => setFlags(r.flags || [])).catch(() => {});
  }, []);

  const toggle = async (key: string, enabled: boolean) => {
    const label = key === 'dividend_investing' ? '월배당 투자' : key;
    const warn: string | undefined = undefined;
    if (!await confirm({ title: `${label} 기능을 ${enabled ? '활성화' : '비활성화'}하시겠습니까?`, description: warn, confirmLabel: enabled ? '활성화' : '비활성화', confirmVariant: enabled ? 'primary' : 'danger' })) return;
    try {
      await api(`/feature-flags/${key}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      setFlags(prev => prev.map(f => f.key === key ? { ...f, enabled } : f));
      onFlagChange?.(key, enabled);
      toast?.(`${label} ${enabled ? 'ON' : 'OFF'}`, 'ok');
    } catch (e: unknown) { toast?.((e as Error).message, 'err'); }
  };

  const flagMeta: Record<string, { icon: string; label: string; desc: string }> = {
    dividend_investing: { icon: '💰', label: '월배당 투자', desc: '월배당 ETF/주식으로 안정적 현금흐름 (장기)' },
  };

  if (flags.length === 0) return (
    <Panel title="확장 기능">
      <div className="text-center py-4 text-sm text-slate-500">기능 초기화 중... 잠시 후 새로고침하세요</div>
    </Panel>
  );

  return (
    <Panel title="확장 기능">
      <div className="space-y-3">
        {flags.map(f => {
          const meta = flagMeta[f.key] || { icon: '⚡', label: f.key, desc: '' };
          return (
            <div key={f.key} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <span className="text-lg">{meta.icon}</span>
                <div>
                  <div className="text-sm font-medium text-slate-200">{meta.label}</div>
                  <div className="text-[10px] text-slate-500">{meta.desc}</div>
                </div>
              </div>
              <button
                onClick={() => toggle(f.key, !f.enabled)}
                className={`relative w-11 h-6 rounded-full transition-all ${f.enabled ? 'bg-blue-600' : 'bg-slate-700'}`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${f.enabled ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
