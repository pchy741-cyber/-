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
  score: number; // -100(극부정)~100(극긍정)
  postCount: number; // 수집 게시글 수
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const _cache = new Map<string, { data: CommunitySentiment; fetchedAt: number }>();
const CACHE_MAX_ENTRIES = 500;

// 만료 엔트리 자동 정리 (30분 주기)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) _cache.delete(key);
  }
  if (_cache.size > CACHE_MAX_ENTRIES) _cache.clear();
}, 30 * 60 * 1000).unref();

// v20: 토론방 제목은 뉴스 헤드라인보다 훨씬 캐주얼/은어 위주라 목록 확대
const POSITIVE_WORDS = [
  '상승', '급등', '호재', '매수', '돌파', '강세', '신고가', '저점', '반등', '추천',
  '목표가', '상향', '흑자', '성장', '기대', '떡상', '가즈아', '줍줍', '따상', '수익',
  '익절', '불장', '풀매수', '올인', '가보자', '홀딩', '존버', '대박', '수급', '상따',
  '고점돌파', '거래량터짐', '외국인매수', '기관매수', '갭상승', '장대양봉', '순매수',
];
const NEGATIVE_WORDS = [
  '하락', '급락', '악재', '매도', '주의', '약세', '신저가', '고점', '손절', '폭락',
  '위험', '하향', '적자', '우려', '조심', '물림', '물타기', '개미지옥', '설거지',
  '작전', '먹튀', '탈출', '빤스런', '패닉셀', '외국인매도', '기관매도', '순매도',
  '장대음봉', '갭하락', '거품', '상폐', '관리종목',
];

function scoreTitles(titles: string[]): number {
  if (titles.length === 0) return 0;
  let pos = 0,
    neg = 0;
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
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null && titles.length < 15) {
    const t = m[1].trim();
    if (t && !t.includes('등록') && t.length > 2) titles.push(t);
    m = re.exec(html);
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

  // v20: 8종목 제한 → 20종목으로 확대. 2시간 캐시가 있어 반복 호출은 캐시로 흡수되고,
  // 워치리스트가 30종목 안팎이라 8종목 고정이면 대부분 종목이 영구적으로 커뮤니티 신호를 못 받았음.
  const targets = stocks.slice(0, 20);

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
