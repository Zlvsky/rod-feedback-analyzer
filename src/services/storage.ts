import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { emptyState, stateSchema, type State } from '../schemas/state.js';
import { messagesSchema } from '../schemas/messages.js';
import { tasksSchema } from '../schemas/tasks.js';

export class Storage {
  constructor(readonly dir: string) {}
  path(name: string): string {
    if (!/^[a-zA-Z0-9.-]+\.json$/.test(name)) throw new Error('Invalid storage filename');
    return join(this.dir, name);
  }
  async init(): Promise<void> { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }
  async read<T>(name: string, schema: z.ZodType<T>, fallback?: () => T): Promise<T> {
    let handle;
    try {
      handle = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
      return schema.parse(JSON.parse(await handle.readFile('utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback) return fallback();
      if (error instanceof z.ZodError) throw new Error(`${name} failed schema validation: ${error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')}`);
      if (error instanceof SyntaxError) throw new Error(`${name} contains malformed JSON. Restore a valid backup; it was not overwritten.`);
      throw error;
    } finally { await handle?.close(); }
  }
  async write<T>(name: string, value: T, schema: z.ZodType<T>): Promise<void> {
    const parsed = schema.parse(value);
    await this.init();
    const target = this.path(name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(parsed, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
      const directory = await open(this.dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  state(): Promise<State> { return this.read('state.json', stateSchema, emptyState); }
  messages() { return this.read('messages.json', messagesSchema, () => ({ version: 1 as const, messages: [] })); }
  tasks() { return this.read('tasks.json', tasksSchema, () => ({ version: 1 as const, tasks: [] })); }
  saveState(state: State) { return this.write('state.json', state, stateSchema); }
  async lock<T>(action: () => Promise<T>, runId?: string): Promise<T> {
    await this.init();
    const path = join(this.dir, '.execution.lock');
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another command holds .execution.lock. Inspect the owner; remove only after confirming it has stopped.');
      throw error;
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      const lease = await this.read('workflow-lock.json', leaseSchema, () => null);
      if (lease && lease.runId !== runId) throw new Error('A workflow is already running. Pass its --run-id, or finish/recover that workflow first.');
      return await action();
    } finally { await file.close(); await rm(path, { force: true }); }
  }
}
export const leaseSchema = z.strictObject({ runId: z.uuid(), at: z.iso.datetime(), host: z.string() }).nullable();
export async function beginWorkflow(store: Storage): Promise<string> {
  return store.lock(async () => {
    const runId = randomUUID();
    await store.write('workflow-lock.json', { runId, at: new Date().toISOString(), host: hostname() }, leaseSchema);
    return runId;
  });
}
export async function endWorkflow(store: Storage, runId: string): Promise<void> {
  await store.lock(async () => { await rm(store.path('workflow-lock.json')); }, runId);
}
