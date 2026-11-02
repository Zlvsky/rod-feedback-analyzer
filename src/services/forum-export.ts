import { z } from 'zod';
import type { Config } from '../config/index.js';
import { discordUrl, snowflake, taskId, text, utc } from '../schemas/common.js';
import { compareIds } from './deduplication.js';
import { Storage } from './storage.js';
import { validateTasks } from './validation.js';

const plainText = (max: number) => text(max).refine(value => !/[`*]|!?\[[^\]]*\]\(|^\s*(?:#{1,6}\s|[-+>]\s|\d+\.\s)/m.test(value), 'Use plain text without Markdown');
export const forumExportSchema = z.strictObject({
  version: z.literal(1), generatedAt: utc, sourceChannelId: snowflake,
  posts: z.array(z.strictObject({
    id: taskId, title: plainText(100).refine(value => !/[\r\n]/.test(value), 'Title must be one line'),
    description: plainText(1800), content: text(2000),
    submittedBy: z.strictObject({ id: snowflake.nullable(), username: text(100) }),
    sourceMessageIds: z.array(snowflake), sourceUrls: z.array(discordUrl),
    draft: z.literal(true).optional(), sourceNote: text(500).optional(),
    suggestedTags: z.array(z.enum(['Bug', 'Suggestion', 'Balance', 'Other feedback', 'Planned', 'In Progress', 'Done', 'Not planned'])).min(1).optional(),
  }).superRefine((post, ctx) => {
    if (post.draft) {
      if (!post.sourceNote) ctx.addIssue({ code: 'custom', message: 'Draft without Discord sources needs a source note' });
    } else if (!post.submittedBy.id || post.sourceMessageIds.length === 0 || post.sourceUrls.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Importable post needs submitter ID and Discord sources' });
    }
    if (post.sourceMessageIds.length !== post.sourceUrls.length) ctx.addIssue({ code: 'custom', message: 'Source IDs and URLs must align' });
  })),
  reviewItems: z.array(z.strictObject({ id: taskId, title: text(160), description: text(4000), reason: text(500),
    sourceMessageIds: z.array(snowflake).min(1), sourceUrls: z.array(discordUrl).min(1) })),
});

// Codex groups and condenses conversations in analysis.json; this stage only
// validates accepted tasks, adds attribution, and packages the local export.
export async function exportForumPosts(config: Config, store: Storage, now = new Date()) {
  const [messages, savedTasks, state] = await Promise.all([store.messages(), store.tasks(), store.state()]);
  const tasks = validateTasks(savedTasks, messages.messages, config).tasks;
  const processed = new Set([...state.analysis.analyzedMessageIds, ...Object.keys(state.analysis.ignoredMessages)]);
  if (messages.messages.some(message => !message.contextOnly && !processed.has(message.id))) throw new Error('Analyze all collected conversations before exporting');
  if (state.errors.some(error => error.stage === 'collect' || error.stage.startsWith('collect:'))) throw new Error('Resolve collection failures before exporting');
  const byId = new Map(messages.messages.map(message => [message.id, message]));
  const posts = [], reviewItems = [];
  for (const task of tasks) {
    const sources = task.sources.map(source => byId.get(source.messageId)!).sort((a, b) => compareIds(a.id, b.id));
    // General-chat tasks are outside this feedback-channel migration.
    if (!sources.some(source => source.channelId === config.discord.channelIds[0])) continue;
    if (task.needsClarification || task.confidence < 0.7) {
      reviewItems.push({ id: task.id, title: task.title, description: task.description,
        reason: 'The discussion needs clarification or has insufficient confidence for an importable post.',
        sourceMessageIds: sources.map(source => source.id), sourceUrls: sources.map(source => source.permalink) });
      continue;
    }
    const submitter = sources[0]!;
    if (!submitter.authorUsername.trim() || /[\r\n]/.test(submitter.authorUsername)) throw new Error(`Invalid submitter username for ${task.id}`);
    posts.push({
      id: task.id, title: task.title, description: task.description,
      content: `${task.description}\n\n-- submitted by @${submitter.authorUsername}`,
      submittedBy: { id: submitter.authorId, username: submitter.authorUsername },
      sourceMessageIds: sources.map(source => source.id), sourceUrls: sources.map(source => source.permalink),
    });
  }
  const output = forumExportSchema.parse({ version: 1, generatedAt: now.toISOString(), sourceChannelId: config.discord.channelIds[0], posts, reviewItems });
  await store.write('feedback-posts.json', output, forumExportSchema);
  return { file: store.path('feedback-posts.json'), posts: posts.length, reviewItems: reviewItems.length, remoteWrites: 0 };
}
