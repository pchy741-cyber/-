/** Rate-limit 및 대기 헬퍼 — awaitable delay */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
