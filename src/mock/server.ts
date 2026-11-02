import { z } from 'zod';
import { MOCK_IDS, type Config } from '../config/index.js';
import { normalizeMessage } from '../discord/collector.js';
import { emptyState } from '../schemas/state.js';
import { messagesSchema } from '../schemas/messages.js';
import { tasksSchema, type Source, type Task } from '../schemas/tasks.js';
import { cardSchema, listSchema, labelSchema, actionSchema } from '../schemas/trello.js';
import { compareIds, sourceMarker, taskMarker } from '../services/deduplication.js';
import { Storage } from '../services/storage.js';
import type { Fetch } from '../services/http.js';
import { conversation, existingCardId, fixtureNow, pendingTaskId, previousCardId, previousTaskId } from './conversations.js';

export const mockBoardSchema = z.object({
  cards: z.array(cardSchema), lists: z.array(listSchema), labels: z.array(labelSchema),
  actions: z.record(z.string(), z.array(actionSchema)), serial: z.number(), writeAttempts: z.number(), rateLimitedOnce: z.boolean(),
});
export const fixtureSource = (index: number): Source => {
  const m = normalizeMessage(conversation[index]!, MOCK_IDS.guild, conversation[index]!.channel_id === MOCK_IDS.feedback ? 'feedback' : 'general-en');
  return { messageId: m.id, nickname: m.authorDisplayName, channel: m.channelName, timestamp: m.timestamp, permalink: m.permalink, excerpt: m.content };
};
export const fixtureTask = (index: number, fields: Partial<Task> = {}): Task => ({
  id: `rod-${conversation[index]!.id}-example-task`, title: 'Investigate reported feedback', description: 'A player reported an issue.',
  suggestedAction: 'Investigate the report using the supplied evidence.', type: 'bug', impact: 'major', confidence: 0.95,
  needsClarification: false, sources: [fixtureSource(index)], relatedExistingCardId: null, possibleExistingCardIds: [], syncStatus: 'pending', ...fields,
});
export async function seedMock(store: Storage): Promise<void> {
  const found = await store.read('mock-server.json', mockBoardSchema.nullable(), () => null);
  if (found) return;
  const existingMessages = await store.messages();
  const state = await store.state();
  if (existingMessages.messages.length || state.scope.discord || state.scope.trello) throw new Error('Use an empty, isolated directory when seeding mock data');
  const old = fixtureTask(1, { id: previousTaskId, title: 'Fix missing gold when claiming auto-contract rewards', description: 'Claiming a completed auto-contract does not increase the player’s gold.', suggestedAction: 'Investigate reward delivery when a completed auto-contract is claimed.', syncStatus: 'synced' });
  const pending = fixtureTask(0, { id: pendingTaskId, type: 'improvement', impact: 'minor', title: 'Show profession levels beside their names', description: 'The player wants profession levels visible beside profession names.', suggestedAction: 'Show the current level beside each profession name.' });
  await store.write('messages.json', { version: 1, messages: [0, 1].map(i => normalizeMessage(conversation[i]!, MOCK_IDS.guild, 'feedback')) }, messagesSchema);
  await store.write('tasks.json', { version: 1, tasks: [old, pending] }, tasksSchema);
  const seed = emptyState();
  seed.analysis.analyzedMessageIds = [conversation[0]!.id, conversation[1]!.id];
  seed.sync.taskCards[old.id] = { cardId: previousCardId, sourceMessageIds: [conversation[1]!.id] };
  seed.sync.messageCards[conversation[1]!.id] = [previousCardId];
  seed.sync.synchronizedTaskIds = [old.id]; seed.sync.awaitingTaskIds = [pending.id];
  await store.saveState(seed);
  const labels = ['bug', 'balancing', 'feature', 'improvement', 'minor', 'major'].map((name, i) => ({ id: (i + 1).toString(16).padStart(24, '0'), name, color: 'blue' }));
  await store.write('mock-server.json', {
    cards: [
      { id: previousCardId, idBoard: MOCK_IDS.board, idList: MOCK_IDS.list, name: old.title, desc: `${old.description}\n${old.sources[0]!.permalink}\n${taskMarker(old.id)}\n${sourceMarker(old.id, old.sources[0]!.messageId)}`, closed: false, labels: [labels[0]!] },
      { id: existingCardId, idBoard: MOCK_IDS.board, idList: 'cccccccccccccccccccccccc', name: 'Persist the inventory sort preference', desc: 'Keep the chosen inventory sort between app sessions. Manually maintained implementation notes: preserve this text.', closed: false, labels: [] },
    ],
    lists: [{ id: MOCK_IDS.list, idBoard: MOCK_IDS.board, name: 'Player feedback', closed: false }, { id: 'cccccccccccccccccccccccc', idBoard: MOCK_IDS.board, name: 'In progress', closed: false }],
    labels, actions: {}, serial: 100, writeAttempts: 0, rateLimitedOnce: false,
  }, mockBoardSchema);
}
export function mockFetch(store: Storage, config: Config, raw = conversation): Fetch {
  if (!config.mock) throw new Error('Mock transport requires mock configuration');
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (url.origin === 'https://discord.com') {
      if (method !== 'GET') throw new Error('Mock Discord is read-only');
      if (url.pathname === '/api/v10/applications/@me') return json({ flags: 1 << 19 });
      const match = /^\/api\/v10\/channels\/(\d+)(?:\/messages(?:\/(\d+))?)?$/.exec(url.pathname);
      if (!match || !config.discord.channelIds.includes(match[1]!)) return json({}, 403);
      if (!url.pathname.includes('/messages')) return json({ id: match[1], guild_id: MOCK_IDS.guild, type: 0, name: match[1] === MOCK_IDS.feedback ? 'feedback' : 'general-en' });
      if (match[2]) return json(raw.find(m => m.id === match[2] && m.channel_id === match[1]) ?? {}, raw.some(m => m.id === match[2]) ? 200 : 404);
      const before = url.searchParams.get('before'), after = url.searchParams.get('after');
      return json(raw.filter(m => m.channel_id === match[1] && (!before || compareIds(m.id, before) < 0) && (!after || compareIds(m.id, after) > 0)).sort((a, b) => compareIds(b.id, a.id)).slice(0, Number(url.searchParams.get('limit') ?? 100)));
    }
    if (url.origin !== 'https://api.trello.com') throw new Error('Mock transport refused an external origin');
    const server = await store.read('mock-server.json', mockBoardSchema);
    const path = url.pathname.replace(/^\/1/, '');
    if (method === 'GET') {
      if (path === `/boards/${MOCK_IDS.board}`) return json({ id: MOCK_IDS.board, closed: false });
      if (path === `/boards/${MOCK_IDS.board}/lists`) return json(server.lists);
      if (path === `/boards/${MOCK_IDS.board}/labels`) return json(server.labels);
      if (path === `/boards/${MOCK_IDS.board}/cards/all`) {
        const before = url.searchParams.get('before');
        return json(server.cards.filter(c => !before || c.id < before).sort((a, b) => b.id.localeCompare(a.id)).slice(0, Number(url.searchParams.get('limit') ?? 1000)));
      }
      const list = /^\/lists\/([a-f0-9]{24})$/.exec(path);
      if (list) return json(server.lists.find(l => l.id === list[1]) ?? {}, 200);
      const card = /^\/cards\/([a-f0-9]{24})$/.exec(path);
      if (card) return json(server.cards.find(c => c.id === card[1]) ?? {}, 200);
      const actions = /^\/cards\/([a-f0-9]{24})\/actions$/.exec(path);
      if (actions) {
        const before = url.searchParams.get('before');
        return json((server.actions[actions[1]!] ?? []).filter(a => !before || a.id < before).sort((a, b) => b.id.localeCompare(a.id)).slice(0, Number(url.searchParams.get('limit') ?? 1000)));
      }
    }
    if (method === 'POST') {
      server.writeAttempts++;
      if (!server.rateLimitedOnce) {
        server.rateLimitedOnce = true; await store.write('mock-server.json', server, mockBoardSchema);
        return json({ message: 'Rate limit; retry this rejected request' }, 429, { 'retry-after': '0.001' });
      }
      const body = new URLSearchParams(String(init?.body));
      const id = (++server.serial).toString(16).padStart(24, '0');
      if (path === '/cards') {
        const card = { id, idBoard: MOCK_IDS.board, idList: body.get('idList')!, name: body.get('name')!, desc: body.get('desc')!, closed: false, labels: server.labels.filter(l => body.get('idLabels')?.split(',').includes(l.id)) };
        server.cards.push(card); await store.write('mock-server.json', server, mockBoardSchema); return json(card);
      }
      const target = /^\/cards\/([a-f0-9]{24})\/actions\/comments$/.exec(path);
      if (target) {
        const action = { id, date: fixtureNow.toISOString(), data: { text: body.get('text')! } };
        (server.actions[target[1]!] ??= []).push(action); await store.write('mock-server.json', server, mockBoardSchema); return json(action);
      }
    }
    throw new Error(`Unhandled mock API route: ${method} ${url.pathname}`);
  };
}
