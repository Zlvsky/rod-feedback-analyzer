import { describe, expect, it } from 'vitest';
import { chunks, comment, description, literal } from '../../src/trello/format.js';
import { fixtureSource, fixtureTask } from '../../src/mock/server.js';
import { taskMarkers, sourceIds } from '../../src/services/deduplication.js';

describe('bounded, literal Trello output', () => {
  it('escapes Markdown and mentions', () => {
    expect(literal('@person [link](target) <html>')).toContain('@\u200bperson');
    expect(literal('[link]')).toBe('\\[link\\]');
  });
  it('splits long evidence into bounded comments without dropping sources', () => {
    const task = fixtureTask(4);
    const sources = Array.from({ length: 30 }, (_, index) => ({ ...fixtureSource(4), messageId: (900000000000000000n + BigInt(index)).toString(), excerpt: 'x'.repeat(1500) }));
    const batches = chunks(task, sources);
    expect(batches.length).toBeGreaterThan(1); expect(batches.flat()).toEqual(sources);
    expect(batches.every(batch => comment(task, batch, 'a'.repeat(64)).length < 16384)).toBe(true);
    expect(description(task, batches[0]!, 'a'.repeat(64)).length).toBeLessThan(16384);
    expect(taskMarkers(comment(task, batches[0]!, 'a'.repeat(64)))).toEqual([task.id]);
    expect(sourceIds(comment(task, batches[0]!, 'a'.repeat(64)))).toContain(sources[0]!.messageId);
  });
});
