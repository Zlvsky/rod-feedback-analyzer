import { cli } from './runtime.js';
import { dailySummary } from '../services/summary.js';
await cli('summary', null, async ({ store, now }) => dailySummary(store, now));
