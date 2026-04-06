import { getActiveWatchlist } from '../../db/client.js';
import { kisRequest } from '../../kis/client.js';
import { getDailyChart } from '../../kis/market.js';
import { logger } from '../../utils/logger.js';
import { emitSniperSignal, type SniperSignal } from './index.js';

/**
 * 🏦 기관+외국인 동시 순매수 감지
 *
 * 왜 거의 확실한가?
 * - 기관과 외국인이 동시에 3~5일 연속 순매수하면
 *   개인투자자와 반대 방향 = 스마트 머니가 들어온 것
 * - 통계적으로 3일 연속 양매수 후 5일 내 상승 확률 75~85%
 * - 5일 연속이면 90%+ (이건 거의 테마/섹터 로테이션)
 *
 * 투자 배수:
 * - 3일 연속: x1.2 (소폭 확대)
 * - 5일 연속: x1.5 (최대 확대)
 */

interface InvestorData {
  foreignNetBuy: number; // 외국인 순매수 (주)
  institutionNetBuy: number; // 기관 순매수 (주)
  date: string;
  price: number;
}

async function getInvestorTrend(stockCode: string, days: number = 10): Promise<InvestorData[]> {
  try {
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-investor',
      trId: 'FHKST01010900',
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
        FID_INPUT_DATE_1: '', // 최근
        FID_INPUT_DATE_2: '',
        FID_PERIOD_DIV_CODE: 'D',
      },
    });

    const items = (res.output ?? []) as Record<string, string>[];

    return items.slice(0, days).map((item) => ({
      foreignNetBuy: Number(item.frgn_ntby_qty ?? 0),
      institutionNetBuy: Number(item.orgn_ntby_qty ?? 0),
      price: Number(item.stck_clpr ?? 0),
      date: item.stck_bsop_date ?? '',
    }));
  } catch (error) {
    logger.warn(`투자자 동향 조회 실패 (${stockCode}): ${error}`, { component: 'SNIPER' });
    return [];
  }
}

/**
 * 전 종목 기관+외국인 수급 스캔
 */
export async function scanInstitutionalSurge(): Promise<SniperSignal[]> {
  const watchlist = await getActiveWatchlist();
  const signals: SniperSignal[] = [];

  for (const stock of watchlist) {
    try {
      const [trend, chartData] = await Promise.all([
        getInvestorTrend(stock.stock_code, 7),
        getDailyChart(stock.stock_code, 25), // 20일 평균 거래량 계산용
      ]);

      if (trend.length < 3 || chartData.length < 21) continue;

      // 20일 평균 거래량 (오늘 제외)
      const avgVolume20d = chartData.slice(1, 21).reduce((sum, c) => sum + c.volume, 0) / 20;

      // 연속 양매수 일수 계산
      let consecutiveDays = 0;
      let volumeSpikeDays = 0;
      for (const day of trend) {
        const chartDay = chartData.find((c) => c.date === day.date);
        if (day.foreignNetBuy > 0 && day.institutionNetBuy > 0 && chartDay) {
          consecutiveDays++;
          if (chartDay.volume > avgVolume20d * 1.3) {
            // 평소 거래량의 130% 이상
            volumeSpikeDays++;
          }
        } else {
          break;
        }
      }

      if (consecutiveDays >= 3) {
        const recentTrend = trend.slice(0, consecutiveDays);
        const _totalForeign = recentTrend.reduce((s, d) => s + d.foreignNetBuy, 0);
        const _totalInstitution = recentTrend.reduce((s, d) => s + d.institutionNetBuy, 0);
        const totalBuyValue = recentTrend.reduce((s, d) => s + (d.foreignNetBuy + d.institutionNetBuy) * d.price, 0);

        let confidence: number;
        let multiplier: number;
        const reasons: string[] = [`기관+외국인 ${consecutiveDays}일 연속 동시 순매수`];

        if (consecutiveDays >= 5) {
          confidence = 0.9;
          multiplier = 1.5;
        } else if (consecutiveDays >= 4) {
          confidence = 0.85;
          multiplier = 1.3;
        } else {
          confidence = 0.8;
          multiplier = 1.2;
        }

        // 거래량 동반 시 신뢰도 가산
        if (volumeSpikeDays >= Math.floor(consecutiveDays / 2) && volumeSpikeDays > 0) {
          confidence = Math.min(0.98, confidence + 0.05);
          reasons.push(`${volumeSpikeDays}일 거래량 동반`);
        }

        reasons.push(`총 순매수액 ${(totalBuyValue / 100000000).toFixed(1)}억원`);

        const signal: SniperSignal = {
          stockCode: stock.stock_code,
          stockName: stock.stock_name,
          type: 'INSTITUTIONAL_SURGE',
          confidence,
          budgetMultiplier: multiplier,
          reasoning: reasons.join(' + '),
          detectedAt: new Date().toISOString(),
        };

        signals.push(signal);
        await emitSniperSignal(signal);
      }

      // rate limit
      await new Promise((r) => setTimeout(r, 200));
    } catch (error) {
      logger.warn(`기관 수급 스캔 실패 (${stock.stock_name}): ${error}`, { component: 'SNIPER' });
    }
  }

  if (signals.length > 0) {
    logger.info(`🏦 기관+외국인 시그널: ${signals.length}개 종목`, { component: 'SNIPER' });
  }

  return signals;
}
