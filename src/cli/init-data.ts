import { cli } from './runtime.js';
import { messagesSchema } from '../schemas/messages.js';
import { tasksSchema } from '../schemas/tasks.js';
import { resultsSchema } from '../schemas/results.js';
await cli('init-data', null, async ({ store }) => {
  await store.write('messages.json', await store.messages(), messagesSchema);
  await store.write('tasks.json', await store.tasks(), tasksSchema);
  await store.saveState(await store.state());
  await store.write('sync-results.json', await store.read('sync-results.json', resultsSchema, () => ({ version: 1 as const, runs: [] })), resultsSchema);
  return { directory: store.dir, note: 'Local JSON initialized; existing data preserved. Trello context is created on refresh.' };
});
