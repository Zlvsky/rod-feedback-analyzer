import type { Source, Task } from '../schemas/tasks.js';
import { operationMarker, sourceMarker, taskMarker } from '../services/deduplication.js';

// Keep player text literal and prevent accidental mentions or forged Markdown links.
export const literal = (text: string) => text.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/@/g, '@\u200b');
export function evidence(task: Task, sources: Source[]): string {
  return sources.map(s => [
    `Player: ${literal(s.nickname)} | ${s.timestamp} | #${literal(s.channel)}`,
    ...s.excerpt.split('\n').map(line => `> ${literal(line)}`),
    `Source: ${s.permalink}`, sourceMarker(task.id, s.messageId),
  ].join('\n')).join('\n\n');
}
export function summary(task: Task): string {
  return `Summary:\n${literal(task.description)}\n\nSuggested action:\n${literal(task.suggestedAction)}\n\nClassification:\nType: ${task.type}\nImpact: ${task.impact}\nConfidence: ${task.confidence}\n`;
}
export function description(task: Task, sources: Source[], operationId: string): string {
  return `${summary(task)}\nPlayer feedback and sources:\n${evidence(task, sources)}\n\n${taskMarker(task.id)}\n${operationMarker(operationId)}`;
}
export function comment(task: Task, sources: Source[], operationId: string): string {
  return `Additional Realm of Dungeons player feedback:\n\n${evidence(task, sources)}\n\n${taskMarker(task.id)}\n${operationMarker(operationId)}`;
}
export function chunks(task: Task, sources: Source[], budget = 11500): Source[][] {
  const batches: Source[][] = [];
  let batch: Source[] = [];
  for (const source of sources) {
    if (evidence(task, [source]).length > budget) throw new Error('Evidence exceeds the Trello text budget');
    if (batch.length && evidence(task, [...batch, source]).length > budget) { batches.push(batch); batch = []; }
    batch.push(source);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
