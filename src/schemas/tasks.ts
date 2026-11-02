import { z } from 'zod';
import { discordUrl, snowflake, taskId, text, trelloId, utc } from './common.js';

export const sourceSchema = z.strictObject({
  messageId: snowflake, nickname: text(200), channel: text(200), timestamp: utc,
  permalink: discordUrl, excerpt: text(1500),
});
export const taskSchema = z.strictObject({
  id: taskId, title: text(160).refine(v => !v.includes('\n'), 'Title must be one line'),
  description: text(4000), suggestedAction: text(2000),
  type: z.enum(['bug', 'balancing', 'feature', 'improvement']), impact: z.enum(['minor', 'major']),
  confidence: z.number().min(0).max(1), needsClarification: z.boolean(),
  sources: z.array(sourceSchema).min(1).max(500),
  relatedExistingCardId: trelloId.nullable(), possibleExistingCardIds: z.array(trelloId).max(20),
  syncStatus: z.enum(['pending', 'synced', 'review']),
}).superRefine((task, ctx) => {
  if (new Set(task.sources.map(s => s.messageId)).size !== task.sources.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate source message ID in task' });
  if (task.relatedExistingCardId && task.possibleExistingCardIds.length)
    ctx.addIssue({ code: 'custom', message: 'A match cannot be both confirmed and uncertain' });
});
export const tasksSchema = z.strictObject({ version: z.literal(1), tasks: z.array(taskSchema) })
  .superRefine((data, ctx) => {
    if (new Set(data.tasks.map(t => t.id)).size !== data.tasks.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate stable task ID' });
  });
export const analysisSchema = z.strictObject({
  version: z.literal(1), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tasks: z.array(taskSchema), analyzedMessageIds: z.array(snowflake),
  ignoredMessages: z.array(z.strictObject({ messageId: snowflake, reason: text(500) })),
});
export type Task = z.infer<typeof taskSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Tasks = z.infer<typeof tasksSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
