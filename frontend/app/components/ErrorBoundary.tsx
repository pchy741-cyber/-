'use client';

import React from 'react';
import { Button } from '@/components/ui';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="glass rounded-2xl border border-rose-500/20 p-6 text-center space-y-3">
          <div className="text-2xl">⚠️</div>
          <p className="text-sm font-bold text-rose-300">
            {this.props.fallbackTitle ?? '화면 로딩 중 오류가 발생했습니다'}
          </p>
          <p className="text-[11px] text-slate-500 max-w-sm mx-auto break-all">
            {this.state.error?.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            다시 시도
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
