import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { snowflake, trelloId } from '../schemas/common.js';
import type { State } from '../schemas/state.js';

const integer = (fallback: number, min: number, max: number) => z.preprocess(
  v => v === undefined || v === '' ? fallback : Number(v), z.number().int().min(min).max(max));
const boolean = (fallback: boolean) => z.preprocess(v => v === undefined ? fallback : v, z.enum(['true', 'false']).or(z.boolean()))
  .transform(v => v === true || v === 'true');
const optionsSchema = z.object({
  DRY_RUN: boolean(true), MOCK_MODE: boolean(false), DATA_DIR: z.string().default('./data'),
  INITIAL_LOOKBACK_DAYS: integer(7, 1, 365), COLLECTION_OVERLAP_MINUTES: integer(60, 0, 10080),
  CONTEXT_MESSAGES: integer(3, 0, 20), HTTP_MAX_RETRIES: integer(4, 0, 10), HTTP_TIMEOUT_MS: integer(20000, 100, 120000),
});
export interface Config {
  dataDir: string; mock: boolean; dryRun: boolean; lookbackDays: number; overlapMinutes: number; contextMessages: number;
  retries: number; timeoutMs: number;
  discord: { token: string; guildId: string; channelIds: [string, string] };
  trello: { key: string; token: string; boardId: string; listId: string };
}
export const MOCK_IDS = {
  guild: '100000000000000001', feedback: '100000000000000002', general: '100000000000000003',
  board: 'aaaaaaaaaaaaaaaaaaaaaaaa', list: 'bbbbbbbbbbbbbbbbbbbbbbbb',
};
export function loadConfig(flags: { mock?: boolean; dryRun?: boolean; dataDir?: string } = {}, env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) dotenv({ quiet: true });
  // Mock mode intentionally ignores live credentials and live storage settings.
  const mock = flags.mock || env.MOCK_MODE === 'true';
  const options = optionsSchema.parse(mock ? { ...env, MOCK_MODE: true, DRY_RUN: true } : env);
  const config: Config = {
    dataDir: resolve(flags.dataDir ?? (mock ? './data/mock' : options.DATA_DIR)), mock,
    dryRun: flags.dryRun || options.DRY_RUN,
    lookbackDays: options.INITIAL_LOOKBACK_DAYS, overlapMinutes: options.COLLECTION_OVERLAP_MINUTES,
    contextMessages: options.CONTEXT_MESSAGES, retries: options.HTTP_MAX_RETRIES, timeoutMs: options.HTTP_TIMEOUT_MS,
    discord: { token: env.DISCORD_BOT_TOKEN ?? '', guildId: env.DISCORD_GUILD_ID ?? '', channelIds: [env.DISCORD_FEEDBACK_CHANNEL_ID ?? '', env.DISCORD_GENERAL_EN_CHANNEL_ID ?? ''] },
    trello: { key: env.TRELLO_API_KEY?.trim() || env.TRELLO_KEY?.trim() || '', token: env.TRELLO_TOKEN ?? '', boardId: env.TRELLO_BOARD_ID ?? '', listId: env.TRELLO_LIST_ID ?? '' },
  };
  if (mock) {
    config.discord = { token: 'mock-discord', guildId: MOCK_IDS.guild, channelIds: [MOCK_IDS.feedback, MOCK_IDS.general] };
    config.trello = { key: 'mock-key', token: 'mock-token', boardId: MOCK_IDS.board, listId: MOCK_IDS.list };
    if (config.dataDir === resolve('./data')) throw new Error('Mock mode cannot use the live data directory');
  }
  return config;
}
export function requireConfig(c: Config, stage: 'discord' | 'trello' | 'all'): void {
  const checks: [string, unknown, z.ZodType][] = [];
  if (stage !== 'trello') checks.push(
    ['DISCORD_BOT_TOKEN', c.discord.token, z.string().trim().min(1)], ['DISCORD_GUILD_ID', c.discord.guildId, snowflake],
    ['DISCORD_FEEDBACK_CHANNEL_ID', c.discord.channelIds[0], snowflake], ['DISCORD_GENERAL_EN_CHANNEL_ID', c.discord.channelIds[1], snowflake]);
  if (stage !== 'discord') checks.push(
    ['TRELLO_API_KEY', c.trello.key, z.string().trim().min(1)], ['TRELLO_TOKEN', c.trello.token, z.string().trim().min(1)],
    ['TRELLO_BOARD_ID', c.trello.boardId, trelloId], ['TRELLO_LIST_ID', c.trello.listId, trelloId]);
  const invalid = checks.filter(([, value, schema]) => !schema.safeParse(value).success).map(([key]) => key);
  if (invalid.length) throw new Error(`Missing or invalid configuration: ${invalid.join(', ')}. Fill .env locally; use --mock for offline fixtures.`);
  if (stage !== 'trello' && c.discord.channelIds[0] === c.discord.channelIds[1]) throw new Error('Discord channel IDs must be distinct');
}
export function bindScope(state: State, c: Config, kind: 'discord' | 'trello'): void {
  const next = kind === 'discord' ? { guildId: c.discord.guildId, channelIds: [...c.discord.channelIds].sort() } : { boardId: c.trello.boardId, listId: c.trello.listId };
  const previous = state.scope[kind];
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) throw new Error(`Storage is bound to another ${kind} configuration. Use a separate DATA_DIR.`);
  if (kind === 'discord') state.scope.discord = next as NonNullable<State['scope']['discord']>;
  else state.scope.trello = next as NonNullable<State['scope']['trello']>;
}
