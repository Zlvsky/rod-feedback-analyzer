import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { Storage } from '../services/storage.js';
import { DiscordClient } from '../discord/client.js';
import { collect } from '../discord/collector.js';
import { TrelloClient } from '../trello/client.js';
import { retrieveContext } from '../trello/context.js';
import { syncTrello } from '../trello/sync.js';
import { prepareAnalysis, acceptAnalysis } from '../services/analysis.js';
import { analysisSchema } from '../schemas/tasks.js';
import { dailySummary } from '../services/summary.js';
import { seedMock, mockFetch } from '../mock/server.js';
import { referenceAnalysis } from '../mock/reference-analysis.js';
import { fixtureNow } from '../mock/conversations.js';

try {
  const config = loadConfig({ mock: true, dataDir: join('data', `demo-${randomUUID()}`) });
  const store = new Storage(config.dataDir);
  await store.lock(async () => {
    await seedMock(store);
    const send = mockFetch(store, config), wait = async (_ms: number) => {};
    const trello = new TrelloClient(config, send, wait);
    await collect(config, store, new DiscordClient(config, send, wait), fixtureNow);
    await retrieveContext(config, store, trello, fixtureNow);
    const input = await prepareAnalysis(store);
    await store.write('analysis.json', referenceAnalysis(input.inputDigest, input.pendingMessageIds), analysisSchema);
    await acceptAnalysis(store, fixtureNow);
    await syncTrello(config, store, trello, fixtureNow);
    const simulated = { ...config, dryRun: false };
    await syncTrello(simulated, store, new TrelloClient(simulated, send, wait), fixtureNow);
    const rerun = await syncTrello(simulated, store, new TrelloClient(simulated, send, wait), fixtureNow);
    if (rerun.outcomes.some(o => ['create', 'comment', 'error'].includes(o.operation))) throw new Error('Demo rerun was not idempotent');
    console.log(JSON.stringify({ note: 'Offline demo uses hand-authored analysis expectations. Live semantic analysis must be performed by Codex.', directory: store.dir, summary: await dailySummary(store, fixtureNow) }, null, 2));
  });
} catch (error) { console.error(error instanceof Error ? error.message : 'Demo failed'); process.exitCode = 1; }
