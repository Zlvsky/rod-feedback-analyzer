import { z } from 'zod';
import { snowflake, trelloId, utc } from './common.js';

export const labelSchema = z.object({ id: trelloId, name: z.string(), color: z.string().nullable() });
export const listSchema = z.object({ id: trelloId, idBoard: trelloId, name: z.string(), closed: z.boolean() });
export const cardSchema = z.object({
  id: trelloId, idBoard: trelloId, idList: trelloId, name: z.string(), desc: z.string(),
  closed: z.boolean(), labels: z.array(labelSchema),
});
export const actionSchema = z.object({ id: trelloId, date: utc, data: z.object({ text: z.string() }) });
export const contextSchema = z.strictObject({
  version: z.literal(1), boardId: trelloId, fetchedAt: utc,
  cards: z.array(z.strictObject({
    id: trelloId, title: z.string(), description: z.string(), labels: z.array(labelSchema),
    list: z.strictObject({ id: trelloId, name: z.string() }), archived: z.boolean(),
    discordSourceIds: z.array(snowflake), automationTaskIds: z.array(z.string()),
  })),
});
export type Card = z.infer<typeof cardSchema>;
export type Label = z.infer<typeof labelSchema>;
export type TrelloList = z.infer<typeof listSchema>;
export type Action = z.infer<typeof actionSchema>;
export type TrelloContext = z.infer<typeof contextSchema>;
