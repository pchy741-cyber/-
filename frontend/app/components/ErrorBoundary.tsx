'use client';

import React from 'react';
import { Button, Spinner } from '@/components/ui';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

const DB_HINTS = ['DB 연결', '서버에 연결', 'ECONNREFUSED', 'ETIMEDOUT', 'connection'];

function isDbRelated(msg: string): boolean {
  return DB_HINTS.some(h => msg.includes(h));
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

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

  componentDidUpdate(_: ErrorBoundaryProps, prevState: ErrorBoundaryState) {
    if (this.state.hasError && !prevState.hasError && this.state.error && isDbRelated(this.state.error.message)) {
      this.retryTimer = setTimeout(() => this.setState({ hasError: false, error: null }), 5000);
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const dbError = this.state.error && isDbRelated(this.state.error.message);

    if (dbError) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <div className="w-8 h-8 border-2 border-blue-400/50 border-t-blue-400 rounded-full animate-spin" />
          <p className="text-sm text-slate-400">DB 연결 중... 자동 재시도합니다</p>
          <Button
            variant="ghost" size="sm"
            className="text-[11px] text-slate-500"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            지금 재시도
          </Button>
        </div>
      );
    }

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
}
