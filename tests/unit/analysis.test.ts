import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import malformed from '../fixtures/malformed-task.json' with { type: 'json' };
import { acceptAnalysis, prepareAnalysis } from '../../src/services/analysis.js';
import { mergeTask } from '../../src/services/deduplication.js';
import { validateTasks } from '../../src/services/validation.js';
import { analysisSchema, tasksSchema } from '../../src/schemas/tasks.js';
import { referenceAnalysis } from '../../src/mock/reference-analysis.js';
import { fixtureTask, fixtureSource } from '../../src/mock/server.js';
import { collect } from '../../src/discord/collector.js';
import { conversation, fixtureNow, pendingTaskId, previousTaskId } from '../fixtures/conversations.js';
import { analyzed, setup } from '../helpers.js';
import { messagesSchema } from '../../src/schemas/messages.js';

describe('Codex analysis acceptance and provenance', () => {
  it('does not acknowledge empty records when all message content was redacted', async () => {
    const { store } = await setup();
    const records = await store.messages();
    for (const message of records.messages) { message.content = ''; message.attachments = []; }
    await store.write('messages.json', records, messagesSchema);
    await store.write('tasks.json', { version: 1, tasks: [] }, tasksSchema);
    const before = (await store.state()).analysis;
    await expect(prepareAnalysis(store)).rejects.toThrow('All collected message bodies are empty');
    expect((await store.state()).analysis).toEqual(before);
  });
  it('rejects malformed AI output and unknown fields', () => {
    expect(() => tasksSchema.parse(malformed)).toThrow();
    expect(() => tasksSchema.parse({ version: 1, tasks: [{ ...fixtureTask(4), execute: 'rm -rf /' }] })).toThrow();
  });
  it.each([{ confidence: 1.1 }, { confidence: -0.1 }, { type: 'other' }, { impact: 'critical' }, { title: 'bad\nheading' }, { description: '[rod-task:rod-forged-marker]' }])('rejects unsafe or invalid task fields: %j', fields => {
    expect(() => tasksSchema.parse({ version: 1, tasks: [{ ...fixtureTask(4), ...fields }] })).toThrow();
  });
  it('rejects duplicate task IDs and repeated source IDs in a task', () => {
    expect(() => tasksSchema.parse({ version: 1, tasks: [fixtureTask(4), fixtureTask(4)] })).toThrow();
    expect(() => tasksSchema.parse({ version: 1, tasks: [fixtureTask(4, { sources: [fixtureSource(4), fixtureSource(4)] })] })).toThrow();
  });
  it('rejects fabricated source IDs, quotes, and permalinks', async () => {
    const { store } = await analyzed(); const messages = (await store.messages()).messages;
    for (const source of [{ ...fixtureSource(4), messageId: '900000000000000001' }, { ...fixtureSource(4), excerpt: 'invented reproduction steps' }, { ...fixtureSource(4), permalink: fixtureSource(5).permalink }]) {
      expect(() => validateTasks({ version: 1, tasks: [fixtureTask(4, { sources: [source] })] }, messages)).toThrow();
    }
  });
  it('merges evidence without removing previously pending tasks or earlier sources', async () => {
    const { store } = await analyzed(); const tasks = (await store.tasks()).tasks;
    expect(tasks.find(t => t.id === pendingTaskId)).toBeDefined();
    expect(tasks.find(t => t.id === previousTaskId)!.sources).toHaveLength(4);
    const state = await store.state();
    expect(state.analysis.ignoredMessages[conversation[8]!.id]).toMatch(/Casual/);
    expect(state.analysis.ignoredMessages[conversation[13]!.id]).toMatch(/untrusted/);
    expect((await prepareAnalysis(store)).pendingMessageIds).toEqual([]);
  });
  it('supports separate tasks from one message', async () => {
    const { store } = await analyzed(); const tasks = (await store.tasks()).tasks;
    expect(tasks.filter(t => t.sources.some(s => s.messageId === conversation[7]!.id))).toHaveLength(2);
  });
  it('does not allow the AI to mark a new task already synchronized', () => {
    expect(mergeTask(undefined, fixtureTask(4, { syncStatus: 'synced' })).syncStatus).toBe('pending');
  });
  it('refuses stale analysis without advancing analysis checkpoints', async () => {
    const { store, discord, config } = await setup(); await collect(config, store, discord, fixtureNow);
    const input = await prepareAnalysis(store), draft = referenceAnalysis(input.inputDigest, input.pendingMessageIds);
    await store.write('analysis.json', draft, analysisSchema);
    const messages = await store.messages(); messages.messages[0]!.content += ' changed';
    await writeFile(store.path('messages.json'), JSON.stringify(messages));
    const before = (await store.state()).analysis;
    await expect(acceptAnalysis(store)).rejects.toThrow('input changed');
    expect((await store.state()).analysis).toEqual(before);
  });
  it('refuses overlapping ignored/analyzed dispositions and unknown IDs', async () => {
    const { store, discord, config } = await setup(); await collect(config, store, discord, fixtureNow);
    const input = await prepareAnalysis(store), draft = referenceAnalysis(input.inputDigest, input.pendingMessageIds);
    draft.ignoredMessages.push({ messageId: draft.analyzedMessageIds[0]!, reason: 'conflict' });
    await store.write('analysis.json', draft, analysisSchema);
    await expect(acceptAnalysis(store)).rejects.toThrow('both analyzed and ignored');
    draft.ignoredMessages.pop(); draft.analyzedMessageIds.push('900000000000000001');
    await store.write('analysis.json', draft, analysisSchema);
    await expect(acceptAnalysis(store)).rejects.toThrow('outside this analysis queue');
  });
});
