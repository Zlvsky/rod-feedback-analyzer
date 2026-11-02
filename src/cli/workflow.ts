import { beginWorkflow, endWorkflow } from '../services/storage.js';
import { args, runtime } from './runtime.js';
try {
  const context = await runtime();
  const runId = args()['run-id'];
  if (process.env.npm_lifecycle_event === 'workflow:end' && !runId) throw new Error('workflow:end requires --run-id UUID');
  if (runId) { await endWorkflow(context.store, runId); console.log('Workflow lease released'); }
  else console.log(JSON.stringify({ runId: await beginWorkflow(context.store), dataDirectory: context.config.dataDir }));
} catch (error) { console.error(error instanceof Error ? error.message : 'Workflow lock failed'); process.exitCode = 1; }
