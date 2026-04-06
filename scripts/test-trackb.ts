import { getAccessToken } from '../src/kis/auth.js';
import { runTrackBPipeline } from '../src/ai/track-b/pipeline.js';

async function main() {
  console.log('[1] KIS 토큰 발급...');
  await getAccessToken();
  console.log('[1] OK');

  console.log('[2] Track B 파이프라인 실행...');
  const decisions = await runTrackBPipeline();
  console.log(`[2] 결과: ${decisions.length}건`);

  for (const d of decisions) {
    console.log(`  ${d.action} ${d.stock_code} x${d.quantity} | ${d.reasoning}`);
  }

  if (decisions.length === 0) {
    console.log('  → 매매 판단 없음 (HOLD 또는 시그널 부족)');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
