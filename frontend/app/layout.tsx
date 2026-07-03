import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Auto Bot',
  description: 'AI Auto Bot Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
        <style dangerouslySetInnerHTML={{ __html: `@font-face { font-family: 'Pretendard Variable'; font-display: swap; }` }} />
        <link rel="icon" href="/icon-192.svg" type="image/svg+xml" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0f172a" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="apple-touch-icon" href="/icon-192.svg" />
      </head>
      <body className="antialiased bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/sw.js').then(function(reg) {
                  // 1분마다 SW 업데이트 체크 (배포 반영 가속)
                  setInterval(function() { reg.update(); }, 60000);
                }).catch(function() {});
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
