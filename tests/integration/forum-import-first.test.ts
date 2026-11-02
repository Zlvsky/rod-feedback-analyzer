import { describe, expect, it, vi } from 'vitest';
import { importFirstForumPost, type ForumImportSettings } from '../../src/services/forum-import-first.js';
import { forumExportSchema } from '../../src/services/forum-export.js';
import { setup } from '../helpers.js';
import { MOCK_IDS } from '../../src/config/index.js';

const forumId = '100000000000000004';
const tagId = '100000000000000005';
const botId = '100000000000000006';
const threadId = '100000000000000007';
const originalMessageId = '100000000000000008';
const postId = 'rod-100000000000000008-first-forum-post';
const content = 'Show character stat changes after changing equipment.\n\n-- submitted by @reporter';
const title = 'Show equipment and resulting stats together';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function fixture() {
  const { store } = await setup(false);
  const post = {
    id: postId, title, description: 'Show character stat changes after changing equipment.', content,
    submittedBy: { id: '100000000000000009', username: 'reporter' },
    sourceMessageIds: [originalMessageId],
    sourceUrls: [`https://discord.com/channels/${MOCK_IDS.guild}/${MOCK_IDS.feedback}/${originalMessageId}`],
  };
  await store.write('feedback-posts-selected.json', { version: 1, generatedAt: '2026-11-02T00:00:00.000Z', sourceChannelId: MOCK_IDS.feedback, posts: [post, { ...post, id: 'rod-100000000000000010-second-forum-post' }], reviewItems: [] }, forumExportSchema);
  const settings: ForumImportSettings = { token: 'mock-discord', guildId: MOCK_IDS.guild, feedbackChannelId: MOCK_IDS.feedback, forumId, dryRun: true, apply: false, timeoutMs: 1000 };
  const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/api/v10/channels/${forumId}`) return response({ id: forumId, guild_id: MOCK_IDS.guild, type: 15, available_tags: [{ id: tagId, name: 'Suggestion', moderated: false }] });
    if (path === `/api/v10/channels/${forumId}/threads` && init?.method === 'POST') return response({ id: threadId });
    if (path === `/api/v10/channels/${threadId}`) return response({ id: threadId, guild_id: MOCK_IDS.guild, parent_id: forumId, type: 11, name: title, applied_tags: [tagId], owner_id: botId });
    if (path === '/api/v10/users/@me') return response({ id: botId });
    if (path === `/api/v10/channels/${threadId}/messages/${threadId}`) return response({ id: threadId, channel_id: threadId, content, author: { id: botId } });
    throw Error(`Unexpected mock Discord route ${path}`);
  });
  return { store, settings, send };
}

describe('one-post forum import', () => {
  it('plans the first exact post without writing, then creates it once with the Suggestion tag', async () => {
    const { store, settings, send } = await fixture();
    const plan = await importFirstForumPost(store, settings, send);
    expect(plan).toMatchObject({ status: 'planned', title, content, tag: 'Suggestion' });
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    const created = await importFirstForumPost(store, { ...settings, apply: true, dryRun: false }, send);
    expect(created).toMatchObject({ status: 'verified', createdNow: true, url: `https://discord.com/channels/${MOCK_IDS.guild}/${threadId}` });
    const postCall = send.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall![1]!.body))).toEqual({ name: title, message: { content, allowed_mentions: { parse: [] }, flags: 4096 }, applied_tags: [tagId] });
    expect(await importFirstForumPost(store, { ...settings, apply: true, dryRun: false }, send)).toMatchObject({ status: 'verified', createdNow: false });
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('holds an uncertain write in the journal instead of retrying it', async () => {
    const { store, settings, send } = await fixture();
    send.mockImplementationOnce(async () => response({ id: forumId, guild_id: MOCK_IDS.guild, type: 15, available_tags: [{ id: tagId, name: 'Suggestion' }] }));
    send.mockImplementationOnce(async () => { throw new Error('network interrupted'); });
    await expect(importFirstForumPost(store, { ...settings, apply: true, dryRun: false }, send)).rejects.toThrow('network interrupted');
    await expect(importFirstForumPost(store, { ...settings, apply: true, dryRun: false }, send)).rejects.toThrow('outcome is unknown');
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('rejects a wrong guild or non-forum destination before any write', async () => {
    const { store, settings, send } = await fixture();
    send.mockImplementationOnce(async () => response({ id: forumId, guild_id: '100000000000000099', type: 15, available_tags: [{ id: tagId, name: 'Suggestion' }] }));
    await expect(importFirstForumPost(store, { ...settings, apply: true, dryRun: false }, send)).rejects.toThrow('outside the configured guild');
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
});
