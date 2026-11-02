import { z } from 'zod';
import { discordUrl, snowflake, utc } from './common.js';

export const attachmentSchema = z.strictObject({
  id: snowflake, filename: z.string().max(1024), size: z.number().int().nonnegative(),
  url: z.url(), contentType: z.string().nullable(),
});
export const replySchema = z.strictObject({
  messageId: snowflake, authorId: snowflake, nickname: z.string(), content: z.string().max(10000),
  timestamp: utc, permalink: discordUrl,
});
export const messageSchema = z.strictObject({
  id: snowflake, guildId: snowflake, channelId: snowflake, channelName: z.string().min(1),
  authorId: snowflake, authorUsername: z.string(), authorDisplayName: z.string(),
  timestamp: utc, editedTimestamp: utc.nullable(), content: z.string().max(10000), permalink: discordUrl,
  referencedMessageId: snowflake.nullable(), replyContext: replySchema.nullable(),
  contextMessageIds: z.array(snowflake).max(40), attachments: z.array(attachmentSchema),
  contextOnly: z.boolean(),
}).superRefine((m, ctx) => {
  if (m.permalink !== `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.id}`)
    ctx.addIssue({ code: 'custom', message: 'Permalink does not match message identity' });
});
export const messagesSchema = z.strictObject({ version: z.literal(1), messages: z.array(messageSchema) }).superRefine((data, ctx) => {
  if (new Set(data.messages.map(m => m.id)).size !== data.messages.length) ctx.addIssue({ code: 'custom', message: 'Duplicate stored message ID' });
});
export type Message = z.infer<typeof messageSchema>;
export type Messages = z.infer<typeof messagesSchema>;
