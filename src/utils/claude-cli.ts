/**
 * Claude CLI (`claude -p`) 어댑터
 * Max 구독 토큰을 활용하여 ANTHROPIC_API_KEY 없이 Claude 호출
 * 로컬 paper 모드 전용 — Cloud Run에서는 기존 API 키 사용
 *
 * 환경변수: USE_CLAUDE_CLI=true 로 활성화
 */
import { spawn } from 'child_process';
import { logger } from './logger.js';

const CLI_TIMEOUT_MS = 90_000; // 90초
const COMP = 'CLAUDE_CLI';

/** Claude CLI 사용 여부 */
export function isClaudeCliEnabled(): boolean {
  return process.env.USE_CLAUDE_CLI === 'true';
}

/**
 * claude -p (비대화형 모드)로 Claude 호출
 * Max 구독 사용량에서 차감됨
 */
export async function callClaudeCli(opts: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const { systemPrompt, userPrompt } = opts;

  return new Promise((resolve, reject) => {
    const args = [
      '-p',                        // 비대화형 모드
      '--output-format', 'text',   // 순수 텍스트 출력
      '--model', 'haiku',          // Haiku = 빠르고 할당량 적게 소모
      '--max-turns', '1',          // 단일 응답
    ];

    // CLAUDECODE 환경변수 제거 — 중첩 세션 방지 우회 (봇은 별도 프로세스)
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    cleanEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL = '1';

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: cleanEnv,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // 시스템 프롬프트 + 유저 프롬프트를 하나로 합쳐서 stdin에 전달
    const combined = `[시스템 지시]\n${systemPrompt}\n\n[분석 요청]\n${userPrompt}`;
    proc.stdin.write(combined);
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude CLI 타임아웃 (${CLI_TIMEOUT_MS / 1000}초)`));
    }, CLI_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        logger.debug(`Claude CLI 응답 수신 (${stdout.length}자)`, { component: COMP });
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude CLI 종료코드=${code}: ${stderr.slice(0, 300)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI 실행 실패 (claude 설치 확인): ${err.message}`));
    });
  });
}
