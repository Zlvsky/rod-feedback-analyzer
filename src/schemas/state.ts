import { z } from 'zod';
import { snowflake, taskId, trelloId, utc } from './common.js';

export const operationSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/), taskId, kind: z.enum(['create', 'comment']),
  cardId: trelloId.nullable(), sourceMessageIds: z.array(snowflake),
  status: z.enum(['prepared', 'succeeded', 'uncertain', 'not-applied']), at: utc,
});
export const stateSchema = z.strictObject({
  version: z.literal(1),
  scope: z.strictObject({
    discord: z.strictObject({ guildId: snowflake, channelIds: z.array(snowflake).length(2) }).nullable(),
    trello: z.strictObject({ boardId: trelloId, listId: trelloId }).nullable(),
  }),
  collection: z.strictObject({ channels: z.record(snowflake, z.strictObject({
    lastMessageId: snowflake.nullable(), since: utc, lastCollectedAt: utc,
  })) }),
  analysis: z.strictObject({ analyzedMessageIds: z.array(snowflake), ignoredMessages: z.record(snowflake, z.string()) }),
  sync: z.strictObject({
    awaitingTaskIds: z.array(taskId), synchronizedTaskIds: z.array(taskId),
    taskCards: z.record(taskId, z.strictObject({ cardId: trelloId, sourceMessageIds: z.array(snowflake) })),
    messageCards: z.record(snowflake, z.array(trelloId)), operations: z.record(z.string(), operationSchema),
  }),
  lastSuccessfulRun: z.record(z.string(), utc),
  errors: z.array(z.strictObject({ id: z.string(), stage: z.string(), taskId: taskId.nullable(), at: utc, message: z.string() })),
});
export const emptyState = (): z.infer<typeof stateSchema> => ({
  version: 1, scope: { discord: null, trello: null }, collection: { channels: {} }, analysis: { analyzedMessageIds: [], ignoredMessages: {} },
  sync: { awaitingTaskIds: [], synchronizedTaskIds: [], taskCards: {}, messageCards: {}, operations: {} },
  lastSuccessfulRun: {}, errors: [],
});
export type State = z.infer<typeof stateSchema>;
export type Operation = z.infer<typeof operationSchema>;
