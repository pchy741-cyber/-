/**
 * 커뮤니티 감성 — 네이버 금융 토론방 스크래핑 (무료, 키 없음)
 *
 * 종목별 네이버 토론방 최근 제목 수집 → 긍/부정 키워드 비율로 감성 점수화
 * - 로봇 차단 대비: 낮은 요청 주기 + User-Agent 설정
 * - 실패 시 빈 배열 반환 (파이프라인 차단 없음)
 * - 2시간 캐시 (무료 스크래핑 한도 보호)
 */

import { logger } from '../utils/logger.js';

export interface CommunitySentiment {
  stockCode: string;
  companyName: string;
  score: number;       // -100(극부정)~100(극긍정)
  postCount: number;   // 수집 게시글 수
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const _cache = new Map<string, { data: CommunitySentiment; fetchedAt: number }>();

const POSITIVE_WORDS = ['상승', '급등', '호재', '매수', '돌파', '강세', '신고가', '저점', '반등', '추천', '목표가', '상향', '흑자', '성장', '기대'];
const NEGATIVE_WORDS = ['하락', '급락', '악재', '매도', '주의', '약세', '신저가', '고점', '손절', '폭락', '위험', '하향', '적자', '우려', '조심'];

function scoreTitles(titles: string[]): number {
  if (titles.length === 0) return 0;
  let pos = 0, neg = 0;
  for (const t of titles) {
    for (const w of POSITIVE_WORDS) if (t.includes(w)) pos++;
    for (const w of NEGATIVE_WORDS) if (t.includes(w)) neg++;
  }
  const total = pos + neg;
  if (total === 0) return 0;
  return Math.round(((pos - neg) / total) * 100);
}

async function fetchNaverBoardTitles(stockCode: string): Promise<string[]> {
  const url = `https://finance.naver.com/item/board.nhn?code=${stockCode}&page=1`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Referer: 'https://finance.naver.com/',
    },
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`Naver HTTP ${res.status}`);

  const html = await res.text();
  const titles: string[] = [];

  // <a class="title" ...>제목</a> 패턴 추출
  const re = /class="title"[^>]*>\s*([^<]{2,60})\s*</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && titles.length < 15) {
    const t = m[1].trim();
    if (t && !t.includes('등록') && t.length > 2) titles.push(t);
  }
  return titles;
}

/**
 * 감시목록 종목들의 네이버 토론방 감성 분석
 * 실패해도 빈 배열 반환 (파이프라인 차단 없음)
 */
export async function getCommunitysentiment(
  stocks: Array<{ stockCode: string; companyName: string }>,
): Promise<CommunitySentiment[]> {
  const now = Date.now();
  const results: CommunitySentiment[] = [];

  // 최대 8종목만 (과도한 스크래핑 방지)
  const targets = stocks.slice(0, 8);

  for (const { stockCode, companyName } of targets) {
    const cached = _cache.get(stockCode);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      results.push(cached.data);
      continue;
    }

    try {
      const titles = await fetchNaverBoardTitles(stockCode);
      const score = scoreTitles(titles);
      const sentiment: CommunitySentiment = { stockCode, companyName, score, postCount: titles.length };
      _cache.set(stockCode, { data: sentiment, fetchedAt: now });
      results.push(sentiment);

      // 요청 간 딜레이 (봇 차단 방지)
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      logger.debug(`네이버 토론방 스크래핑 실패 (${stockCode}): ${err}`, { component: 'COMMUNITY' });
    }
  }

  if (results.length > 0) {
    logger.info(`🗣️ 커뮤니티 감성 ${results.length}종목 수집 완료`, { component: 'COMMUNITY' });
  }
  return results;
}
