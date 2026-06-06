/**
 * seed-watchlist.ts — KOSPI 시총 상위 종목 씨앗 감시목록
 *
 * 서버 부팅 시 1회 실행 — 주요 우량주를 워치리스트에 자동 등록.
 * Track A 분석 대상 = 워치리스트 ← 여기 없으면 영원히 점수 없음.
 *
 * 선정 기준:
 *   - 코스피 시총 100위 내 주요 테마 대표주
 *   - AI 점수 없어도 선제 편입 (씨앗이므로)
 */

import { getPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ── KOSPI 씨앗 감시목록 ──────────────────────────────────────────────────
// 시총/테마별 대표 우량주 — Track A가 항상 분석해야 하는 종목
const SEED_STOCKS: Array<{ code: string; name: string; theme: string }> = [
  // 반도체/전자
  { code: '005930', name: '삼성전자',        theme: '반도체' },
  { code: '000660', name: 'SK하이닉스',      theme: '반도체' },
  { code: '005935', name: '삼성전자(우)',    theme: '반도체' },
  { code: '009150', name: '삼성전기',        theme: '전자부품' },
  { code: '011760', name: 'LG이노텍',        theme: '전자부품' },   // 애플 카메라 모듈
  { code: '066970', name: 'LG이노텍',        theme: '전자부품' },   // 코드 확인용 (하나만 적용됨)
  { code: '000990', name: 'DB하이텍',        theme: '반도체' },
  { code: '058470', name: '리노공업',        theme: '반도체' },

  // 방산
  { code: '012450', name: '한화에어로스페이스', theme: '방산' },
  { code: '272210', name: '한화시스템',      theme: '방산' },
  { code: '064350', name: '현대로템',        theme: '방산' },
  { code: '079550', name: 'LIG넥스원',       theme: '방산' },
  { code: '047810', name: '한국항공우주',    theme: '방산' },
  { code: '012330', name: '현대모비스',      theme: '방산/자동차' },

  // 조선/중공업
  { code: '009540', name: 'HD한국조선해양', theme: '조선' },
  { code: '267250', name: 'HD현대',          theme: '조선' },
  { code: '010140', name: '삼성중공업',      theme: '조선' },
  { code: '042660', name: '한화오션',        theme: '조선' },

  // 에너지/원전
  { code: '034020', name: '두산에너빌리티', theme: '에너지' },
  { code: '052690', name: '한전기술',        theme: '에너지' },
  { code: '015760', name: '한국전력',        theme: '에너지' },

  // 자동차
  { code: '005380', name: '현대차',          theme: '자동차' },
  { code: '000270', name: '기아',            theme: '자동차' },

  // 배터리/소재
  { code: '373220', name: 'LG에너지솔루션', theme: '배터리' },
  { code: '006400', name: '삼성SDI',         theme: '배터리' },
  { code: '051910', name: 'LG화학',          theme: '소재' },

  // 금융
  { code: '105560', name: 'KB금융',          theme: '금융' },
  { code: '055550', name: '신한지주',        theme: '금융' },
  { code: '086790', name: '하나금융지주',    theme: '금융' },
  { code: '316140', name: '우리금융지주',    theme: '금융' },
  { code: '032830', name: '삼성생명',        theme: '금융' },

  // 통신/플랫폼
  { code: '017670', name: 'SK텔레콤',        theme: '통신' },
  { code: '030200', name: 'KT',              theme: '통신' },
  { code: '035720', name: '카카오',          theme: '플랫폼' },
  { code: '035420', name: 'NAVER',           theme: '플랫폼' },

  // 바이오
  { code: '207940', name: '삼성바이오로직스', theme: '바이오' },
  { code: '068270', name: '셀트리온',        theme: '바이오' },

  // 유통/소비재
  { code: '028260', name: '삼성물산',        theme: '소비재' },
  { code: '051900', name: 'LG생활건강',      theme: '소비재' },

  // 항공/물류
  { code: '003490', name: '대한항공',        theme: '항공' },
];

/**
 * 씨앗 감시목록을 DB에 등록 (없으면 INSERT, 있으면 스킵)
 * 서버 부팅 시 1회 호출
 */
export async function seedWatchlist(): Promise<void> {
  try {
    const pool = getPool();

    // 배치 INSERT — 47개 순차 쿼리 → 1개 쿼리로 최적화
    const values = SEED_STOCKS.map((_, i) =>
      `($${i * 2 + 1}, $${i * 2 + 2}, 'KOSPI', true, 'SEED')`,
    ).join(', ');
    const params = SEED_STOCKS.flatMap(s => [s.code, s.name]);

    const { rowCount } = await pool.query(
      `INSERT INTO watchlist (stock_code, stock_name, market, is_active, source)
       VALUES ${values}
       ON CONFLICT (stock_code) DO NOTHING`,
      params,
    );

    const added = rowCount ?? 0;
    if (added > 0) {
      logger.info(
        `🌱 씨앗 감시목록 등록: ${added}개 신규 / ${SEED_STOCKS.length - added}개 기존`,
        { component: 'SEED_WATCHLIST' },
      );
    }
  } catch (err) {
    logger.warn(`씨앗 감시목록 등록 실패 (무시): ${err}`, { component: 'SEED_WATCHLIST' });
  }
}
