import { KIS_TR_ID, STRATEGY_PARAMS } from '../config/constants.js';
import { getActiveStrategy, getPool, logSystem } from '../db/client.js';
import { kisRequest } from '../kis/client.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { logger } from '../utils/logger.js';

/**
 * 장세 자동 감지 & 전략 모드 자동 전환
 *
 * 매일 장 시작 전(08:00) + 점심(12:00) 실행
 * KOSPI 지수 + 변동성 + 외국인 수급을 분석하여
 * SWING ↔ DEFENSE 모드를 자동 전환
 *
 * CEO는 프롬프트만 신경쓰면 됨 → 모드 전환은 시스템이 자동 판단
 */

export interface MarketRegime {
  regime: 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'PANIC';
  kospiChange: number;
  kospi200Change: number;
  foreignNetBuy: number; // 외국인 순매수 (억원)
  vix: number; // 변동성 지표
  recommendedMode: 'SWING' | 'DEFENSE' | 'DIVIDEND';
  reasons: string[];
}

/**
 * KOSPI 지수 데이터 수집 + 장세 판단
 */
export async function detectMarketRegime(): Promise<MarketRegime> {
  const reasons: string[] = [];
  let bearishScore = 0;

  // 1. KOSPI 지수 변동률 (전일 대비)
  let kospiChange = 0;
  try {
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-price',
      trId: KIS_TR_ID.QUOTE.CURRENT_PRICE,
      params: { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001' }, // KOSPI 지수
    });
    const o = res.output as Record<string, string>;
    kospiChange = Number(o?.prdy_ctrt ?? 0);
  } catch {
    logger.warn('KOSPI 지수 조회 실패', { component: 'REGIME' });
  }

  // 2. KOSPI200 변동률
  let kospi200Change = 0;
  try {
    const res = await kisRequest({
      path: '/uapi/domestic-stock/v1/quotations/inquire-price',
      trId: KIS_TR_ID.QUOTE.CURRENT_PRICE,
      params: { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0101' }, // KOSPI200
    });
    const o = res.output as Record<string, string>;
    kospi200Change = Number(o?.prdy_ctrt ?? 0);
  } catch {
    logger.warn('KOSPI200 조회 실패', { component: 'REGIME' });
  }

  // 3. 하락 판단 기준
  if (kospiChange < -1.5) {
    bearishScore += 3;
    reasons.push(`KOSPI ${kospiChange.toFixed(1)}% 급락`);
  } else if (kospiChange < -0.5) {
    bearishScore += 1;
    reasons.push(`KOSPI ${kospiChange.toFixed(1)}% 하락`);
  }

  if (kospi200Change < -1.5) {
    bearishScore += 2;
    reasons.push(`KOSPI200 ${kospi200Change.toFixed(1)}% 급락`);
  }

  // 4. 장세 판단
  let regime: MarketRegime['regime'];
  let recommendedMode: 'SWING' | 'DEFENSE' | 'DIVIDEND';

  if (bearishScore >= 5) {
    regime = 'PANIC';
    recommendedMode = 'DEFENSE';
    reasons.push('공포 수준 하락 → DEFENSE 모드 권장');
  } else if (bearishScore >= 3) {
    regime = 'BEARISH';
    recommendedMode = 'DEFENSE';
    reasons.push('하락장 감지 → DEFENSE 모드 권장');
  } else if (kospiChange > 1.0) {
    regime = 'BULLISH';
    recommendedMode = 'SWING';
    reasons.push('상승장 → SWING 모드 유지');
  } else {
    regime = 'NEUTRAL';
    recommendedMode = 'SWING';
    reasons.push('보합장 → SWING 모드 유지');
  }

  return {
    regime,
    kospiChange,
    kospi200Change,
    foreignNetBuy: 0, // 외국인 수급은 장중에만 확인 가능
    vix: 0,
    recommendedMode,
    reasons,
  };
}

/**
 * 장세 감지 → 전략 자동 전환 (필요 시)
 */
export async function autoSwitchStrategy(): Promise<void> {
  try {
    const regime = await detectMarketRegime();
    const currentStrategy = await getActiveStrategy();
    const currentMode = currentStrategy?.mode ?? 'SWING';

    // DEFENSE → DIVIDEND 에스컬레이션: DEFENSE 중 장세 여전히 BEARISH/PANIC → 배당 파킹 모드로 전환
    // DIVIDEND → SWING 회복: 장세 NEUTRAL/BULLISH로 회복 시 스윙 복귀
    let targetMode = regime.recommendedMode;
    if (currentMode === 'DEFENSE' && (regime.regime === 'BEARISH' || regime.regime === 'PANIC')) {
      targetMode = 'DIVIDEND';
      regime.reasons.push('DEFENSE 지속 → DIVIDEND 파킹 모드 에스컬레이션 (배당+안정 운영)');
    } else if (currentMode === 'DIVIDEND' && (regime.regime === 'NEUTRAL' || regime.regime === 'BULLISH')) {
      targetMode = 'SWING';
      regime.reasons.push('장세 회복 → DIVIDEND → SWING 복귀');
    }

    logger.info(
      `장세 감지: ${regime.regime} (KOSPI ${regime.kospiChange > 0 ? '+' : ''}${regime.kospiChange.toFixed(1)}%) → 권장: ${targetMode}`,
      { component: 'REGIME' },
    );

    // 모드 전환 필요한 경우
    if (currentMode !== targetMode) {
      const effectiveMode = targetMode;
      logger.warn(`전략 자동 전환: ${currentMode} → ${effectiveMode}`, { component: 'REGIME' });

      const modeParams = STRATEGY_PARAMS[effectiveMode as keyof typeof STRATEGY_PARAMS];
      const newBuyThreshold = modeParams?.buyThreshold ?? 65;
      const newStopLoss = modeParams?.stopLossPct ?? -5.0;

      // 전략 모드만 UPDATE — notebooklm_prompt·프롬프트 등 유저 설정은 절대 덮어쓰지 않음
      const { rowCount: updCount } = await getPool().query(
        `UPDATE strategy_config
         SET mode = $1, buy_threshold = $2, stop_loss_pct = $3, updated_at = NOW()
         WHERE is_active = true`,
        [effectiveMode, newBuyThreshold, newStopLoss],
      );

      // 활성 전략이 없으면 기존 방식으로 INSERT (초기 상태)
      if ((updCount ?? 0) === 0) {
        await getPool().query(
          `INSERT INTO strategy_config
             (mode, is_active, gemini_prompt, gpt_prompt, claude_prompt,
              buy_threshold, stop_loss_pct, take_profit_pct,
              notebooklm_prompt, strategy_document, risk_prompt)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            effectiveMode, true,
            currentStrategy?.gemini_prompt ?? '',
            currentStrategy?.gpt_prompt ?? '',
            currentStrategy?.claude_prompt ?? '',
            newBuyThreshold,
            newStopLoss,
            currentStrategy?.take_profit_pct ?? 8.0,
            currentStrategy?.notebooklm_prompt ?? '',
            currentStrategy?.strategy_document ?? '',
            currentStrategy?.risk_prompt ?? '',
          ],
        );
      }

      await logSystem(
        'WARN',
        'REGIME',
        `전략 자동 전환: ${currentMode} → ${effectiveMode} (${regime.reasons.join(', ')})`,
      );

      await sendTelegramMessage(
        `🔄 *전략 자동 전환*\n` +
          `${currentMode} → *${effectiveMode}*\n\n` +
          `장세: ${regime.regime}\n` +
          `KOSPI: ${regime.kospiChange > 0 ? '+' : ''}${regime.kospiChange.toFixed(1)}%\n` +
          `사유: ${regime.reasons.join('\n')}\n\n` +
          `수동 변경: 대시보드 > 설정`,
      );

      // CEO 워크플로우: 모드 전환 시 자금 재배치 트리거
      const { onModeSwitch } = await import('./ceo-workflow.js');
      await onModeSwitch(currentMode, effectiveMode);
    }
  } catch (error) {
    logger.error(`장세 감지 실패: ${error}`, { component: 'REGIME' });
  }
}
