/**
 * 프롬프트/카드 인젝션 가드 (라우트·T8·승인 공용).
 *
 * ⚠️ 심층방어 목적일 뿐 완전한 방어가 아니다 — 라이브 트레이딩 AI는 한국어로 구동되므로
 *    정규식으로 모든 조작을 막을 수 없다. 진짜 통제는 (1) 사람이 전문 검토 승인,
 *    (2) 스코어러 출력 범위 클램프에 있다. 여기선 명백한 부트스트랩 인젝션만 걸러낸다.
 */
export const MAX_PROMPT_TEXT = 8000;
export const MAX_CARD_BODY = 1500;

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|above|all)/i,
  /system\s*prompt/i,
  /you\s+are\s+(now|a)\b/i,
  /<\/?script/i,
  /\{\{.*\}\}/,
  // 한국어 최소 방어 (부분적)
  /이전\s*(의\s*)?지시.{0,8}무시/,
  /지시.{0,6}무시하고/,
  /시스템\s*프롬프트/,
];

export function hasPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

export interface CardInput {
  title: string;
  body: string;
  expires_at: string;
}

/**
 * Fable 참고소스 카드 검증 — 통과분만 반환 (route POST /market-sources/replace 와 동일 기준).
 * title은 [카테고리] 접두사, body ≤ 1500자, expires_at YYYY-MM-DD, 인젝션 없음.
 */
export function validateCards(cards: CardInput[]): { valid: CardInput[]; rejected: number } {
  const valid: CardInput[] = [];
  let rejected = 0;
  for (const c of cards) {
    const ok =
      typeof c.title === 'string' &&
      c.title.startsWith('[') &&
      typeof c.body === 'string' &&
      c.body.length > 0 &&
      c.body.length <= MAX_CARD_BODY &&
      /^\d{4}-\d{2}-\d{2}$/.test(c.expires_at) &&
      !hasPromptInjection(c.title) &&
      !hasPromptInjection(c.body);
    if (ok) valid.push(c);
    else rejected++;
  }
  return { valid, rejected };
}
