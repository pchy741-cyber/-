import { Hono } from 'hono';
import { aiEngineRoutes } from './ai-engine.js';
import { manualTriggersRoutes } from './manual-triggers.js';
import { marketDataRoutes } from './market-data.js';
import { portfolioAnalysisRoutes } from './portfolio-analysis.js';
import { profitStatsRoutes } from './profit-stats.js';
import { stockAnalysisRoutes } from './stock-analysis.js';
import { systemLogRoutes } from './system-log.js';
import { tradingStatusRoutes } from './trading-status.js';
import { transparencyRoutes } from './transparency.js';

export const dashboardAnalysisRoutes = new Hono();

dashboardAnalysisRoutes.route('/', stockAnalysisRoutes);
dashboardAnalysisRoutes.route('/', tradingStatusRoutes);
dashboardAnalysisRoutes.route('/', aiEngineRoutes);
dashboardAnalysisRoutes.route('/', systemLogRoutes);
dashboardAnalysisRoutes.route('/', transparencyRoutes);
dashboardAnalysisRoutes.route('/', manualTriggersRoutes);
dashboardAnalysisRoutes.route('/', profitStatsRoutes);
dashboardAnalysisRoutes.route('/', portfolioAnalysisRoutes);
dashboardAnalysisRoutes.route('/', marketDataRoutes);
