import { createHash } from 'node:crypto';
import type { Message } from '../schemas/messages.js';
import type { Task } from '../schemas/tasks.js';
import { unique } from '../schemas/common.js';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const compareIds = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
export const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);
export const snowflakeAt = (ms: number) => ((BigInt(Math.max(1420070400001, Math.floor(ms))) - 1420070400000n) << 22n).toString();
export function mergeMessages(previous: Message[], incoming: Message[], recoverEmptyIds: ReadonlySet<string> = new Set()): Message[] {
  const byId = new Map(previous.map(m => [m.id, m]));
  for (const message of incoming) {
    const old = byId.get(message.id);
    // Keep original quotes. Only explicitly selected, unprocessed empty records
    // may be hydrated after recovering Message Content Intent access.
    const hydrate = old && recoverEmptyIds.has(old.id) && old.content === '' && !old.attachments.length;
    byId.set(message.id, old ? { ...(hydrate ? message : old), contextOnly: old.contextOnly && message.contextOnly, contextMessageIds: unique([...old.contextMessageIds, ...message.contextMessageIds]).slice(-40), replyContext: old.replyContext?.content ? old.replyContext : message.replyContext ?? old.replyContext } : message);
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}
export function mergeTask(old: Task | undefined, incoming: Task): Task {
  if (!old) return { ...incoming, syncStatus: 'pending' };
  if (old.relatedExistingCardId && incoming.relatedExistingCardId && old.relatedExistingCardId !== incoming.relatedExistingCardId) throw new Error(`Task ${old.id} cannot change its existing Trello match`);
  const sources = new Map(old.sources.map(s => [s.messageId, s]));
  for (const source of incoming.sources) if (!sources.has(source.messageId)) sources.set(source.messageId, source);
  return { ...incoming, relatedExistingCardId: old.relatedExistingCardId ?? incoming.relatedExistingCardId, sources: [...sources.values()], syncStatus: sources.size > old.sources.length ? 'pending' : old.syncStatus };
}
export function taskMarkers(text: string): string[] {
  return unique([...text.matchAll(/\[rod-task:(rod-[a-z0-9-]+)\]/g)].map(m => m[1]!));
}
export function sourceIds(text: string): string[] {
  return unique([
    ...[...text.matchAll(/https:\/\/discord\.com\/channels\/\d+\/\d+\/([1-9]\d{16,19})\b/g)].map(m => m[1]!),
    ...[...text.matchAll(/\[rod-source:rod-[a-z0-9-]+:([1-9]\d{16,19})\]/g)].map(m => m[1]!),
  ]);
}
export const sourceMarker = (taskId: string, messageId: string) => `[rod-source:${taskId}:${messageId}]`;
export const taskMarker = (taskId: string) => `[rod-task:${taskId}]`;
export const operationMarker = (id: string) => `[rod-op:${id}]`;
