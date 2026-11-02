import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { TrelloClient } from '../../src/trello/client.js';
import { syncTrello, createOperationId } from '../../src/trello/sync.js';
import { retrieveContext } from '../../src/trello/context.js';
import { mockBoardSchema, fixtureTask, fixtureSource } from '../../src/mock/server.js';
import { existingCardId, fixtureNow, pendingTaskId, previousCardId, previousTaskId, conversation } from '../fixtures/conversations.js';
import { analyzed, setup } from '../helpers.js';
import { tasksSchema } from '../../src/schemas/tasks.js';
import { operationMarker, sourceMarker, taskMarker } from '../../src/services/deduplication.js';

describe('board-wide context and safe Trello synchronization', () => {
  it('includes cards across all lists, archived status, and source references from comments', async () => {
    const { config, store, trello } = await setup(); const server = await store.read('mock-server.json', mockBoardSchema);
    server.cards[1]!.closed = true;
    server.actions[existingCardId] = [{ id: '111111111111111111111111', date: fixtureNow.toISOString(), data: { text: fixtureSource(10).permalink } }];
    await store.write('mock-server.json', server, mockBoardSchema);
    const context = await retrieveContext(config, store, trello, fixtureNow);
    expect(context.cards.find(c => c.id === existingCardId)).toMatchObject({ archived: true, list: { name: 'In progress' }, discordSourceIds: [conversation[10]!.id] });
  });
  it('performs the full offline pipeline, retries 429, appends new evidence, applies labels, and stays idempotent', async () => {
    const { config, store, send, wait } = await analyzed(); const liveMock = { ...config, dryRun: false };
    const original = (await store.read('mock-server.json', mockBoardSchema)).cards.find(c => c.id === existingCardId)!;
    const report = await syncTrello(liveMock, store, new TrelloClient(liveMock, send, wait), fixtureNow);
    expect(report.outcomes.filter(o => o.operation === 'create' && o.status === 'succeeded')).toHaveLength(6);
    expect(report.outcomes.filter(o => o.operation === 'comment' && o.status === 'succeeded')).toHaveLength(2);
    expect(report.outcomes.filter(o => o.operation === 'review')).toHaveLength(1);
    const server = await store.read('mock-server.json', mockBoardSchema);
    expect(server.cards).toHaveLength(8); expect(server.rateLimitedOnce).toBe(true); expect(server.writeAttempts).toBe(9);
    expect(server.cards.find(c => c.id === existingCardId)).toEqual(original);
    expect(server.actions[previousCardId]![0]!.data.text).not.toContain(fixtureSource(1).permalink);
    expect(server.actions[previousCardId]![0]!.data.text).toContain(fixtureSource(9).permalink);
    expect(server.cards.find(c => c.desc.includes(taskMarker(pendingTaskId)))!.labels.map(l => l.name)).toEqual(['improvement', 'minor']);
    const before = server.writeAttempts;
    const rerun = await syncTrello(liveMock, store, new TrelloClient(liveMock, send, wait), fixtureNow);
    expect(rerun.outcomes.some(o => ['create', 'comment', 'error'].includes(o.operation))).toBe(false);
    expect((await store.read('mock-server.json', mockBoardSchema)).writeAttempts).toBe(before);
    expect((await store.state()).sync.messageCards[conversation[7]!.id]).toHaveLength(2);
  });
  it('dry-run saves planned operations but changes neither processing state, tasks, nor mock Trello', async () => {
    const { config, store, trello } = await analyzed();
    const before = await Promise.all(['state.json', 'tasks.json', 'mock-server.json'].map(name => readFile(store.path(name), 'utf8')));
    const report = await syncTrello(config, store, trello, fixtureNow);
    expect(report.outcomes.some(o => o.status === 'planned')).toBe(true);
    expect(await Promise.all(['state.json', 'tasks.json', 'mock-server.json'].map(name => readFile(store.path(name), 'utf8')))).toEqual(before);
    await expect(trello.createCard('test', 'test', [])).rejects.toThrow('dry-run');
  });
  it('refuses a destination list on another board before writes', async () => {
    const { config, store, send, wait } = await analyzed(); const server = await store.read('mock-server.json', mockBoardSchema);
    server.lists[0]!.idBoard = 'ffffffffffffffffffffffff'; await store.write('mock-server.json', server, mockBoardSchema);
    const c = { ...config, dryRun: false };
    await expect(syncTrello(c, store, new TrelloClient(c, send, wait))).rejects.toThrow('another board');
    expect((await store.read('mock-server.json', mockBoardSchema)).writeAttempts).toBe(0);
  });
  it('holds uncertain matches and archived matches for review', async () => {
    const { config, store, send, wait } = await analyzed(); const tasks = await store.tasks();
    const pending = tasks.tasks.find(t => t.id === pendingTaskId)!; pending.possibleExistingCardIds = [existingCardId];
    const server = await store.read('mock-server.json', mockBoardSchema); server.cards[0]!.closed = true;
    await store.write('tasks.json', tasks, tasksSchema); await store.write('mock-server.json', server, mockBoardSchema);
    const c = { ...config, dryRun: false }, report = await syncTrello(c, store, new TrelloClient(c, send, wait));
    expect(report.outcomes.find(o => o.taskId === pendingTaskId)!.operation).toBe('review');
    expect(report.outcomes.find(o => o.taskId === previousTaskId)!.message).toContain('archived');
  });
  it('does not silently create a duplicate when a mapped card moves off-board', async () => {
    const { config, store, send, wait } = await analyzed(); const server = await store.read('mock-server.json', mockBoardSchema);
    server.cards = server.cards.filter(c => c.id !== previousCardId); await store.write('mock-server.json', server, mockBoardSchema);
    const c = { ...config, dryRun: false }, report = await syncTrello(c, store, new TrelloClient(c, send, wait));
    expect(report.outcomes.find(o => o.taskId === previousTaskId)).toMatchObject({ operation: 'review' });
  });
  it('recovers remote creation if the successful response or local mapping was lost', async () => {
    const { config, store, send, wait } = await analyzed();
    const tasks = await store.tasks(), task = tasks.tasks.find(t => t.id === pendingTaskId)!;
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    const server = await store.read('mock-server.json', mockBoardSchema);
    const id = '1234567890abcdef12345678', opId = createOperationId(task.id);
    server.cards.push({ id, idBoard: config.trello.boardId, idList: config.trello.listId, name: task.title, desc: `${taskMarker(task.id)}\n${operationMarker(opId)}\n${sourceMarker(task.id, task.sources[0]!.messageId)}`, closed: false, labels: [] });
    await store.write('mock-server.json', server, mockBoardSchema);
    const state = await store.state(); state.sync.operations[opId] = { id: opId, taskId: task.id, kind: 'create', cardId: null, sourceMessageIds: task.sources.map(s => s.messageId), status: 'uncertain', at: fixtureNow.toISOString() };
    await store.saveState(state);
    const c = { ...config, dryRun: false }, report = await syncTrello(c, store, new TrelloClient(c, send, wait));
    expect(report.outcomes[0]!.operation).toBe('noop');
    expect((await store.state()).sync.taskCards[task.id]!.cardId).toBe(id);
    expect((await store.state()).sync.operations[opId]!.status).toBe('succeeded');
    expect((await store.read('mock-server.json', mockBoardSchema)).writeAttempts).toBe(0);
  });
  it('records ambiguous writes and refuses a blind retry when no remote marker is visible', async () => {
    const { config, store, send, wait } = await analyzed(); const task = (await store.tasks()).tasks.find(t => t.id === pendingTaskId)!;
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    const transport: typeof fetch = vi.fn(async (input, init) => init?.method === 'POST' ? new Response('{}', { status: 503 }) : send(input, init));
    const c = { ...config, dryRun: false };
    const first = await syncTrello(c, store, new TrelloClient(c, transport, wait));
    expect(first.outcomes.at(-1)!.status).toBe('failed');
    expect((await store.state()).sync.operations[createOperationId(task.id)]!.status).toBe('uncertain');
    const retry = await syncTrello(c, store, new TrelloClient(c, send, wait));
    expect(retry.outcomes[0]!.operation).toBe('review'); expect((await store.read('mock-server.json', mockBoardSchema)).writeAttempts).toBe(0);
  });
  it('checks live card membership immediately before commenting', async () => {
    const { config, send, wait } = await setup(); const c = { ...config, dryRun: false };
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === `/1/cards/${existingCardId}`) return new Response(JSON.stringify({ id: existingCardId, idBoard: 'ffffffffffffffffffffffff', idList: c.trello.listId, name: 'Moved', desc: '', closed: false, labels: [] }));
      return send(input, init);
    };
    await expect(new TrelloClient(c, transport, wait).comment(existingCardId, 'new evidence')).rejects.toThrow('outside the configured board');
  });
  it('uses exact source overlap as a review signal, never weak title similarity as a merge', async () => {
    const { config, store, send, wait } = await analyzed();
    const task = fixtureTask(10, { title: 'Completely different wording', relatedExistingCardId: null });
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    const server = await store.read('mock-server.json', mockBoardSchema); server.cards[1]!.desc += '\n' + fixtureSource(10).permalink;
    await store.write('mock-server.json', server, mockBoardSchema);
    const c = { ...config, dryRun: false }, report = await syncTrello(c, store, new TrelloClient(c, send, wait));
    expect(report.outcomes[0]!.operation).toBe('review'); expect((await store.read('mock-server.json', mockBoardSchema)).writeAttempts).toBe(0);
  });
  it('recovers after a real create succeeds but the local post-write save fails', async () => {
    const { config, store, send, wait } = await analyzed(); const task = (await store.tasks()).tasks.find(t => t.id === pendingTaskId)!;
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    const c = { ...config, dryRun: false }, originalSave = store.saveState.bind(store);
    let failed = false;
    const save = vi.spyOn(store, 'saveState').mockImplementation(async state => {
      if (!failed && state.sync.taskCards[task.id]) { failed = true; throw new Error('Simulated disk error'); }
      return originalSave(state);
    });
    await syncTrello(c, store, new TrelloClient(c, send, wait)); save.mockRestore();
    const before = await store.read('mock-server.json', mockBoardSchema);
    await syncTrello(c, store, new TrelloClient(c, send, wait));
    const after = await store.read('mock-server.json', mockBoardSchema);
    expect(failed).toBe(true); expect(after.cards).toHaveLength(3); expect(after.writeAttempts).toBe(before.writeAttempts);
    expect((await store.tasks()).tasks[0]!.syncStatus).toBe('synced');
  });
  it('recovers a posted comment whose response was lost without repeating evidence', async () => {
    const { config, store, send, wait } = await analyzed(); const task = (await store.tasks()).tasks.find(t => t.id === previousTaskId)!;
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    const server = await store.read('mock-server.json', mockBoardSchema); server.rateLimitedOnce = true; await store.write('mock-server.json', server, mockBoardSchema);
    const c = { ...config, dryRun: false };
    const transport: typeof fetch = async (input, init) => {
      const response = await send(input, init);
      if (init?.method === 'POST') throw new Error('Response lost after Trello committed');
      return response;
    };
    await syncTrello(c, store, new TrelloClient(c, transport, wait));
    const report = await syncTrello(c, store, new TrelloClient(c, send, wait));
    expect(report.outcomes[0]!.operation).toBe('noop');
    expect((await store.read('mock-server.json', mockBoardSchema)).actions[previousCardId]).toHaveLength(1);
    expect((await store.tasks()).tasks[0]!.syncStatus).toBe('synced');
  });
});
