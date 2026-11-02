import { z } from 'zod';
import { taskId } from '../schemas/common.js';
import { forumExportSchema } from './forum-export.js';
import { importSelectedForumPost, type ForumImportSettings } from './forum-import-first.js';
import { Storage } from './storage.js';

export const selectedForumTagsSchema = z.strictObject({
  version: z.literal(1),
  posts: z.array(z.strictObject({
    id: taskId,
    tag: z.enum(['Bug', 'Suggestion', 'Balance', 'Other feedback']),
  })),
});

export async function importSelectedForumPosts(
  store: Storage,
  settings: ForumImportSettings,
  send: typeof fetch = fetch,
  onProgress: (result: { index: number; total: number; postId: string; tag: string; url: string; createdNow: boolean }) => void = () => {},
) {
  const selected = await store.read('feedback-posts-selected.json', forumExportSchema);
  const tags = await store.read('feedback-post-tags-selected.json', selectedForumTagsSchema);
  const importable = selected.posts.filter(post => !post.draft);
  if (importable.length === 0 || tags.posts.length !== importable.length) throw new Error('Category tag mapping must include every importable selected post');
  const ids = new Set<string>();
  selected.posts.forEach((post, index) => {
    if (ids.has(post.id)) throw new Error(`Duplicate selected post ID at ${index + 1}`);
    ids.add(post.id);
    if (post.content !== `${post.description}\n\n-- submitted by @${post.submittedBy.username}`) throw new Error(`Attribution footer does not match selected post ${index + 1}`);
  });
  importable.forEach((post, index) => {
    if (tags.posts[index]?.id !== post.id) throw new Error(`Category tag mapping does not match importable post ${index + 1}`);
  });
  if (tags.posts[0]?.tag !== 'Suggestion') throw new Error('The first published post must retain the Suggestion tag');

  // Check every source post, current forum tag, and existing journal before any write.
  for (const item of tags.posts) {
    await importSelectedForumPost(store, { ...settings, apply: false, dryRun: true }, { postId: item.id, tag: item.tag }, send);
  }
  const counts = Object.fromEntries(['Bug', 'Suggestion', 'Balance', 'Other feedback'].map(tag => [tag, tags.posts.slice(1).filter(item => item.tag === tag).length]));
  if (!settings.apply || settings.dryRun) return { status: 'planned', remaining: tags.posts.length - 1, tags: counts };

  let created = 0;
  let alreadyVerified = 0;
  for (let index = 1; index < tags.posts.length; index++) {
    const item = tags.posts[index]!;
    const result = await importSelectedForumPost(store, settings, { postId: item.id, tag: item.tag }, send);
    if (result.status !== 'verified') throw new Error(`Post ${index + 1} was not verified`);
    if (result.createdNow) created++; else alreadyVerified++;
    onProgress({ index: index + 1, total: tags.posts.length, postId: item.id, tag: item.tag, url: result.url, createdNow: result.createdNow });
  }
  return { status: 'verified', total: tags.posts.length, firstAlreadyVerified: true, created, alreadyVerified, tags: counts };
}
