/**
 * Review 라우트 합성 — capture + diagnostics + copilot
 */
import { Hono } from 'hono';
import captureRoutes from './capture.js';
import diagnosticsRoutes from './diagnostics.js';
import copilotRoutes from './copilot.js';
import xrayRoutes from './xray.js';

const app = new Hono();
app.route('/', captureRoutes);
app.route('/', diagnosticsRoutes);
app.route('/', copilotRoutes);
app.route('/', xrayRoutes);

export default app;
