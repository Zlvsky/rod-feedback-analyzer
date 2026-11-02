import { z } from 'zod';
import { resultsSchema } from '../schemas/results.js';
import { Storage } from './storage.js';

export async function dailySummary(store: Storage, now = new Date()) {
  const [messages, tasks, state, results] = await Promise.all([store.messages(), store.tasks(), store.state(), store.read('sync-results.json', resultsSchema, () => ({ version: 1 as const, runs: [] }))]);
  const processed = new Set([...state.analysis.analyzedMessageIds, ...Object.keys(state.analysis.ignoredMessages)]);
  const summary = {
    at: now.toISOString(), messagesStored: messages.messages.length, analyzed: state.analysis.analyzedMessageIds.length,
    ignored: Object.keys(state.analysis.ignoredMessages).length,
    awaitingAnalysis: messages.messages.filter(m => !m.contextOnly && !processed.has(m.id)).length,
    tasksStored: tasks.tasks.length, pendingTasks: tasks.tasks.filter(t => t.syncStatus === 'pending').length,
    reviewTasks: tasks.tasks.filter(t => t.syncStatus === 'review').map(t => t.id),
    synchronizedTasks: tasks.tasks.filter(t => t.syncStatus === 'synced').length,
    lastSuccessfulRun: state.lastSuccessfulRun, errors: state.errors, latestSync: results.runs.at(-1) ?? null,
  };
  await store.write('daily-summary.json', summary, z.object({ at: z.string() }).passthrough());
  return summary;
}
