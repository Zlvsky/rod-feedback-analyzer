import { describe, expect, it } from 'vitest';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { bindScope, loadConfig, requireConfig } from '../../src/config/index.js';
import { beginWorkflow, endWorkflow } from '../../src/services/storage.js';
import { emptyState } from '../../src/schemas/state.js';
import { setup } from '../helpers.js';

describe('configuration and private durable storage', () => {
  it('defaults to dry-run and lists missing names without values', () => {
    const c = loadConfig({}, {}); expect(c.dryRun).toBe(true);
    expect(() => requireConfig(c, 'all')).toThrow('DISCORD_BOT_TOKEN');
  });
  it('rejects misspelled dry-run booleans', () => { expect(() => loadConfig({}, { DRY_RUN: 'flase' })).toThrow(); });
  it('isolates mock credentials and storage from the live environment', () => {
    const c = loadConfig({ mock: true }, { DATA_DIR: '/secret/live', DISCORD_BOT_TOKEN: 'real-secret', DRY_RUN: 'false' });
    expect(c.discord.token).toBe('mock-discord'); expect(c.dataDir).toMatch(/data\/mock$/); expect(c.dryRun).toBe(true);
    expect(() => loadConfig({ mock: true, dataDir: './data' }, {})).toThrow();
  });
  it('binds each service scope and refuses reusing state for a different board', () => {
    const c = loadConfig({ mock: true }, {}), s = emptyState(); bindScope(s, c, 'trello');
    expect(() => bindScope(s, { ...c, trello: { ...c.trello, boardId: 'ffffffffffffffffffffffff' } }, 'trello')).toThrow('another trello');
  });
  it('atomically writes private validated JSON and refuses traversal', async () => {
    const { store } = await setup(false); const schema = z.object({ n: z.number() });
    await store.write('sample.json', { n: 1 }, schema);
    expect(await store.read('sample.json', schema)).toEqual({ n: 1 });
    expect((await stat(store.path('sample.json'))).mode & 0o777).toBe(0o600);
    await expect(store.write('sample.json', { n: 'bad' } as unknown as { n: number }, schema)).rejects.toThrow();
    expect(JSON.parse(await readFile(store.path('sample.json'), 'utf8'))).toEqual({ n: 1 });
    expect(() => store.path('../escape.json')).toThrow();
  });
  it('does not silently reset corrupt state', async () => {
    const { store } = await setup(false); await writeFile(store.path('state.json'), '{broken');
    await expect(store.state()).rejects.toThrow('malformed JSON');
    expect(await readFile(store.path('state.json'), 'utf8')).toBe('{broken');
  });
  it('refuses symlink reads', async () => {
    const { store } = await setup(false); await writeFile(join(store.dir, 'outside'), '{}');
    await symlink(join(store.dir, 'outside'), store.path('state.json'));
    await expect(store.state()).rejects.toThrow();
  });
  it('prevents overlapping commands and releases the lock after an exception', async () => {
    const { store } = await setup(false);
    await store.lock(async () => { await expect(store.lock(async () => {})).rejects.toThrow('Another command'); });
    await expect(store.lock(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(store.lock(async () => 'ok')).resolves.toBe('ok');
  });
  it('holds a workflow lease across separate CLI processes/stages', async () => {
    const { store } = await setup(false); const id = await beginWorkflow(store);
    await expect(store.lock(async () => {})).rejects.toThrow('workflow is already running');
    await expect(store.lock(async () => 'allowed', id)).resolves.toBe('allowed');
    await endWorkflow(store, id); await expect(store.lock(async () => 'released')).resolves.toBe('released');
  });
});
