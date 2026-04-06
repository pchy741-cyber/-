import { getAccessToken } from '../src/kis/auth.js';
import { runOverseasJob } from '../src/scheduler/overseas-job.js';

async function main() {
  console.log('=== 미국주식 자동매매 테스트 ===\n');
  await getAccessToken();
  await runOverseasJob();
  console.log('\n=== 완료 ===');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
