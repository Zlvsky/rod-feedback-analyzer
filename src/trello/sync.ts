import { randomUUID } from 'node:crypto';
import { bindScope, type Config } from '../config/index.js';
import { clearStageErrors } from '../discord/collector.js';
import { resultsSchema, type Outcome, type Report } from '../schemas/results.js';
import { tasksSchema, type Source, type Task } from '../schemas/tasks.js';
import type { Card } from '../schemas/trello.js';
import type { Operation } from '../schemas/state.js';
import { unique } from '../schemas/common.js';
import { digest, operationMarker, sourceIds, sourceMarker, taskMarkers } from '../services/deduplication.js';
import { Storage } from '../services/storage.js';
import { pendingState, validateTasks } from '../services/validation.js';
import { HttpError } from '../services/http.js';
import { TrelloClient } from './client.js';
import { chunks, comment, description, summary } from './format.js';

class ReviewRequired extends Error {}
export const createOperationId = (taskId: string) => digest(['create', taskId]);
export const commentOperationId = (taskId: string, sources: Source[]) => digest(['comment', taskId, sources.map(s => s.messageId).sort()]);
export async function syncTrello(config: Config, store: Storage, client: TrelloClient, now = new Date()): Promise<Report> {
  const state = await store.state(); bindScope(state, config, 'trello'); bindScope(state, config, 'discord');
  const tasks = validateTasks(await store.tasks(), (await store.messages()).messages, config);
  // Never trust a stale context snapshot or a task's AI-supplied synchronization status.
  const board = await client.boardState();
  const textByCard = new Map<string, string>();
  for (const card of board.cards) textByCard.set(card.id, [card.desc, ...(await client.actions(card.id)).map(a => a.data.text)].join('\n'));
  const history = await store.read('sync-results.json', resultsSchema, () => ({ version: 1 as const, runs: [] }));
  const report: Report = { id: randomUUID(), at: now.toISOString(), dryRun: config.dryRun, outcomes: [] };
  history.runs.push(report);
  const saveReport = () => store.write('sync-results.json', history, resultsSchema);
  await saveReport();
  const sourceUse = new Map<string, number>();
  for (const t of tasks.tasks) for (const s of t.sources) sourceUse.set(s.messageId, (sourceUse.get(s.messageId) ?? 0) + 1);
  const persist = async () => {
    pendingState(state, tasks.tasks);
    // Mapping first. If tasks.json fails afterwards, rerun uses the durable mapping.
    await store.saveState(state);
    await store.write('tasks.json', tasks, tasksSchema);
    await saveReport();
  };
  const record = async (outcome: Outcome) => { report.outcomes.push(outcome); await saveReport(); };
  for (const task of tasks.tasks) {
    try {
      if (task.needsClarification || task.possibleExistingCardIds.length || task.confidence < 0.7) throw new ReviewRequired('Clarification, an uncertain match, or confidence below 0.7 requires review');
      const mapping = state.sync.taskCards[task.id];
      const marked = board.cards.filter(c => taskMarkers(textByCard.get(c.id)!).includes(task.id));
      const candidateIds = unique([...(mapping ? [mapping.cardId] : []), ...marked.map(c => c.id), ...(task.relatedExistingCardId ? [task.relatedExistingCardId] : [])]);
      if (candidateIds.length > 1) throw new ReviewRequired('Conflicting mapping, AI match, or automation markers');
      let card: Card | undefined = candidateIds[0] ? board.cards.find(c => c.id === candidateIds[0]) : undefined;
      if (candidateIds.length && !card) throw new ReviewRequired('Mapped/matched card is missing or has moved to another board');
      if (card?.closed) throw new ReviewRequired('Matched card is archived; no changes were made');
      if (!card) {
        const overlaps = board.cards.filter(c => {
          const content = textByCard.get(c.id)!;
          const otherIssue = taskMarkers(content).length && !taskMarkers(content).includes(task.id);
          return task.sources.some(s => sourceIds(content).includes(s.messageId) && !(otherIssue && (sourceUse.get(s.messageId) ?? 0) > 1));
        });
        const titleMatches = board.cards.filter(c => c.name.trim().toLowerCase() === task.title.trim().toLowerCase());
        if (overlaps.length || titleMatches.length) throw new ReviewRequired(`Possible existing card(s): ${unique([...overlaps, ...titleMatches].map(c => c.id)).join(', ')}. Codex must confirm the underlying issue.`);
      }
      let known = new Set(mapping?.sourceMessageIds ?? []);
      if (card) {
        const content = textByCard.get(card.id)!;
        for (const source of task.sources) if (content.includes(sourceMarker(task.id, source.messageId)) || sourceIds(content).includes(source.messageId)) known.add(source.messageId);
        // Repair interrupted operations once remote evidence is visible.
        for (const op of Object.values(state.sync.operations)) {
          if (op.taskId === task.id && (content.includes(operationMarker(op.id)) || op.sourceMessageIds.every(id => known.has(id)))) {
            op.status = 'succeeded'; op.cardId = card.id;
          }
        }
      }
      let newSources = task.sources.filter(s => !known.has(s.messageId));
      if (!newSources.length && card) {
        task.syncStatus = 'synced';
        if (!config.dryRun) {
          setMapping(task, card.id, [...known]); clearStageErrors(state, `sync:${task.id}`); await persist();
        }
        await record({ taskId: task.id, cardId: card.id, operationId: null, operation: 'noop', status: 'succeeded', sourceMessageIds: [], message: 'All supporting sources already exist' });
        continue;
      }
      const outstanding = Object.values(state.sync.operations).filter(op => op.taskId === task.id && ['prepared', 'uncertain'].includes(op.status));
      if (outstanding.length) throw new ReviewRequired(`Unconfirmed remote write(s): ${outstanding.map(op => op.id).join(', ')}. Reconcile before retrying.`);
      const initialBatch = !card ? chunks(task, newSources, Math.max(2500, 14000 - summary(task).length))[0]! : null;
      if (config.dryRun) {
        if (initialBatch) {
          await record({ taskId: task.id, cardId: null, operationId: createOperationId(task.id), operation: 'create', status: 'planned', sourceMessageIds: initialBatch.map(s => s.messageId), message: `Would create: ${task.title}` });
          newSources = newSources.filter(s => !initialBatch.some(i => i.messageId === s.messageId));
        }
        for (const batch of chunks(task, newSources)) await record({ taskId: task.id, cardId: card?.id ?? null, operationId: commentOperationId(task.id, batch), operation: 'comment', status: 'planned', sourceMessageIds: batch.map(s => s.messageId), message: 'Would append only new supporting evidence' });
        continue;
      }
      if (!card && initialBatch) {
        const id = createOperationId(task.id);
        await prepareOperation(id, task, 'create', null, initialBatch);
        const labels = board.labels.filter(l => l.name.trim().toLowerCase() === task.type || l.name.trim().toLowerCase() === task.impact).map(l => l.id);
        card = await client.createCard(task.title, description(task, initialBatch, id), labels);
        board.cards.push(card); textByCard.set(card.id, card.desc);
        known = new Set(initialBatch.map(s => s.messageId));
        await completeOperation(id, task, card.id, known);
        newSources = newSources.filter(s => !known.has(s.messageId));
      }
      if (!card) throw new Error('Synchronization has no destination card');
      for (const batch of chunks(task, newSources)) {
        const id = commentOperationId(task.id, batch);
        await prepareOperation(id, task, 'comment', card.id, batch);
        const body = comment(task, batch, id);
        await client.comment(card.id, body);
        textByCard.set(card.id, textByCard.get(card.id)! + '\n' + body);
        batch.forEach(s => known.add(s.messageId));
        await completeOperation(id, task, card.id, known);
      }
      task.syncStatus = 'synced'; clearStageErrors(state, `sync:${task.id}`); await persist();
    } catch (error) {
      const review = error instanceof ReviewRequired;
      const message = review ? error.message : 'Synchronization failed; inspect configuration, API availability, and any unresolved operation before retrying.';
      if (!config.dryRun) {
        task.syncStatus = review ? 'review' : 'pending';
        for (const op of Object.values(state.sync.operations)) if (op.taskId === task.id && op.status === 'prepared') op.status = error instanceof HttpError && error.status < 500 ? 'not-applied' : 'uncertain';
        clearStageErrors(state, `sync:${task.id}`);
        state.errors.push({ id: `sync:${task.id}`, stage: `sync:${task.id}`, taskId: task.id, at: now.toISOString(), message });
        await persist();
      }
      await record({ taskId: task.id, cardId: state.sync.taskCards[task.id]?.cardId ?? null, operationId: null, operation: review ? 'review' : 'error', status: review ? 'review' : 'failed', sourceMessageIds: [], message });
    }
  }
  if (!config.dryRun && !report.outcomes.some(o => o.status === 'failed' || o.status === 'review')) {
    state.lastSuccessfulRun.sync = now.toISOString(); await persist();
  }
  await saveReport(); return report;

  function setMapping(task: Task, cardId: string, sources: string[]) {
    state.sync.taskCards[task.id] = { cardId, sourceMessageIds: unique(sources) };
    for (const messageId of sources) state.sync.messageCards[messageId] = unique([...(state.sync.messageCards[messageId] ?? []), cardId]);
  }
  async function prepareOperation(id: string, task: Task, kind: Operation['kind'], cardId: string | null, sources: Source[]) {
    const op: Operation = { id, taskId: task.id, kind, cardId, sourceMessageIds: sources.map(s => s.messageId), status: 'prepared', at: now.toISOString() };
    state.sync.operations[id] = op;
    await store.saveState(state); // durable intent BEFORE any POST
    await record({ taskId: task.id, cardId, operationId: id, operation: kind, status: 'prepared', sourceMessageIds: op.sourceMessageIds, message: 'Durable intent saved before request' });
  }
  async function completeOperation(id: string, task: Task, cardId: string, known: Set<string>) {
    const op = state.sync.operations[id]!;
    op.status = 'succeeded'; op.cardId = cardId;
    setMapping(task, cardId, [...known]);
    await store.saveState(state);
    await record({ taskId: task.id, cardId, operationId: id, operation: op.kind, status: 'succeeded', sourceMessageIds: op.sourceMessageIds, message: 'Remote write completed' });
  }
}
