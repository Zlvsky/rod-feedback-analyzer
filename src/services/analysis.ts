import { z } from 'zod';
import { contextSchema } from '../schemas/trello.js';
import { analysisSchema, tasksSchema } from '../schemas/tasks.js';
import { unique } from '../schemas/common.js';
import { digest, mergeTask } from './deduplication.js';
import { Storage } from './storage.js';
import { pendingState, validateTasks } from './validation.js';
import { clearStageErrors } from '../discord/collector.js';

export async function analysisInput(store: Storage) {
  const [messages, tasks, state, context] = await Promise.all([
    store.messages(), store.tasks(), store.state(), store.read('trello-context.json', contextSchema.nullable(), () => null),
  ]);
  validateTasks(tasks, messages.messages);
  if (state.errors.some(error => error.stage === 'collect:message-content')) throw new Error('Collection is blocked by Message Content Intent. Restore access and recollect before analysis.');
  const candidates = messages.messages.filter(message => !message.contextOnly);
  if (candidates.length && candidates.every(message => !message.content.trim() && !message.attachments.length)) throw new Error('All collected message bodies are empty. Check Message Content Intent and recollect; these messages must not be ignored as casual chat.');
  const processed = new Set([...state.analysis.analyzedMessageIds, ...Object.keys(state.analysis.ignoredMessages)]);
  const queue = messages.messages.filter(m => !m.contextOnly && !processed.has(m.id)).map(m => m.id);
  const payload = { messages, tasks, context, queue, analysisState: state.analysis };
  return { version: 1 as const, inputDigest: digest(payload), pendingMessageIds: queue, messagesFile: 'messages.json', tasksFile: 'tasks.json', contextFile: 'trello-context.json' };
}
export async function prepareAnalysis(store: Storage) {
  const input = await analysisInput(store);
  await store.write('analysis-input.json', input, z.object({ version: z.literal(1), inputDigest: z.string(), pendingMessageIds: z.array(z.string()), messagesFile: z.string(), tasksFile: z.string(), contextFile: z.string() }));
  return input;
}
export async function acceptAnalysis(store: Storage, now = new Date()) {
  const draft = await store.read('analysis.json', analysisSchema);
  const input = await analysisInput(store);
  if (draft.inputDigest !== input.inputDigest) throw new Error('Analysis input changed. Run analysis:prepare and rebase the draft before accepting.');
  const messages = await store.messages();
  const old = await store.tasks();
  const state = await store.state();
  const draftTasks = validateTasks({ version: 1, tasks: draft.tasks }, messages.messages).tasks;
  const pending = new Set(input.pendingMessageIds);
  const analyzed = new Set(draft.analyzedMessageIds);
  const ignored = new Set(draft.ignoredMessages.map(m => m.messageId));
  if (analyzed.size !== draft.analyzedMessageIds.length || ignored.size !== draft.ignoredMessages.length) throw new Error('Duplicate analysis dispositions');
  for (const id of [...analyzed, ...ignored]) if (!pending.has(id)) throw new Error(`Disposition references a message outside this analysis queue: ${id}`);
  for (const id of analyzed) {
    if (ignored.has(id)) throw new Error('A message cannot be both analyzed and ignored');
    if (!draftTasks.some(t => t.sources.some(s => s.messageId === id))) throw new Error(`Analyzed message ${id} has no resulting task evidence`);
  }
  for (const task of draftTasks) for (const source of task.sources) {
    if (ignored.has(source.messageId)) throw new Error('Ignored message also appears as task evidence');
    if (pending.has(source.messageId) && !analyzed.has(source.messageId)) throw new Error('New task evidence must have an analyzed disposition');
  }
  const byId = new Map(old.tasks.map(t => [t.id, t]));
  for (const task of draftTasks) {
    const merged = mergeTask(byId.get(task.id), task);
    const mapping = state.sync.taskCards[task.id];
    if (mapping && task.relatedExistingCardId && task.relatedExistingCardId !== mapping.cardId) throw new Error('Analysis cannot redirect a synchronized task');
    merged.syncStatus = merged.needsClarification || merged.possibleExistingCardIds.length ? 'review' : mapping && merged.sources.every(s => mapping.sourceMessageIds.includes(s.messageId)) ? 'synced' : 'pending';
    byId.set(task.id, merged);
  }
  const tasks = validateTasks({ version: 1, tasks: [...byId.values()] }, messages.messages);
  // Tasks first: a crash before the checkpoint may cause reanalysis but cannot lose a task.
  await store.write('tasks.json', tasks, tasksSchema);
  state.analysis.analyzedMessageIds = unique([...state.analysis.analyzedMessageIds, ...analyzed]);
  for (const item of draft.ignoredMessages) state.analysis.ignoredMessages[item.messageId] = item.reason;
  pendingState(state, tasks.tasks); clearStageErrors(state, 'analysis');
  state.lastSuccessfulRun.analysis = now.toISOString(); await store.saveState(state);
  return { tasks: tasks.tasks.length, analyzed: analyzed.size, ignored: ignored.size, remaining: pending.size - analyzed.size - ignored.size };
}
