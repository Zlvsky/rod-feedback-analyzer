import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { snowflake, taskId, utc } from '../schemas/common.js';
import { forumExportSchema } from './forum-export.js';
import { Storage } from './storage.js';

const journalSchema = z.strictObject({
  version: z.literal(1), forumId: snowflake, postId: taskId, tagId: snowflake,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['intent', 'rejected', 'created', 'verified']),
  threadId: snowflake.nullable(), updatedAt: utc,
});
const forumSchema = z.object({
  id: snowflake, guild_id: snowflake, type: z.literal(15),
  available_tags: z.array(z.object({ id: snowflake, name: z.string(), moderated: z.boolean().optional() })),
});
const threadSchema = z.object({
  id: snowflake, guild_id: snowflake, parent_id: snowflake, type: z.literal(11),
  name: z.string(), applied_tags: z.array(snowflake), owner_id: snowflake,
});
const messageSchema = z.object({ id: snowflake, channel_id: snowflake, content: z.string(), author: z.object({ id: snowflake }) });
type Journal = z.infer<typeof journalSchema>;
export interface ForumImportSettings {
  token: string; guildId: string; feedbackChannelId: string; forumId: string;
  dryRun: boolean; apply: boolean; timeoutMs: number;
}
export type ForumImportResult =
  | { status: 'planned'; postId: string; title: string; content: string; tag: string; forumId: string }
  | { status: 'verified'; postId: string; title: string; tag: string; url: string; createdNow: boolean };

export async function importSelectedForumPost(store: Storage, settings: ForumImportSettings, selection: { postId: string; tag: string } | null, send: typeof fetch = fetch): Promise<ForumImportResult> {
  const forumId = snowflake.parse(settings.forumId);
  const guildId = snowflake.parse(settings.guildId);
  if (forumId === settings.feedbackChannelId) throw new Error('Forum destination must differ from the legacy feedback channel');
  if (!settings.token) throw new Error('DISCORD_BOT_TOKEN is missing');
  const selected = await store.read('feedback-posts-selected.json', forumExportSchema);
  if (selected.sourceChannelId !== settings.feedbackChannelId) throw new Error('Selected posts belong to another legacy feedback channel');
  const post = selection ? selected.posts.find(candidate => candidate.id === taskId.parse(selection.postId)) : selected.posts[0];
  if (!post) throw new Error('Selected feedback post was not found');
  if (post.draft) throw new Error('Draft feedback post is not approved for Discord import');
  if (post.content !== `${post.description}\n\n-- submitted by @${post.submittedBy.username}`) throw new Error('Post attribution footer does not match the selected content');
  const tagName = selection?.tag ?? 'Suggestion';
  if (!['Bug', 'Suggestion', 'Balance', 'Other feedback'].includes(tagName)) throw new Error('Unsupported forum category tag');
  const headers = { Authorization: `Bot ${settings.token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/rod-discord-feedback, 1.0.0)' };
  const request = async (path: string, init: RequestInit = {}) => send(`https://discord.com/api/v10${path}`, {
    ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(settings.timeoutMs),
  });
  const get = async (path: string): Promise<unknown> => {
    for (let attempt = 0; attempt <= 10; attempt++) {
      const response = await request(path);
      if (response.status === 429 && attempt < 10) {
        const retry = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Discord read returned HTTP ${response.status}`); }
      return response.json();
    }
    throw new Error('Discord read remained rate limited');
  };
  const forum = forumSchema.parse(await get(`/channels/${forumId}`));
  if (forum.id !== forumId || forum.guild_id !== guildId) throw new Error('Configured forum is outside the configured guild');
  const tags = forum.available_tags.filter(tag => tag.name === tagName);
  if (tags.length !== 1) throw new Error(`The forum must have exactly one tag named ${tagName}`);
  const tagId = tags[0]!.id;
  const payload = { name: post.title, message: { content: post.content, allowed_mentions: { parse: [] }, flags: 4096 }, applied_tags: [tagId] };
  const payloadHash = createHash('sha256').update(JSON.stringify({ forumId, postId: post.id, payload })).digest('hex');
  const journalName = post.id === selected.posts[0]?.id ? 'forum-first-post.json' : `forum-post-${post.id}.json`;
  let journal = await store.read(journalName, journalSchema.nullable(), () => null);
  if (journal && (journal.forumId !== forumId || journal.postId !== post.id || journal.tagId !== tagId || journal.payloadHash !== payloadHash)) {
    throw new Error('Existing forum import journal belongs to another post or payload');
  }
  const url = (threadId: string) => `https://discord.com/channels/${guildId}/${threadId}`;
  const verify = async (threadId: string) => {
    const thread = threadSchema.parse(await get(`/channels/${threadId}`));
    if (thread.id !== threadId || thread.guild_id !== guildId || thread.parent_id !== forumId || thread.name !== post.title || !thread.applied_tags.includes(tagId)) {
      throw new Error('Created forum thread does not match the selected post');
    }
    const self = z.object({ id: snowflake }).parse(await get('/users/@me'));
    if (thread.owner_id !== self.id) throw new Error('Created forum thread is not owned by the configured bot');
    const message = messageSchema.parse(await get(`/channels/${threadId}/messages/${threadId}`));
    if (message.id !== threadId || message.channel_id !== threadId || message.author.id !== self.id || message.content !== post.content) {
      throw new Error('Created forum opening message does not match the selected content');
    }
  };
  if (journal?.status === 'created' || journal?.status === 'verified') {
    const threadId = journal.threadId!;
    await verify(threadId);
    if (journal.status !== 'verified') await store.write(journalName, { ...journal, status: 'verified', updatedAt: new Date().toISOString() }, journalSchema);
    return { status: 'verified', postId: post.id, title: post.title, tag: tagName, url: url(threadId), createdNow: false };
  }
  if (journal?.status === 'intent') throw new Error('Previous forum post outcome is unknown; inspect the forum before any retry. The journal prevents a duplicate.');
  if (!settings.apply || settings.dryRun) return { status: 'planned', postId: post.id, title: post.title, content: post.content, tag: tagName, forumId };

  const next = (status: Journal['status'], threadId: string | null): Journal => ({
    version: 1, forumId, postId: post.id, tagId, payloadHash, status, threadId, updatedAt: new Date().toISOString(),
  });
  journal = next('intent', null);
  await store.write(journalName, journal, journalSchema);
  for (let attempt = 0; attempt <= 4; attempt++) {
    const response = await request(`/channels/${forumId}/threads`, { method: 'POST', body: JSON.stringify(payload) });
    if (response.status === 429 && attempt < 4) {
      const retry = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : Math.min(30000, 500 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status < 500) await store.write(journalName, next('rejected', null), journalSchema);
      throw new Error(response.status >= 500 ? 'Discord post outcome is unknown; inspect the forum before retrying.' : `Discord post returned HTTP ${response.status}`);
    }
    const created = z.object({ id: snowflake }).parse(await response.json());
    await store.write(journalName, next('created', created.id), journalSchema);
    await verify(created.id);
    await store.write(journalName, next('verified', created.id), journalSchema);
    return { status: 'verified', postId: post.id, title: post.title, tag: tagName, url: url(created.id), createdNow: true };
  }
  throw new Error('Discord post was rejected by rate limiting');
}

export async function importFirstForumPost(store: Storage, settings: ForumImportSettings, send: typeof fetch = fetch) {
  return importSelectedForumPost(store, settings, null, send);
}
