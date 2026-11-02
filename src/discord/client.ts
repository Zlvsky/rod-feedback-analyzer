import { z } from 'zod';
import type { Config } from '../config/index.js';
import { snowflake } from '../schemas/common.js';
import { ApiHttp, type Fetch, HttpError } from '../services/http.js';

const userSchema = z.object({ id: snowflake, username: z.string(), global_name: z.string().nullable().optional(), bot: z.boolean().optional() });
export const rawMessageSchema = z.object({
  id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(), author: userSchema,
  member: z.object({ nick: z.string().nullable().optional() }).optional(),
  content: z.string().max(10000), timestamp: z.string().datetime({ offset: true }), edited_timestamp: z.string().datetime({ offset: true }).nullable().optional(),
  attachments: z.array(z.object({ id: snowflake, filename: z.string(), size: z.number().int().nonnegative(), url: z.url(), content_type: z.string().optional() })),
  message_reference: z.object({ message_id: snowflake.optional(), channel_id: snowflake.optional(), guild_id: snowflake.optional() }).optional(),
  referenced_message: z.unknown().optional(), webhook_id: snowflake.optional(),
});
export type RawMessage = z.infer<typeof rawMessageSchema>;
export class MissingMessageContentIntentError extends Error {
  constructor() { super('Message Content Intent is disabled for this Discord application. Enable it on the Bot page in the Developer Portal, then retry collection.'); }
}
export class DiscordClient {
  private readonly http: ApiHttp;
  constructor(private readonly config: Config, send?: Fetch, wait?: (ms: number) => Promise<void>) {
    this.http = new ApiHttp('discord', { retries: config.retries, timeoutMs: config.timeoutMs, ...(send ? { fetch: send } : {}), ...(wait ? { wait } : {}) });
  }
  private async get(path: string) {
    return this.http.request(path, { headers: { Authorization: `Bot ${this.config.discord.token}`, 'User-Agent': 'DiscordBot (https://github.com/rod-discord-feedback, 1.0.0)' } });
  }
  private allowed(channelId: string) {
    if (!this.config.discord.channelIds.includes(channelId)) throw new Error('Discord channel is outside the configured allowlist');
  }
  async assertMessageContentAccess(): Promise<void> {
    const application = z.object({ flags: z.number().int().nonnegative() }).parse(await this.get('/applications/@me'));
    const contentFlags = (1 << 18) | (1 << 19);
    if ((application.flags & contentFlags) === 0) throw new MissingMessageContentIntentError();
  }
  async channel(channelId: string) {
    this.allowed(channelId);
    const channel = z.object({ id: snowflake, guild_id: snowflake, name: z.string(), type: z.number() }).parse(await this.get(`/channels/${channelId}`));
    if (channel.id !== channelId || channel.guild_id !== this.config.discord.guildId || ![0, 5].includes(channel.type)) throw new Error('Configured Discord channel must be a text/announcement channel in the configured guild');
    return channel;
  }
  async messages(channelId: string, query: { before?: string; after?: string; limit?: number } = {}): Promise<RawMessage[]> {
    this.allowed(channelId);
    if (query.before && query.after) throw new Error('Discord before/after are mutually exclusive');
    const params = new URLSearchParams({ limit: String(query.limit ?? 100) });
    if (query.before) params.set('before', snowflake.parse(query.before));
    if (query.after) params.set('after', snowflake.parse(query.after));
    const messages = z.array(rawMessageSchema).max(100).parse(await this.get(`/channels/${channelId}/messages?${params}`));
    for (const message of messages) this.verify(message, channelId);
    return messages;
  }
  async message(channelId: string, messageId: string): Promise<RawMessage | null> {
    this.allowed(channelId); snowflake.parse(messageId);
    try {
      const message = rawMessageSchema.parse(await this.get(`/channels/${channelId}/messages/${messageId}`));
      this.verify(message, channelId);
      if (message.id !== messageId) throw new Error('Discord returned the wrong referenced message');
      return message;
    } catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
  }
  verify(message: RawMessage, channelId: string): void {
    if (message.channel_id !== channelId || (message.guild_id && message.guild_id !== this.config.discord.guildId)) throw new Error('Discord message is outside the configured scope');
  }
}
