import { cli } from './runtime.js';
import { collect } from '../discord/collector.js';
import { retrieveContext } from '../trello/context.js';
import { prepareAnalysis } from '../services/analysis.js';
await cli('demo-prepare', null, async ({ config, store, discord, trello, now }) => {
  if (!config.mock) throw new Error('Use npm run demo:prepare -- --mock');
  await collect(config, store, discord, now); await retrieveContext(config, store, trello, now);
  return prepareAnalysis(store);
});
