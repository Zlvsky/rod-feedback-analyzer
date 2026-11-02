import { cli } from './runtime.js';
import { syncTrello } from '../trello/sync.js';
await cli('sync-trello', 'all', async ({ config, store, trello, now }) => {
  const report = await syncTrello(config, store, trello, now);
  if (report.outcomes.some(o => o.status === 'failed')) process.exitCode = 1;
  else if (report.outcomes.some(o => o.status === 'review')) process.exitCode = 2;
  return report;
});
