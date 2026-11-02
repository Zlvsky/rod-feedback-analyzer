import { parseArgs } from 'node:util';
import { loadConfig, requireConfig } from '../config/index.js';
import { importSelectedForumPosts } from '../services/forum-import-selected.js';
import { Storage } from '../services/storage.js';

const flags = parseArgs({ options: {
  'data-dir': { type: 'string' }, 'run-id': { type: 'string' }, apply: { type: 'boolean', default: false },
} }).values;
let token = '';
try {
  if (!flags['run-id']) throw new Error('Import requires --run-id from workflow:begin');
  const config = loadConfig({ ...(flags['data-dir'] ? { dataDir: flags['data-dir'] } : {}) });
  requireConfig(config, 'discord');
  token = config.discord.token;
  const store = new Storage(config.dataDir);
  const result = await store.lock(() => importSelectedForumPosts(store, {
    token, guildId: config.discord.guildId, feedbackChannelId: config.discord.channelIds[0],
    forumId: process.env.DISCORD_FORUM_CHANNEL_ID ?? '', dryRun: config.dryRun,
    apply: flags.apply, timeoutMs: config.timeoutMs,
  }, fetch, progress => console.log(JSON.stringify(progress))), flags['run-id']);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? (token ? error.message.replaceAll(token, '[REDACTED]') : error.message) : 'Forum import failed';
  console.error(`feedback:import-selected: ${message}`);
  process.exitCode = 1;
}
