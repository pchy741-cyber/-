/**
 * Resilient JSON parser for Gemini AI responses.
 *
 * Gemini frequently returns malformed JSON:
 *  - Wrapped in markdown code blocks (```json ... ```)
 *  - Trailing commas before ] or }
 *  - Truncated responses (array/object cut off mid-way)
 *  - Extra explanatory text before/after the JSON
 *  - Nested code blocks or mixed text
 *
 * This module tries multiple strategies to extract valid JSON
 * and NEVER throws — it always returns the best result possible.
 */

import { logger } from './logger.js';

/**
 * Attempt to parse a Gemini response as JSON.
 * Tries multiple repair strategies in order of preference.
 * Returns `null` only if absolutely nothing can be extracted.
 */
export function safeParseJson<T = unknown>(raw: string, context?: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  const tag = context ?? 'safeParseJson';

  // Strategy 1: Direct parse (best case — Gemini returned clean JSON)
  const direct = tryParse<T>(raw.trim());
  if (direct !== null) return direct;

  // Strategy 2: Extract from markdown code blocks
  const fromBlock = extractFromCodeBlock(raw);
  if (fromBlock) {
    const parsed = tryParse<T>(fromBlock);
    if (parsed !== null) return parsed;
    // Code block content was found but didn't parse — try repairing it
    const repaired = repairAndParse<T>(fromBlock, tag);
    if (repaired !== null) return repaired;
  }

  // Strategy 3: Find the outermost JSON object { ... }
  const objMatch = findOutermostJson(raw, '{', '}');
  if (objMatch) {
    const parsed = tryParse<T>(objMatch);
    if (parsed !== null) return parsed;
    const repaired = repairAndParse<T>(objMatch, tag);
    if (repaired !== null) return repaired;
  }

  // Strategy 4: Find the outermost JSON array [ ... ]
  const arrMatch = findOutermostJson(raw, '[', ']');
  if (arrMatch) {
    const parsed = tryParse<T>(arrMatch);
    if (parsed !== null) return parsed;
    const repaired = repairAndParse<T>(arrMatch, tag);
    if (repaired !== null) return repaired;
  }

  // Strategy 5: Aggressive repair of the whole text
  const aggressive = repairAndParse<T>(raw.trim(), tag);
  if (aggressive !== null) return aggressive;

  logger.warn(`[${tag}] 모든 JSON 파싱 전략 실패`, {
    component: 'JSON_REPAIR',
    rawLength: raw.length,
    rawPreview: raw.slice(0, 500),
  });
  return null;
}

/**
 * Extract JSON array of scores from a potentially broken response.
 * Specifically designed for the scoring use case where we need { scores: [...] }.
 * If the top-level parse fails, tries to salvage individual array elements.
 */
export function safeParseScoresJson(raw: string, context?: string): { scores: unknown[] } | null {
  const tag = context ?? 'safeParseScoresJson';

  // First try the normal parse path
  const fullParse = safeParseJson<{ scores?: unknown[] }>(raw, tag);
  if (fullParse && Array.isArray(fullParse.scores)) {
    return { scores: fullParse.scores };
  }

  // If we got a top-level array instead of { scores: [...] }, wrap it
  if (Array.isArray(fullParse)) {
    return { scores: fullParse as unknown[] };
  }

  // Last resort: try to find individual score objects from the raw text
  // This handles truncated arrays where the array was cut off mid-way
  const individualScores = extractIndividualObjects(raw, tag);
  if (individualScores.length > 0) {
    logger.info(`[${tag}] 개별 객체 추출로 ${individualScores.length}개 스코어 복구`, { component: 'JSON_REPAIR' });
    return { scores: individualScores };
  }

  return null;
}

// ─── Internal helpers ───────────────────────────────────────────────

function tryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Extract content from markdown code blocks.
 * Handles: ```json ... ```, ``` ... ```, and nested/multiple blocks.
 */
function extractFromCodeBlock(raw: string): string | null {
  // Try ```json ... ``` first (greedy — get the largest block)
  const jsonBlock = raw.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock?.[1]?.trim()) return jsonBlock[1].trim();

  // Try generic ``` ... ```
  const genericBlock = raw.match(/```\s*([\s\S]*?)```/);
  if (genericBlock?.[1]?.trim()) return genericBlock[1].trim();

  return null;
}

/**
 * Find the outermost balanced JSON structure in text.
 * Uses bracket counting to handle nested structures.
 */
function findOutermostJson(raw: string, open: '{' | '[', close: '}' | ']'): string | null {
  const startIdx = raw.indexOf(open);
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;
  let lastValidEnd = -1;

  for (let i = startIdx; i < raw.length; i++) {
    const ch = raw[i];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        // Found a complete balanced structure
        return raw.slice(startIdx, i + 1);
      }
      // Track the last position where we closed something
      // (useful for truncated responses)
      lastValidEnd = i;
    }
  }

  // Truncated — depth never reached 0
  // Try to close it manually
  if (depth > 0 && lastValidEnd > startIdx) {
    // Take up to the last valid closing bracket and try to close remaining
    let truncated = raw.slice(startIdx, lastValidEnd + 1);
    // Close any remaining open brackets
    truncated = closeOpenBrackets(truncated, open, close);
    return truncated;
  }

  // No valid closing found at all — take everything from open to end and try to close
  if (depth > 0) {
    let truncated = raw.slice(startIdx).trim();
    truncated = closeOpenBrackets(truncated, open, close);
    return truncated;
  }

  return null;
}

/**
 * Close any unclosed brackets at the end of a JSON string.
 * Handles truncation mid-value, mid-key, trailing commas, etc.
 */
function closeOpenBrackets(text: string, _open: string, _close: string): string {
  // Remove any trailing incomplete elements:
  // - Trailing comma + whitespace
  // - Incomplete string (odd number of unescaped quotes)
  // - Incomplete key-value pair

  let cleaned = text;

  // Remove trailing partial content after the last complete element
  // Find the last complete value ending (}, ], number, "string", true, false, null)
  cleaned = cleaned.replace(/,\s*"[^"]*$/, ''); // trailing incomplete "key or "value
  cleaned = cleaned.replace(/,\s*-?\d+\.?\d*[eE]?[+-]?\d*$/, (m) => {
    // Check if this looks like a complete number
    if (/^,\s*-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(m)) return m; // complete number, keep it
    return ''; // incomplete number, remove
  });
  cleaned = cleaned.replace(/,\s*$/, ''); // trailing comma
  cleaned = cleaned.replace(/:\s*$/, ': null'); // incomplete value after colon
  cleaned = cleaned.replace(/,\s*"[^"]*"\s*:\s*$/, ''); // incomplete key:value

  // Count unclosed brackets
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  // If we're inside an unclosed string, close it
  if (inStr) {
    cleaned += '"';
  }

  // Close remaining open brackets in reverse order
  cleaned += stack.reverse().join('');

  return cleaned;
}

/**
 * Apply common JSON repairs and try to parse.
 */
function repairAndParse<T>(text: string, tag: string): T | null {
  let repaired = text;

  // 1. Remove trailing commas before } or ]
  repaired = repaired.replace(/,\s*([\]}])/g, '$1');

  // 2. Remove JavaScript-style comments
  repaired = repaired.replace(/\/\/[^\n]*/g, '');
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');

  // 3. Replace single quotes with double quotes for keys/values
  // (only if no double quotes are present — risky otherwise)
  if (!repaired.includes('"') && repaired.includes("'")) {
    repaired = repaired.replace(/'/g, '"');
  }

  // 4. Fix unquoted keys: { key: "value" } → { "key": "value" }
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

  // 5. Try to close truncated structures
  repaired = closeOpenBrackets(repaired, '{', '}');

  const result = tryParse<T>(repaired);
  if (result !== null) {
    logger.info(`[${tag}] JSON 복구 성공 (repair strategies applied)`, { component: 'JSON_REPAIR' });
    return result;
  }

  // 6. More aggressive: strip everything before the first { or [
  const firstBrace = repaired.search(/[[{]/);
  if (firstBrace > 0) {
    const stripped = repaired.slice(firstBrace);
    const result2 = tryParse<T>(stripped);
    if (result2 !== null) {
      logger.info(`[${tag}] JSON 복구 성공 (prefix stripped)`, { component: 'JSON_REPAIR' });
      return result2;
    }
  }

  return null;
}

/**
 * Extract individual JSON objects from text.
 * Used as last resort for truncated arrays: finds each {...} block
 * and parses them individually.
 */
function extractIndividualObjects(raw: string, tag: string): unknown[] {
  const results: unknown[] = [];

  // First, try to get the text inside a "scores" array or any top-level array
  let searchText = raw;
  const scoresMatch = raw.match(/"scores"\s*:\s*\[/);
  if (scoresMatch && scoresMatch.index !== undefined) {
    searchText = raw.slice(scoresMatch.index + scoresMatch[0].length);
  } else {
    const arrayMatch = raw.match(/\[\s*\{/);
    if (arrayMatch && arrayMatch.index !== undefined) {
      searchText = raw.slice(arrayMatch.index + 1);
    }
  }

  // Find each { ... } block at the top level of the array
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < searchText.length; i++) {
    const ch = searchText[i];

    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objText = searchText.slice(objStart, i + 1);
        const parsed = tryParse(objText);
        if (parsed !== null && typeof parsed === 'object') {
          results.push(parsed);
        } else {
          // Try repairing this individual object
          const repaired = repairAndParse(objText, tag);
          if (repaired !== null && typeof repaired === 'object') {
            results.push(repaired);
          }
        }
        objStart = -1;
      }
    }
  }

  // Handle the last object if it was truncated (depth > 0)
  if (depth > 0 && objStart !== -1) {
    let lastObj = searchText.slice(objStart);
    lastObj = closeOpenBrackets(lastObj, '{', '}');
    // Remove trailing commas
    lastObj = lastObj.replace(/,\s*([\]}])/g, '$1');
    const parsed = tryParse(lastObj);
    if (parsed !== null && typeof parsed === 'object') {
      results.push(parsed);
      logger.info(`[${tag}] 잘린 마지막 객체 복구 성공`, { component: 'JSON_REPAIR' });
    }
  }

  return results;
}
