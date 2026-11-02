import { parseArgs } from 'node:util';
import { loadConfig, requireConfig, type Config } from '../config/index.js';
import { Storage } from '../services/storage.js';
import { DiscordClient } from '../discord/client.js';
import { TrelloClient } from '../trello/client.js';
import { mockFetch, seedMock } from '../mock/server.js';
import { fixtureNow } from '../mock/conversations.js';

export const args = () => parseArgs({ options: {
  mock: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  'data-dir': { type: 'string' }, 'run-id': { type: 'string' }, 'simulate-writes': { type: 'boolean', default: false },
  operation: { type: 'string' }, 'not-applied': { type: 'boolean', default: false },
  'full-history': { type: 'boolean', default: false }, 'feedback-only': { type: 'boolean', default: false },
} }).values;
export interface Runtime { config: Config; store: Storage; discord: DiscordClient; trello: TrelloClient; now: Date }
export async function runtime(): Promise<Runtime> {
  const flags = args();
  const config = loadConfig({ mock: flags.mock, dryRun: flags['dry-run'], ...(flags['data-dir'] ? { dataDir: flags['data-dir'] } : {}) });
  if (flags['simulate-writes']) {
    if (!config.mock) throw new Error('--simulate-writes is available only with --mock');
    config.dryRun = flags['dry-run'];
  }
  const store = new Storage(config.dataDir);
  const send = config.mock ? mockFetch(store, config) : undefined;
  const wait = config.mock ? async (_ms: number) => {} : undefined;
  return { config, store, discord: new DiscordClient(config, send, wait), trello: new TrelloClient(config, send, wait), now: config.mock ? fixtureNow : new Date() };
}
export async function cli(stage: string, requirements: 'discord' | 'trello' | 'all' | null, action: (context: Runtime) => Promise<unknown>): Promise<void> {
  let context: Runtime | undefined;
  try {
    context = await runtime();
    if (requirements) requireConfig(context.config, requirements);
    const current = context;
    const result = await current.store.lock(async () => {
      if (current.config.mock) await seedMock(current.store);
      try {
        const value = await action(current);
        const state = await current.store.state();
        if (state.errors.some(e => e.id === `cli:${stage}`)) {
          state.errors = state.errors.filter(e => e.id !== `cli:${stage}`); await current.store.saveState(state);
        }
        return value;
      } catch (error) {
        // Preserve the original error if storage itself is damaged/unavailable.
        await (async () => {
          const state = await current.store.state();
          state.errors = state.errors.filter(e => e.id !== `cli:${stage}`);
          state.errors.push({ id: `cli:${stage}`, stage, taskId: null, at: current.now.toISOString(), message: `${stage} failed; rerun this stage after resolving the reported error.` });
          await current.store.saveState(state);
        })().catch(() => {});
        throw error;
      }
    }, args()['run-id']);
    console.log(JSON.stringify({ stage, mode: current.config.mock ? 'mock (no network)' : current.config.dryRun ? 'dry-run' : 'live', result }, null, 2));
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Unexpected failure';
    for (const secret of [context?.config.discord.token, context?.config.trello.key, context?.config.trello.token]) if (secret) message = message.replaceAll(secret, '[REDACTED]');
    console.error(`${stage}: ${message}`); process.exitCode = 1;
  }
}
