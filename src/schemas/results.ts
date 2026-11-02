import { z } from 'zod';
import { snowflake, taskId, trelloId, utc } from './common.js';

export const outcomeSchema = z.strictObject({
  taskId, operationId: z.string().nullable(), cardId: trelloId.nullable(),
  operation: z.enum(['create', 'comment', 'noop', 'review', 'error', 'resolve']),
  status: z.enum(['planned', 'prepared', 'succeeded', 'review', 'failed', 'not-applied']),
  sourceMessageIds: z.array(snowflake), message: z.string(),
});
export const reportSchema = z.strictObject({
  id: z.uuid(), at: utc, dryRun: z.boolean(), outcomes: z.array(outcomeSchema),
});
export const resultsSchema = z.strictObject({ version: z.literal(1), runs: z.array(reportSchema) });
export type Report = z.infer<typeof reportSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
