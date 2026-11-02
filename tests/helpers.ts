import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { Storage } from '../src/services/storage.js';
import { mockFetch, seedMock } from '../src/mock/server.js';
import { DiscordClient } from '../src/discord/client.js';
import { TrelloClient } from '../src/trello/client.js';
import { collect } from '../src/discord/collector.js';
import { fixtureNow } from '../src/mock/conversations.js';
import { retrieveContext } from '../src/trello/context.js';
import { prepareAnalysis, acceptAnalysis } from '../src/services/analysis.js';
import { referenceAnalysis } from '../src/mock/reference-analysis.js';
import { analysisSchema } from '../src/schemas/tasks.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
export async function setup(seed = true) {
  const dir = await mkdtemp(join(tmpdir(), 'rod-feedback-test-')); dirs.push(dir);
  const config = loadConfig({ mock: true, dataDir: dir }, {});
  const store = new Storage(dir);
  if (seed) await seedMock(store);
  const send = mockFetch(store, config);
  const wait = async (_ms: number) => {};
  return { config, store, send, wait, discord: new DiscordClient(config, send, wait), trello: new TrelloClient(config, send, wait) };
}
export async function analyzed() {
  const context = await setup();
  await collect(context.config, context.store, context.discord, fixtureNow);
  await retrieveContext(context.config, context.store, context.trello, fixtureNow);
  const input = await prepareAnalysis(context.store);
  await context.store.write('analysis.json', referenceAnalysis(input.inputDigest, input.pendingMessageIds), analysisSchema);
  await acceptAnalysis(context.store, fixtureNow);
  return context;
}
