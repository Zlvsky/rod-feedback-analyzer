import { cli } from './runtime.js';
import { retrieveContext } from '../trello/context.js';
await cli('trello-context', 'trello', async ({ config, store, trello, now }) => ({ cards: (await retrieveContext(config, store, trello, now)).cards.length }));
