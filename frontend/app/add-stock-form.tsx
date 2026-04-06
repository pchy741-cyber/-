'use client';

import React, { useRef, useState } from 'react';

interface Props {
  onAdd: (name: string, code: string, market: string) => Promise<void>;
}

export default function AddStockForm({ onAdd }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get('name') as string)?.trim() ?? '';
    const code = (fd.get('code') as string)?.trim() ?? '';
    const normalizedCode = code.replace(/\D/g, '');
    const market = (fd.get('market') as string) || 'KOSPI';
    if (normalizedCode.length !== 6) return;
    setSubmitting(true);
    try {
      await onAdd(name || normalizedCode, normalizedCode, market);
      formRef.current?.reset();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div>
        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">종목명</label>
        <input
          type="text"
          name="name"
          placeholder="예: 삼성전자 (선택)"
          autoComplete="off"
          className="px-3 py-2 text-sm bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100 w-48"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">종목코드</label>
        <input
          type="text"
          name="code"
          placeholder="예: 005930"
          inputMode="numeric"
          maxLength={6}
          autoComplete="off"
          className="px-3 py-2 text-sm bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100 w-36"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">시장</label>
        <select
          name="market"
          defaultValue="KOSPI"
          className="px-3 py-2 text-sm bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
        >
          <option value="KOSPI">KOSPI</option>
          <option value="KOSDAQ">KOSDAQ</option>
        </select>
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5"
      >
        {submitting ? '추가 중...' : '+ 추가'}
      </button>
    </form>
  );
}
