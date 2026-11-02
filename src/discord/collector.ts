import type { Config } from '../config/index.js';
import { bindScope } from '../config/index.js';
import { messagesSchema, type Message } from '../schemas/messages.js';
import type { State } from '../schemas/state.js';
import { compareIds, mergeMessages, snowflakeAt, snowflakeTime } from '../services/deduplication.js';
import { Storage } from '../services/storage.js';
import { DiscordClient, rawMessageSchema, type RawMessage, MissingMessageContentIntentError } from './client.js';

const human = (m: RawMessage) => !m.author.bot && !m.webhook_id;
export function normalizeMessage(m: RawMessage, guildId: string, channelName: string, contextOnly = false): Message {
  return {
    id: m.id, guildId, channelId: m.channel_id, channelName, authorId: m.author.id,
    authorUsername: m.author.username, authorDisplayName: m.member?.nick ?? m.author.global_name ?? m.author.username,
    timestamp: new Date(m.timestamp).toISOString(), editedTimestamp: m.edited_timestamp ? new Date(m.edited_timestamp).toISOString() : null,
    content: m.content, permalink: `https://discord.com/channels/${guildId}/${m.channel_id}/${m.id}`,
    referencedMessageId: m.message_reference?.message_id ?? null, replyContext: null, contextMessageIds: [], contextOnly,
    attachments: m.attachments.map(a => ({ id: a.id, filename: a.filename, size: a.size, url: a.url, contentType: a.content_type ?? null })),
  };
}
export async function collect(config: Config, store: Storage, client: DiscordClient, now = new Date(), options: { fullHistory?: boolean; feedbackOnly?: boolean } = {}) {
  const state = await store.state(); bindScope(state, config, 'discord');
  let messages = (await store.messages()).messages;
  try {
    await client.assertMessageContentAccess();
    clearStageErrors(state, 'collect:message-content');
  } catch (error) {
    if (error instanceof MissingMessageContentIntentError) {
      clearStageErrors(state, 'collect:message-content');
      state.errors.push({ id: 'collect:message-content', stage: 'collect:message-content', taskId: null, at: now.toISOString(), message: error.message });
      await store.saveState(state);
    }
    throw error;
  }
  const processed = new Set([...state.analysis.analyzedMessageIds, ...Object.keys(state.analysis.ignoredMessages)]);
  // Re-fetch unresolved empty records from older versions that collected without
  // Message Content Intent. Never replace an original quote or analyzed evidence.
  const recoverEmptyIds = new Set(messages.filter(m => !processed.has(m.id) && m.content === '' && !m.attachments.length).map(m => m.id));
  let added = 0;
  const failures: string[] = [];
  for (const channelId of options.feedbackOnly ? [config.discord.channelIds[0]] : config.discord.channelIds) {
    const checkpointBefore = state.collection.channels[channelId];
    try {
      const channel = await client.channel(channelId);
      const previous = state.collection.channels[channelId];
      const since = options.fullHistory ? '2015-01-01T00:00:00.000Z' : previous?.since ?? new Date(now.getTime() - config.lookbackDays * 86400000).toISOString();
      let lowerTime = previous?.lastMessageId && !options.fullHistory ? Math.max(Date.parse(since), snowflakeTime(previous.lastMessageId) - config.overlapMinutes * 60000) : Date.parse(since);
      const missing = messages.filter(m => m.channelId === channelId && !m.contextOnly && recoverEmptyIds.has(m.id));
      for (const message of missing) lowerTime = Math.min(lowerTime, snowflakeTime(message.id) - 1);
      const lower = snowflakeAt(lowerTime);
      let before: string | undefined;
      let high = previous?.lastMessageId ?? null;
      const raw = new Map<string, RawMessage>();
      while (true) {
        // Walk backwards from a stable head to the lower snowflake. Unlike advancing
        // an `after` cursor to the largest returned ID, this cannot skip busy pages.
        const page = await client.messages(channelId, before ? { before } : {});
        if (!page.length) break;
        const sorted = [...page].sort((a, b) => compareIds(b.id, a.id));
        const minimum = sorted.at(-1)!.id;
        if (before && compareIds(minimum, before) >= 0) throw new Error('Discord pagination did not advance');
        for (const m of sorted) {
          if (!high || compareIds(m.id, high) > 0) high = m.id;
          if (human(m)) raw.set(m.id, m);
        }
        if (compareIds(minimum, lower) <= 0 || page.length < 100) break;
        before = minimum;
      }
      const ordered = [...raw.values()].sort((a, b) => compareIds(a.id, b.id));
      const actionableWindow = ordered.filter(m => compareIds(m.id, lower) > 0);
      const boundary = ordered.filter(m => compareIds(m.id, lower) <= 0).slice(-config.contextMessages);
      const incoming = [...boundary, ...actionableWindow].map(m => normalizeMessage(m, config.discord.guildId, channel.name, compareIds(m.id, lower) <= 0));
      const known = new Map([...messages, ...incoming].map(m => [m.id, m]));
      for (const rawMessage of actionableWindow) {
        const message = known.get(rawMessage.id)!;
        const reference = rawMessage.message_reference;
        const refChannel = reference?.channel_id ?? channelId;
        if (!reference?.message_id || !config.discord.channelIds.includes(refChannel) || (reference.guild_id && reference.guild_id !== config.discord.guildId)) continue;
        let related = known.get(reference.message_id);
        if (!related) {
          const embedded = rawMessageSchema.safeParse(rawMessage.referenced_message);
          const reply = embedded.success ? embedded.data : await client.message(refChannel, reference.message_id);
          if (reply && human(reply)) {
            client.verify(reply, refChannel);
            if (reply.id !== reference.message_id) throw new Error('Mismatched Discord reply identity');
            const name = refChannel === channelId ? channel.name : (await client.channel(refChannel)).name;
            related = normalizeMessage(reply, config.discord.guildId, name, true);
            known.set(related.id, related); incoming.push(related);
          }
        }
        if (related) message.replyContext = { messageId: related.id, authorId: related.authorId, nickname: related.authorDisplayName, content: related.content, timestamp: related.timestamp, permalink: related.permalink };
      }
      const combined = mergeMessages(messages, incoming, recoverEmptyIds);
      const sameChannel = combined.filter(m => m.channelId === channelId);
      for (let i = 0; i < sameChannel.length; i++) {
        const m = sameChannel[i]!;
        if (!raw.has(m.id)) continue;
        m.contextMessageIds = sameChannel.slice(Math.max(0, i - config.contextMessages), i + config.contextMessages + 1).filter(c => c.id !== m.id).map(c => c.id);
      }
      await store.write('messages.json', { version: 1, messages: combined }, messagesSchema);
      added += combined.length - messages.length;
      messages = combined;
      // The cursor is committed only after the entire channel scan and file write.
      state.collection.channels[channelId] = { lastMessageId: high, since, lastCollectedAt: now.toISOString() };
      clearStageErrors(state, `collect:${channelId}`);
      await store.saveState(state);
    } catch {
      if (checkpointBefore) state.collection.channels[channelId] = checkpointBefore;
      else delete state.collection.channels[channelId];
      const stage = `collect:${channelId}`;
      const message = `Collection failed for channel ${channelId}; its checkpoint was not advanced. Check credentials, permissions, API response, or network and retry.`;
      clearStageErrors(state, stage);
      state.errors.push({ id: stage, stage, taskId: null, at: now.toISOString(), message });
      await store.saveState(state); failures.push(message);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  state.lastSuccessfulRun.collect = now.toISOString(); await store.saveState(state);
  return { added, total: messages.length };
}
export function clearStageErrors(state: State, stage: string) { state.errors = state.errors.filter(e => e.stage !== stage); }
