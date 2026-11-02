import { randomUUID } from 'node:crypto';
import { cli, args } from './runtime.js';
import { resultsSchema } from '../schemas/results.js';
import { operationMarker, taskMarkers } from '../services/deduplication.js';
import { bindScope } from '../config/index.js';

await cli('resolve-operation', 'trello', async ({ config, store, trello, now }) => {
  const flags = args();
  if (!flags.operation || !flags['not-applied']) throw new Error('After manually confirming the write did not happen, pass --operation <id> --not-applied');
  if (config.dryRun) throw new Error('Reconciliation changes retry state. Set DRY_RUN=false, or use --mock --simulate-writes for a fixture.');
  const state = await store.state();
  bindScope(state, config, 'trello');
  const op = state.sync.operations[flags.operation];
  if (!op || !['uncertain', 'prepared'].includes(op.status)) throw new Error('No unresolved operation with that ID');
  const board = await trello.boardState();
  for (const card of board.cards) {
    const text = [card.desc, ...(await trello.actions(card.id)).map(a => a.data.text)].join('\n');
    if (text.includes(operationMarker(op.id)) || (op.kind === 'create' && taskMarkers(text).includes(op.taskId))) throw new Error('Remote write exists. Run sync:trello to recover it instead.');
  }
  op.status = 'not-applied'; await store.saveState(state);
  const history = await store.read('sync-results.json', resultsSchema, () => ({ version: 1 as const, runs: [] }));
  history.runs.push({ id: randomUUID(), at: now.toISOString(), dryRun: false, outcomes: [{ taskId: op.taskId, cardId: op.cardId, operationId: op.id, operation: 'resolve', status: 'not-applied', sourceMessageIds: op.sourceMessageIds, message: 'Operator confirmed the remote write was not applied; retry is permitted.' }] });
  await store.write('sync-results.json', history, resultsSchema);
  return { operation: op.id, status: op.status };
});
