import { getConsensusScoreAdjustment } from '../../automation/analyst-consensus.js';
import { getCachedDisclosures } from '../../automation/dart-monitor.js';
import { getFlowScoreAdjustment, getInvestorFlow } from '../../automation/investor-flow.js';
import { getMacroScoreAdjustment, getMacroSnapshot } from '../../automation/macro-data.js';
import { collectMacroNews, getTodayNews } from '../../automation/news-collector.js';
import { getSentimentScoreAdjustment } from '../../automation/sentiment-analyzer.js';
import { getShortSellingScoreAdjustment } from '../../automation/short-selling.js';
import { STRATEGY_PARAMS, type StrategyMode } from '../../config/constants.js';
import { config } from '../../config/index.js';
import type { AIScore, TransactionChain } from '../../db/models.js';
import type { AccountBalance } from '../../kis/account.js';
import type { CurrentPrice } from '../../kis/market.js';

/**
 * Track B용 Claude 컨텍스트 구성
 * - 캐싱된 AI 스코어 + 실시간 시세 + 보유 포지션 + 리스크 한도
 * - 최소한의 토큰으로 최대 정보 전달
 */
export async function buildTrackBContext(params: {
  mode: StrategyMode;
  scores: AIScore[];
  livePrices: Map<string, CurrentPrice>;
  openChains: TransactionChain[];
  balance: AccountBalance;
}): Promise<string> {
  const { mode, scores, livePrices, openChains, balance } = params;
  const strategyParams = STRATEGY_PARAMS[mode];

  // 예산 계산
  const reserved = (balance as any).reservedWithdraw ?? 0;
  const availableCash = balance.orderableCash - reserved;
  const budgetPerStock = Math.floor(availableCash / strategyParams.splitCount);

  // 리스크 한도 정보
  const riskInfo = `## 리스크 한도
- 종목당 최대 투자: ${config.risk.maxPositionKrw.toLocaleString()}원
- 하루 최대 손실: ${config.risk.maxDailyDrawdownKrw.toLocaleString()}원
- 총 투자 비율 상한: ${config.risk.maxTotalInvestedPct}%
- 현재 예수금: ${balance.orderableCash.toLocaleString()}원
- 인출 예약금 (재투자 불가): ${reserved.toLocaleString()}원
- 실제 투자가능금: ${availableCash.toLocaleString()}원
- 현재 투자금: ${balance.totalEvalAmount.toLocaleString()}원
- 오늘 손익: ${balance.totalProfitLoss.toLocaleString()}원

## 매수 예산 계산 (반드시 이 금액으로 수량 계산)
- 1회 매수 예산: ${budgetPerStock.toLocaleString()}원 (투자가능금 ${availableCash.toLocaleString()}원 ÷ ${strategyParams.splitCount}분할)
- 수량 계산법: quantity = Math.floor(${budgetPerStock.toLocaleString()} ÷ 현재가)
- 예시: 현재가 50,000원 → ${budgetPerStock.toLocaleString()} ÷ 50,000 = ${Math.floor(budgetPerStock / 50000)}주
- 예시: 현재가 10,000원 → ${budgetPerStock.toLocaleString()} ÷ 10,000 = ${Math.floor(budgetPerStock / 10000)}주
- ⚠️ quantity가 0이면 BUY하지 말고 HOLD하세요`;

  // 전략 파라미터
  const strategyInfo = `## 현재 전략: ${mode}
- 매수 임계 점수: ${strategyParams.buyThreshold}점
- 분할 매수 횟수: ${strategyParams.splitCount}
- 물타기 트리거: ${strategyParams.averageDownPct}%
- 최대 물타기 횟수: ${strategyParams.maxAveragingCount}
- 익절 라인: +${strategyParams.takeProfitPct}% (${strategyParams.takeProfitRatio * 100}% 매도)
- 손절 라인: ${strategyParams.stopLossPct}%`;

  // 매크로 환경 (VKOSPI, 환율, Fear&Greed)
  let macroInfo = '';
  try {
    const macro = await getMacroSnapshot();
    const macroAdj = getMacroScoreAdjustment(macro);
    macroInfo = `\n## 🌍 매크로 환경
- VKOSPI: ${macro.vkospi.toFixed(1)} | USD/KRW: ${macro.usdKrw.toFixed(0)}원 | 기준금리: ${macro.baseRate}%
- Fear & Greed: ${macro.fearGreedIndex}/100 → 시장 체제: ${macro.regime} (전체 스코어 ${macroAdj >= 0 ? '+' : ''}${macroAdj}점 보정)`;
  } catch { /* 매크로 실패 시 무시 */ }

  // 매크로·정치 뉴스 (한국은행/이재명/트럼프 등 시장 전체 영향)
  let macroNewsInfo = '';
  try {
    macroNewsInfo = await Promise.race([
      collectMacroNews(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 8000)),
    ]);
    if (macroNewsInfo) macroNewsInfo = `\n${macroNewsInfo}`;
  } catch { /* 실패 시 무시 */ }

  // 종목별 AI 스코어 + 실시간 시세 + 수급/공시/뉴스감성/목표가/공매도
  const disclosures = getCachedDisclosures();
  const todayNews = getTodayNews();

  // 수급 + 감성분석 데이터를 병렬로 가져오기 (5초 타임아웃)
  const FLOW_TIMEOUT_MS = 5_000;
  const scoredStocks = scores.filter((s) => livePrices.has(s.stock_code));

  const enrichResults = await Promise.allSettled(
    scoredStocks.map(async (score) => {
      // 수급 데이터
      let flowInfo = '';
      try {
        const flow = await Promise.race([
          getInvestorFlow(score.stock_code, 5),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), FLOW_TIMEOUT_MS)),
        ]);
        if (flow) {
          const adj = await getFlowScoreAdjustment(score.stock_code);
          flowInfo = ` | 수급: 외국인${flow.foreignNet >= 0 ? '+' : ''}${flow.foreignNet}주(${flow.foreignStreak}일연속) 기관${flow.institutionNet >= 0 ? '+' : ''}${flow.institutionNet}주 → ${flow.trend}(${adj >= 0 ? '+' : ''}${adj}점)`;
        }
      } catch { /* timeout or error — skip */ }

      // 뉴스 감성분석
      let sentimentInfo = '';
      try {
        const news = todayNews.get(score.stock_code) ?? [];
        if (news.length > 0) {
          const headlines = news.slice(0, 5).map(n => n.title);
          const sentAdj = await Promise.race([
            getSentimentScoreAdjustment(score.stock_code, headlines),
            new Promise<number>((resolve) => setTimeout(() => resolve(0), 3000)),
          ]);
          if (sentAdj !== 0) {
            sentimentInfo = ` | 뉴스감성: ${sentAdj >= 0 ? '+' : ''}${sentAdj}점`;
          }
        }
      } catch { /* sentiment error — skip */ }

      // 증권사 목표가 컨센서스
      let consensusInfo = '';
      try {
        const consAdj = await Promise.race([
          getConsensusScoreAdjustment(score.stock_code),
          new Promise<number>((resolve) => setTimeout(() => resolve(0), 3000)),
        ]);
        if (consAdj !== 0) {
          consensusInfo = ` | 목표가: ${consAdj >= 0 ? '+' : ''}${consAdj}점`;
        }
      } catch { /* consensus error — skip */ }

      // 공매도 데이터
      let shortInfo = '';
      try {
        const shortAdj = await Promise.race([
          getShortSellingScoreAdjustment(score.stock_code),
          new Promise<number>((resolve) => setTimeout(() => resolve(0), 3000)),
        ]);
        if (shortAdj !== 0) {
          shortInfo = ` | 공매도: ${shortAdj >= 0 ? '+' : ''}${shortAdj}점`;
        }
      } catch { /* short selling error — skip */ }

      return { stockCode: score.stock_code, flowInfo, sentimentInfo, consensusInfo, shortInfo };
    }),
  );

  const enrichMap = new Map<string, { flowInfo: string; sentimentInfo: string; consensusInfo: string; shortInfo: string }>();
  for (const result of enrichResults) {
    if (result.status === 'fulfilled') {
      enrichMap.set(result.value.stockCode, result.value);
    }
  }

  // 뉴스 요약 섹션
  const newsLines: string[] = [];
  for (const [stockCode, items] of todayNews.entries()) {
    if (items.length === 0) continue;
    const topNews = items.slice(0, 3).map(n => `  - ${n.title}`).join('\n');
    newsLines.push(`[${stockCode}]\n${topNews}`);
  }
  const newsSummary = newsLines.length > 0
    ? `\n## 📰 오늘 자동 수집된 뉴스\n${newsLines.join('\n')}`
    : '';

  const stockLines: string[] = [];

  for (const score of scores) {
    const price = livePrices.get(score.stock_code);
    if (!price) continue;

    const chain = openChains.find((c) => c.stock_code === score.stock_code);

    const enrich = enrichMap.get(score.stock_code);
    const flowInfo = enrich?.flowInfo ?? '';
    const sentimentInfo = enrich?.sentimentInfo ?? '';
    const consensusInfo = enrich?.consensusInfo ?? '';
    const shortInfo = enrich?.shortInfo ?? '';

    // 공시 데이터
    const stockDisclosures = disclosures.get(score.stock_code) ?? [];
    const highDisclosures = stockDisclosures.filter((d) => d.importance === 'HIGH');
    const disclosureInfo =
      highDisclosures.length > 0 ? ` | 📋 중요공시: ${highDisclosures.map((d) => d.report_nm).join(', ')}` : '';

    let line = `📊 ${score.stock_code} | 스코어: ${score.composite_score}점 (${score.signal}) | 현재가: ${price.currentPrice.toLocaleString()} (${price.changePct > 0 ? '+' : ''}${price.changePct}%)${flowInfo}${sentimentInfo}${consensusInfo}${shortInfo}${disclosureInfo}`;

    if (chain) {
      const pnlPct = chain.avg_buy_price
        ? (((price.currentPrice - Number(chain.avg_buy_price)) / Number(chain.avg_buy_price)) * 100).toFixed(1)
        : 'N/A';
      line += `\n   ⮡ 보유: ${chain.total_quantity}주 @ 평단${Number(chain.avg_buy_price).toLocaleString()} | 수익률: ${pnlPct}% | 물타기: ${chain.current_averaging_count}/${chain.max_averaging_count} | 체인상태: ${chain.status}`;
    }

    stockLines.push(line);
  }
  const stocksInfo = stockLines.join('\n');

  // 보유 중이지만 스코어에 없는 종목 (기존 포지션)
  const orphanChains = openChains
    .filter((c) => !scores.find((s) => s.stock_code === c.stock_code))
    .map((c) => {
      const price = livePrices.get(c.stock_code);
      const pnlPct =
        c.avg_buy_price && price
          ? (((price.currentPrice - Number(c.avg_buy_price)) / Number(c.avg_buy_price)) * 100).toFixed(1)
          : 'N/A';
      return `⚠️ ${c.stock_code} | 스코어 없음 | 보유: ${c.total_quantity}주 @ 평단${Number(c.avg_buy_price).toLocaleString()} | 수익률: ${pnlPct}%`;
    })
    .join('\n');

  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  return `# Track B 실행 컨텍스트 (${now})

${riskInfo}

${strategyInfo}
${macroInfo}
${macroNewsInfo}

## 종목 현황 (수급 + 감성 + 목표가 + 공매도 + 공시 반영)
${stocksInfo}
${orphanChains ? `\n## 스코어 미갱신 보유 종목\n${orphanChains}` : ''}
${newsSummary}

위 데이터(시세/수급/뉴스감성/공시/매크로뉴스)를 종합하여 각 종목에 대한 매매 판단을 내려주세요.
⚠️ 매크로 뉴스에 부정적 발언(금리 인상, 관세 확대, 규제 강화)이 감지되면 매수에 더 신중하게 판단하세요.
특히 외국인/기관 수급 트렌드와 뉴스 감성이 일치하는 방향의 종목을 우선 고려하세요.`;
}
