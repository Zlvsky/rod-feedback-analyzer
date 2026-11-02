import { describe, expect, it, vi } from 'vitest';
import { MOCK_IDS } from '../../src/config/index.js';
import { forumExportSchema } from '../../src/services/forum-export.js';
import { importFirstForumPost, type ForumImportSettings } from '../../src/services/forum-import-first.js';
import { importSelectedForumPosts, selectedForumTagsSchema } from '../../src/services/forum-import-selected.js';
import { setup } from '../helpers.js';

const forumId = '100000000000000004';
const botId = '100000000000000006';
const firstId = '100000000000000007';
const secondId = '100000000000000008';
const suggestionTagId = '100000000000000009';
const bugTagId = '100000000000000010';
const posts = [
  { id: 'rod-100000000000000011-first-feedback-post', title: 'First suggestion', description: 'Improve the menu.', content: 'Improve the menu.\n\n-- submitted by @one', submittedBy: { id: '100000000000000011', username: 'one' }, sourceMessageIds: ['100000000000000011'], sourceUrls: [`https://discord.com/channels/${MOCK_IDS.guild}/${MOCK_IDS.feedback}/100000000000000011`] },
  { id: 'rod-100000000000000012-second-feedback-post', title: 'Fix a broken menu', description: 'The menu does not open.', content: 'The menu does not open.\n\n-- submitted by @two', submittedBy: { id: '100000000000000012', username: 'two' }, sourceMessageIds: ['100000000000000012'], sourceUrls: [`https://discord.com/channels/${MOCK_IDS.guild}/${MOCK_IDS.feedback}/100000000000000012`] },
];
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function fixture() {
  const { store } = await setup(false);
  await store.write('feedback-posts-selected.json', { version: 1, generatedAt: '2026-11-02T00:00:00.000Z', sourceChannelId: MOCK_IDS.feedback, posts, reviewItems: [] }, forumExportSchema);
  await store.write('feedback-post-tags-selected.json', { version: 1, posts: [{ id: posts[0]!.id, tag: 'Suggestion' }, { id: posts[1]!.id, tag: 'Bug' }] }, selectedForumTagsSchema);
  const settings: ForumImportSettings = { token: 'mock-discord', guildId: MOCK_IDS.guild, feedbackChannelId: MOCK_IDS.feedback, forumId, dryRun: false, apply: true, timeoutMs: 1000 };
  const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `/api/v10/channels/${forumId}`) return response({ id: forumId, guild_id: MOCK_IDS.guild, type: 15, available_tags: [{ id: suggestionTagId, name: 'Suggestion' }, { id: bugTagId, name: 'Bug' }] });
    if (path === `/api/v10/channels/${forumId}/threads` && init?.method === 'POST') return response({ id: JSON.parse(String(init.body)).name === posts[0]!.title ? firstId : secondId });
    for (const [threadId, post, tagId] of [[firstId, posts[0]!, suggestionTagId], [secondId, posts[1]!, bugTagId]] as const) {
      if (path === `/api/v10/channels/${threadId}`) return response({ id: threadId, guild_id: MOCK_IDS.guild, parent_id: forumId, type: 11, name: post.title, applied_tags: [tagId], owner_id: botId });
      if (path === `/api/v10/channels/${threadId}/messages/${threadId}`) return response({ id: threadId, channel_id: threadId, content: post.content, author: { id: botId } });
    }
    if (path === '/api/v10/users/@me') return response({ id: botId });
    throw Error(`Unexpected mock Discord route ${path}`);
  });
  return { store, settings, send };
}

describe('selected forum batch import', () => {
  it('uses the first-post journal and creates only the remaining post with its category', async () => {
    const { store, settings, send } = await fixture();
    await importFirstForumPost(store, settings, send);
    const plan = await importSelectedForumPosts(store, { ...settings, apply: false }, send);
    expect(plan).toMatchObject({ status: 'planned', remaining: 1, tags: { Bug: 1 } });
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    const result = await importSelectedForumPosts(store, settings, send);
    expect(result).toMatchObject({ status: 'verified', created: 1, alreadyVerified: 0 });
    const writes = send.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[1]![1]!.body))).toEqual({ name: posts[1]!.title, message: { content: posts[1]!.content, allowed_mentions: { parse: [] }, flags: 4096 }, applied_tags: [bugTagId] });
    expect(await importSelectedForumPosts(store, settings, send)).toMatchObject({ created: 0, alreadyVerified: 1 });
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  });

  it('rejects an incomplete tag map before any Discord request', async () => {
    const { store, settings, send } = await fixture();
    await store.write('feedback-post-tags-selected.json', { version: 1, posts: [{ id: posts[0]!.id, tag: 'Suggestion' }] }, selectedForumTagsSchema);
    await expect(importSelectedForumPosts(store, settings, send)).rejects.toThrow('must include every importable selected post');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a source-less draft in the selected file without publishing it', async () => {
    const { store, settings, send } = await fixture();
    await importFirstForumPost(store, settings, send);
    const selected = await store.read('feedback-posts-selected.json', forumExportSchema);
    selected.posts.push({
      id: 'rod-draft-mythic-class-sets', title: 'Add mythic class item sets',
      description: 'Add class sets with special bonuses.',
      content: 'Add class sets with special bonuses.\n\n-- submitted by @player',
      submittedBy: { id: null, username: 'player' }, sourceMessageIds: [], sourceUrls: [],
      draft: true, sourceNote: 'Conversation excerpt supplied by the user; Discord message IDs were not provided.',
    });
    await store.write('feedback-posts-selected.json', selected, forumExportSchema);
    expect(await importSelectedForumPosts(store, settings, send)).toMatchObject({ status: 'verified', total: 2, created: 1 });
    expect(send.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  });
});
