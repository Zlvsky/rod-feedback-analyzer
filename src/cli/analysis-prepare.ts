import { cli } from './runtime.js';
import { prepareAnalysis } from '../services/analysis.js';
await cli('analysis-prepare', null, async ({ store }) => prepareAnalysis(store));
