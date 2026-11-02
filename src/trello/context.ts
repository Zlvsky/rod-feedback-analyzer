import { bindScope, type Config } from '../config/index.js';
import { clearStageErrors } from '../discord/collector.js';
import { contextSchema, type TrelloContext } from '../schemas/trello.js';
import { sourceIds, taskMarkers } from '../services/deduplication.js';
import { Storage } from '../services/storage.js';
import { TrelloClient } from './client.js';

export async function retrieveContext(config: Config, store: Storage, client: TrelloClient, now = new Date()): Promise<TrelloContext> {
  const state = await store.state(); bindScope(state, config, 'trello');
  const board = await client.boardState();
  const cards: TrelloContext['cards'] = [];
  for (const card of board.cards) {
    // Comments matter for duplicate recovery even on manually maintained cards.
    const actions = await client.actions(card.id);
    const text = [card.desc, ...actions.map(a => a.data.text)].join('\n');
    cards.push({ id: card.id, title: card.name, description: card.desc, labels: card.labels,
      list: { id: card.idList, name: board.lists.find(l => l.id === card.idList)!.name }, archived: card.closed,
      discordSourceIds: sourceIds(text), automationTaskIds: taskMarkers(text),
    });
  }
  const context: TrelloContext = { version: 1, boardId: config.trello.boardId, fetchedAt: now.toISOString(), cards };
  await store.write('trello-context.json', context, contextSchema);
  state.lastSuccessfulRun['trello-context'] = now.toISOString(); clearStageErrors(state, 'trello-context'); await store.saveState(state);
  return context;
}
