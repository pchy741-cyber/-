import { MetricServiceClient } from '@google-cloud/monitoring';
import { logger } from '../utils/logger.js';

/**
 * GCP Cloud Monitoring 커스텀 메트릭
 *
 * custom.googleapis.com/quantops/ 네임스페이스에 다음 메트릭을 기록:
 *   - trade_count      : 매매 발생 시 카운트
 *   - error_count      : 에러 발생 카운트
 *   - portfolio_value   : 포트폴리오 총 평가액
 *   - daily_pnl        : 일일 손익
 *   - ai_score_avg     : AI 종합 점수 평균
 *   - system_health    : 컴포넌트별 상태 (1=정상, 0=비정상)
 *
 * 모니터링 실패 시 경고 로그만 남기고 크래시하지 않음.
 */

const PROJECT_ID = 'quantops-trading';
const METRIC_PREFIX = 'custom.googleapis.com/quantops';

let client: MetricServiceClient | null = null;

// ── Init ──

export function setupMonitoring(): void {
  try {
    client = new MetricServiceClient();
    logger.info('GCP Cloud Monitoring 초기화 완료', { component: 'monitoring' });
  } catch (err) {
    logger.warn('GCP Cloud Monitoring 초기화 실패 — 메트릭 기록 비활성화', {
      component: 'monitoring',
      error: String(err),
    });
    client = null;
  }
}

// ── Internal helpers ──

interface TimeSeriesPoint {
  metricType: string;
  value: number;
  labels?: Record<string, string>;
}

async function writeTimeSeries(point: TimeSeriesPoint): Promise<void> {
  if (!client) return;

  const now = new Date();
  const seconds = Math.floor(now.getTime() / 1000);

  try {
    await client.createTimeSeries({
      name: `projects/${PROJECT_ID}`,
      timeSeries: [
        {
          metric: {
            type: `${METRIC_PREFIX}/${point.metricType}`,
            labels: point.labels ?? {},
          },
          resource: {
            type: 'global',
            labels: { project_id: PROJECT_ID },
          },
          points: [
            {
              interval: { endTime: { seconds } },
              value: { doubleValue: point.value },
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.warn(`메트릭 기록 실패: ${point.metricType}`, {
      component: 'monitoring',
      error: String(err),
    });
  }
}

// ── Public API ──

/**
 * 매매 발생 시 메트릭 기록
 */
export async function recordTradeMetric(
  side: 'buy' | 'sell',
  stockCode: string,
  amount: number,
): Promise<void> {
  await writeTimeSeries({
    metricType: 'trade_count',
    value: 1,
    labels: { side, stock_code: stockCode },
  });

  logger.info(`매매 메트릭 기록: ${side} ${stockCode} ${amount.toLocaleString()}원`, {
    component: 'monitoring',
  });
}

/**
 * 포트폴리오 가치 & 일일 손익 기록
 */
export async function recordPortfolioMetric(
  totalValue: number,
  pnl: number,
): Promise<void> {
  await Promise.all([
    writeTimeSeries({ metricType: 'portfolio_value', value: totalValue }),
    writeTimeSeries({ metricType: 'daily_pnl', value: pnl }),
  ]);

  logger.info(
    `포트폴리오 메트릭 기록: 총액 ${totalValue.toLocaleString()}원, PnL ${pnl.toLocaleString()}원`,
    { component: 'monitoring' },
  );
}

/**
 * 에러 카운트 기록
 */
export async function recordErrorMetric(
  component: string,
  errorType: string,
): Promise<void> {
  await writeTimeSeries({
    metricType: 'error_count',
    value: 1,
    labels: { component, error_type: errorType },
  });
}

/**
 * AI 종합 점수 평균 기록
 */
export async function recordAiScoreMetric(avgScore: number): Promise<void> {
  await writeTimeSeries({
    metricType: 'ai_score_avg',
    value: avgScore,
  });
}

/**
 * 시스템 컴포넌트 상태 기록 (1 = 정상, 0 = 비정상)
 */
export async function recordSystemMetric(
  component: string,
  status: 'healthy' | 'unhealthy',
): Promise<void> {
  await writeTimeSeries({
    metricType: 'system_health',
    value: status === 'healthy' ? 1 : 0,
    labels: { component },
  });
}
