'use client';

import React from 'react';
import { Button } from './action';

const BTN_VARIANT_KEYS = ['primary', 'secondary', 'danger', 'ghost', 'success', 'amber', 'violet'] as const;
type BtnVariant = (typeof BTN_VARIANT_KEYS)[number];

export function Modal({
  open, onClose, children, maxWidth = 'max-w-sm',
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className={`${maxWidth} w-full bg-[#0f1422] border border-white/[0.08] rounded-2xl shadow-2xl`} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function ConfirmModal({
  open, onClose, onConfirm,
  title, description, confirmLabel = '확인', confirmVariant = 'danger',
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: BtnVariant;
  children?: React.ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="p-5">
        <div className="flex items-start gap-3 mb-4">
          <span className="text-2xl shrink-0">⚠️</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-100 mb-1">{title}</p>
            {description && <p className="text-[11px] text-slate-400 leading-relaxed">{description}</p>}
          </div>
        </div>
        {children && <div className="mb-4">{children}</div>}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className="flex-1 py-2.5" onClick={onClose}>취소</Button>
          <Button variant={confirmVariant} size="sm" className="flex-1 py-2.5" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
