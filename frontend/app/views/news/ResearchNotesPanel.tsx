'use client';

import React from 'react';

// 추천 금융 사이트 (공신력 + 매매 확률 향상에 유용)
const RECOMMENDED_SITES = [
  { name: 'DART 전자공시', url: 'https://dart.fss.or.kr', icon: '📋', desc: '금감원 공식 — 실적공시/대량보유/내부거래 (1순위 필수)' },
  { name: '네이버 증권', url: 'https://finance.naver.com', icon: '🟢', desc: '국내 최대 — 실시간시세/차트/뉴스/증권사리포트/종목토론' },
  { name: 'KRX 정보데이터', url: 'https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd', icon: '📊', desc: '거래소 공식 — 수급/공매도/프로그램매매/시장통계' },
  { name: 'FnGuide', url: 'https://comp.fnguide.com', icon: '📈', desc: '기관급 분석 — 재무비율/컨센서스/밸류에이션 (증권사 동일DB)' },
  { name: '한경 컨센서스', url: 'https://consensus.hankyung.com', icon: '📰', desc: '증권사 리포트 집계 — 목표가/투자의견/실적추정치 비교' },
  { name: 'SEC EDGAR', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=&dateb=&owner=include&count=40&search_text=&action=getcompany', icon: '🇺🇸', desc: '미국 공식 — 10-K/10-Q/Form4/13F (미국주식 1순위)' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com', icon: '💰', desc: '세계 최대 금융포털 — 실시간시세/실적/배당/뉴스 (MAU 1억+)' },
  { name: 'TradingView', url: 'https://www.tradingview.com', icon: '📉', desc: '세계 최대 차트 — 기술적분석/글로벌시세/5000만 트레이더' },
  { name: 'Finviz', url: 'https://finviz.com/screener.ashx', icon: '🔍', desc: '미국 스크리너 1위 — 히트맵/펀더멘털/기술적필터/실적캘린더' },
  { name: 'Investing.com', url: 'https://kr.investing.com/economic-calendar', icon: '🌍', desc: '글로벌 경제캘린더 — FOMC/고용/CPI/GDP (4600만 MAU)' },
  { name: 'CNN Fear & Greed', url: 'https://edition.cnn.com/markets/fear-and-greed', icon: '😱', desc: '시장심리 대표지표 — VIX/풋콜비율/정크본드스프레드 종합' },
  { name: 'FRED', url: 'https://fred.stlouisfed.org', icon: '🏛️', desc: '미연준 공식 경제DB — 금리/인플레/실업률/M2 (81만개 시계열)' },
];

export default function ResearchNotesPanel() {
  return (
    <div className="space-y-1.5 max-h-[50vh] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#4c1d95_transparent]">
      {RECOMMENDED_SITES.map((site, i) => (
        <a
          key={i}
          href={site.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 bg-white/[0.02] hover:bg-white/[0.05] rounded-xl px-3 py-2.5 group transition-colors"
        >
          <div className="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
            <span className="text-[12px]">{site.icon}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-200 font-medium group-hover:text-violet-300 transition-colors">{site.name}</p>
            <p className="text-[10px] text-slate-500 mt-0.5 truncate">{site.desc}</p>
          </div>
          <span className="text-[10px] text-slate-700 group-hover:text-slate-400 shrink-0 transition-colors">→</span>
        </a>
      ))}
    </div>
  );
}
