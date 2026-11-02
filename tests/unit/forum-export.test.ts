import { describe, expect, it } from 'vitest';
import { exportForumPosts, forumExportSchema } from '../../src/services/forum-export.js';
import { normalizeMessage } from '../../src/discord/collector.js';
import { messagesSchema } from '../../src/schemas/messages.js';
import { tasksSchema, type Task } from '../../src/schemas/tasks.js';
import { conversation, fixtureNow } from '../fixtures/conversations.js';
import { setup } from '../helpers.js';

async function prepared() {
  const context = await setup(false);
  const older = normalizeMessage({ ...conversation[4]!, author: { id: '100000000000000010', username: 'reporter_name', global_name: 'Different Display Name' } }, context.config.discord.guildId, 'feedback');
  const newer = { ...older, id: (BigInt(older.id) + 1n).toString(), authorId: '100000000000000011', authorUsername: 'another_player', authorDisplayName: 'Another Player', content: 'The discussion confirms the same problem.' };
  newer.permalink = `https://discord.com/channels/${newer.guildId}/${newer.channelId}/${newer.id}`;
  await context.store.write('messages.json', { version: 1, messages: [older, newer] }, messagesSchema);
  const task: Task = { id: `rod-${older.id}-test-conversation`, title: 'Improve the equipment comparison', description: 'Show the resulting character stats before equipping an item.', suggestedAction: 'Improve the comparison.',
    type: 'improvement', impact: 'minor', confidence: 0.95, needsClarification: false,
    sources: [newer, older].map(m => ({ messageId: m.id, nickname: m.authorDisplayName, channel: m.channelName, timestamp: m.timestamp, permalink: m.permalink, excerpt: m.content })),
    relatedExistingCardId: null, possibleExistingCardIds: [], syncStatus: 'pending' };
  await context.store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
  const state = await context.store.state(); state.analysis.analyzedMessageIds = [older.id, newer.id]; await context.store.saveState(state);
  return { ...context, task, older, newer };
}

describe('local forum export', () => {
  it('packages a multi-author conversation with chronological provenance and the original username footer', async () => {
    const { config, store, older, newer } = await prepared();
    expect(await exportForumPosts(config, store, fixtureNow)).toMatchObject({ posts: 1, reviewItems: 0, remoteWrites: 0 });
    const output = await store.read('feedback-posts.json', forumExportSchema);
    expect(output.posts[0]!.submittedBy).toEqual({ id: older.authorId, username: 'reporter_name' });
    expect(output.posts[0]!.sourceMessageIds).toEqual([older.id, newer.id]);
    expect(output.posts[0]!.content).toBe('Show the resulting character stats before equipping an item.\n\n-- submitted by @reporter_name');
    expect((await store.state()).sync.operations).toEqual({});
  });
  it('holds vague feedback with source links and refuses to export an unreviewed queue', async () => {
    const { config, store, task, older } = await prepared();
    task.needsClarification = true;
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    await exportForumPosts(config, store, fixtureNow);
    const output = await store.read('feedback-posts.json', forumExportSchema);
    expect(output.posts).toEqual([]); expect(output.reviewItems[0]!.sourceMessageIds).toContain(older.id);
    const state = await store.state(); state.analysis.analyzedMessageIds = [older.id]; await store.saveState(state);
    await expect(exportForumPosts(config, store)).rejects.toThrow('Analyze all collected');
  });
  it('rejects forged sources and formatting that cannot be used as a plain-text post', async () => {
    const { config, store, task } = await prepared();
    task.sources[0]!.nickname = 'Forged author';
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    await expect(exportForumPosts(config, store)).rejects.toThrow('metadata does not match');
    task.sources[0]!.nickname = 'Another Player'; task.description = '**Markdown description**';
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    await expect(exportForumPosts(config, store)).rejects.toThrow('plain text');
    task.description = 'x'.repeat(1801);
    await store.write('tasks.json', { version: 1, tasks: [task] }, tasksSchema);
    await expect(exportForumPosts(config, store)).rejects.toThrow();
  });
});
