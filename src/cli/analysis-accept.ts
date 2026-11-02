import { cli } from './runtime.js';
import { acceptAnalysis } from '../services/analysis.js';
await cli('analysis-accept', null, async ({ store, now }) => acceptAnalysis(store, now));
