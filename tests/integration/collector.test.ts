import { describe, expect, it, vi } from 'vitest';
import { collect, normalizeMessage } from '../../src/discord/collector.js';
import { messagesSchema } from '../../src/schemas/messages.js';
import { DiscordClient } from '../../src/discord/client.js';
import { mockFetch } from '../../src/mock/server.js';
import { compareIds, snowflakeAt } from '../../src/services/deduplication.js';
import { fixtureNow, conversation } from '../fixtures/conversations.js';
import { setup } from '../helpers.js';

describe('Discord incremental collection', () => {
  it('collects both channels read-only, ignores bots, preserves replies and attachments, and reruns without duplicates', async () => {
    const { config, store, send, wait } = await setup(); const transport = vi.fn(send), client = new DiscordClient(config, transport, wait);
    const first = await collect(config, store, client, fixtureNow), state = await store.state();
    expect(first.total).toBe(13);
    const messages = (await store.messages()).messages;
    expect(messages.find(m => m.id === conversation[2]!.id)!.replyContext!.messageId).toBe(conversation[1]!.id);
    expect(messages.find(m => m.id === conversation[6]!.id)!.attachments[0]!.filename).toBe('rune-contrast.png');
    expect(messages.some(m => m.id === conversation[11]!.id)).toBe(false);
    expect(state.analysis.analyzedMessageIds).toHaveLength(2);
    expect((await collect(config, store, client, fixtureNow)).added).toBe(0);
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(transport.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://discord.com')).toBe(true);
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
  });
  it('paginates hundreds of messages backwards without skipping a busy channel', async () => {
    const { config, store, wait } = await setup(false);
    const raw = Array.from({ length: 245 }, (_, i) => ({ ...conversation[4]!, id: (BigInt(snowflakeAt(fixtureNow.getTime() - 60000)) + BigInt(i)).toString(), timestamp: new Date(fixtureNow.getTime() - 60000).toISOString() }));
    const send = vi.fn(mockFetch(store, config, raw));
    await collect(config, store, new DiscordClient(config, send, wait), fixtureNow);
    expect((await store.messages()).messages).toHaveLength(245);
    const cursors = send.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('before')).filter(Boolean);
    expect(cursors).toHaveLength(2); expect(compareIds(cursors[1]!, cursors[0]!)).toBe(-1);
  });
  it('keeps the old checkpoint if a later page fails', async () => {
    const { config, store, wait } = await setup(false);
    config.retries = 0;
    const raw = Array.from({ length: 101 }, (_, i) => ({ ...conversation[4]!, id: (BigInt(snowflakeAt(fixtureNow.getTime() - 60000)) + BigInt(i)).toString() }));
    const normal = mockFetch(store, config, raw);
    const send: typeof fetch = async (input, init) => new URL(String(input)).searchParams.has('before') ? new Response('{}', { status: 503 }) : normal(input, init);
    await expect(collect(config, store, new DiscordClient(config, send, wait), fixtureNow)).rejects.toThrow('checkpoint was not advanced');
    expect((await store.state()).collection.channels[config.discord.channelIds[0]]).toBeUndefined();
    expect((await store.messages()).messages).toHaveLength(0);
    expect((await store.state()).errors).toHaveLength(1);
  });
  it('handles empty channels without fabricating messages or marking analysis complete', async () => {
    const { config, store, wait } = await setup(false);
    await collect(config, store, new DiscordClient(config, mockFetch(store, config, []), wait), fixtureNow);
    const state = await store.state(); expect((await store.messages()).messages).toHaveLength(0);
    expect(state.analysis.analyzedMessageIds).toEqual([]);
    expect(state.collection.channels[config.discord.channelIds[0]]!.lastMessageId).toBeNull();
  });
  it('retains only bounded context from before the initial seven-day window', async () => {
    const { config, store, wait } = await setup(false);
    const old = { ...conversation[4]!, id: snowflakeAt(fixtureNow.getTime() - 8 * 86400000), timestamp: new Date(fixtureNow.getTime() - 8 * 86400000).toISOString() };
    await collect(config, store, new DiscordClient(config, mockFetch(store, config, [old, conversation[4]!]), wait), fixtureNow);
    const messages = (await store.messages()).messages;
    expect(messages.find(m => m.id === old.id)!.contextOnly).toBe(true);
    expect(messages.find(m => m.id === conversation[4]!.id)!.contextOnly).toBe(false);
  });
  it('backfills full feedback history past an existing cursor without scanning general chat', async () => {
    const { config, store, wait } = await setup(false);
    const old = { ...conversation[4]!, id: snowflakeAt(fixtureNow.getTime() - 400 * 86400000), timestamp: new Date(fixtureNow.getTime() - 400 * 86400000).toISOString() };
    const state = await store.state();
    state.collection.channels[config.discord.channelIds[0]] = { lastMessageId: conversation[4]!.id, since: '2026-10-24T00:00:00.000Z', lastCollectedAt: fixtureNow.toISOString() };
    await store.saveState(state);
    const recent = Array.from({ length: 103 }, (_, i) => ({ ...conversation[4]!, id: (BigInt(conversation[4]!.id) + BigInt(i)).toString() }));
    const send = vi.fn(mockFetch(store, config, [old, ...recent, ...conversation.filter(m => m.channel_id === config.discord.channelIds[1])]));
    await collect(config, store, new DiscordClient(config, send, wait), fixtureNow, { fullHistory: true, feedbackOnly: true });
    const messages = (await store.messages()).messages;
    expect(messages).toHaveLength(104);
    expect(messages.find(m => m.id === old.id)!.contextOnly).toBe(false);
    expect(send.mock.calls.some(([url]) => String(url).includes(`/channels/${config.discord.channelIds[1]}`))).toBe(false);
    expect((await store.state()).collection.channels[config.discord.channelIds[0]]!.since).toBe('2015-01-01T00:00:00.000Z');
    expect((await store.state()).analysis.analyzedMessageIds).toEqual([]);
  });
  it('refuses channel IDs outside the allowlist and cross-guild responses', async () => {
    const { config, store, wait } = await setup(false);
    const client = new DiscordClient(config, mockFetch(store, config), wait);
    await expect(client.messages('999999999999999999')).rejects.toThrow('allowlist');
    const send: typeof fetch = async () => new Response(JSON.stringify({ id: config.discord.channelIds[0], guild_id: '999999999999999999', name: 'feedback', type: 0 }));
    await expect(new DiscordClient(config, send, wait).channel(config.discord.channelIds[0])).rejects.toThrow('configured guild');
  });
  it('stops before channel collection when Message Content Intent is disabled', async () => {
    const { config, store, send, wait } = await setup(false);
    const transport = vi.fn<typeof fetch>(async (input, init) => new URL(String(input)).pathname === '/api/v10/applications/@me'
      ? new Response(JSON.stringify({ flags: 0 })) : send(input, init));
    await expect(collect(config, store, new DiscordClient(config, transport, wait), fixtureNow)).rejects.toThrow('Message Content Intent is disabled');
    expect(transport).toHaveBeenCalledTimes(1);
    const state = await store.state();
    expect(state.collection.channels).toEqual({});
    expect(state.analysis.analyzedMessageIds).toEqual([]);
    expect(state.errors[0]!.stage).toBe('collect:message-content');
    expect((await store.messages()).messages).toEqual([]);
  });
  it('accepts the approved message-content flag for larger bots', async () => {
    const { config, store, send, wait } = await setup(false);
    const transport: typeof fetch = async (input, init) => new URL(String(input)).pathname === '/api/v10/applications/@me'
      ? new Response(JSON.stringify({ flags: 1 << 18 })) : send(input, init);
    await expect(collect(config, store, new DiscordClient(config, transport, wait), fixtureNow)).resolves.toMatchObject({ total: 13 });
  });
  it('backfills old unresolved empty records across pages after intent recovery, preserving analyzed quotes', async () => {
    const { config, store, wait } = await setup(false);
    const old = normalizeMessage(conversation[1]!, config.discord.guildId, 'feedback');
    const original = normalizeMessage(conversation[4]!, config.discord.guildId, 'feedback');
    const latest = normalizeMessage(conversation[7]!, config.discord.guildId, 'feedback');
    old.content = '';
    await store.write('messages.json', { version: 1, messages: [old, original, latest] }, messagesSchema);
    const state = await store.state();
    state.analysis.analyzedMessageIds = [original.id];
    state.collection.channels[old.channelId] = { lastMessageId: latest.id, since: '2026-10-24T00:00:00.000Z', lastCollectedAt: latest.timestamp };
    await store.saveState(state);
    const fillers = Array.from({ length: 103 }, (_, i) => ({ ...conversation[7]!, id: (BigInt(latest.id) + BigInt(i + 1)).toString(), content: 'New nearby conversation' }));
    const raw = [conversation[1]!, { ...conversation[4]!, content: 'Edited text must not overwrite the original quote' }, conversation[7]!, ...fillers];
    const transport = vi.fn(mockFetch(store, config, raw));
    await collect(config, store, new DiscordClient(config, transport, wait), fixtureNow);
    const messages = (await store.messages()).messages;
    expect(messages.find(m => m.id === old.id)!.content).toBe(conversation[1]!.content);
    expect(messages.find(m => m.id === original.id)!.content).toBe(original.content);
    expect(transport.mock.calls.some(([url]) => new URL(String(url)).searchParams.has('before'))).toBe(true);
    expect((await store.state()).analysis.analyzedMessageIds).toEqual([original.id]);
  });
});
