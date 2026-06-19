import { Hono } from 'hono';
import { allocationRoutes } from './allocation.js';
import { insightsRoutes } from './insights.js';
import { killSwitchRoutes } from './kill-switch.js';
import { manualTriggersRoutes } from './manual-triggers.js';
import { pushNotificationsRoutes } from './push-notifications.js';
import { riskControlsRoutes } from './risk-controls.js';
import { strategyRoutes } from './strategy.js';
import { tradingModeRoutes } from './trading-mode.js';

export const settingsRoutes = new Hono();

settingsRoutes.route('/', killSwitchRoutes);
settingsRoutes.route('/', strategyRoutes);
settingsRoutes.route('/', riskControlsRoutes);
settingsRoutes.route('/', tradingModeRoutes);
settingsRoutes.route('/', allocationRoutes);
settingsRoutes.route('/', insightsRoutes);
settingsRoutes.route('/', manualTriggersRoutes);
settingsRoutes.route('/', pushNotificationsRoutes);

// 역호환: isKospiOverrideActive re-export
export { isKospiOverrideActive } from '../../../risk/kospi-override.js';
