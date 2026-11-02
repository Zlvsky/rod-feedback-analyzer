import { describe, expect, it, vi } from 'vitest';
import { ApiHttp, AmbiguousWriteError, HttpError } from '../../src/services/http.js';

const json = (status: number, value: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });
describe('restricted retrying HTTP transport', () => {
  it('retries Discord 429 using fractional Retry-After and body retry_after', async () => {
    const send = vi.fn().mockResolvedValueOnce(json(429, { retry_after: 1.5 }, { 'retry-after': '2' })).mockResolvedValueOnce(json(200, []));
    const wait = vi.fn(async () => {});
    const http = new ApiHttp('discord', { retries: 2, timeoutMs: 100, fetch: send, wait });
    await expect(http.request('/channels/1/messages')).resolves.toEqual([]);
    expect(wait).toHaveBeenCalledWith(2000); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
  });
  it('retries safe reads after 503 and network failures', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('sensitive URL')).mockResolvedValueOnce(json(503)).mockResolvedValueOnce(json(200, { ok: true }));
    const http = new ApiHttp('trello', { retries: 2, timeoutMs: 100, fetch: send, wait: async () => {} });
    await expect(http.request('/boards/1')).resolves.toEqual({ ok: true });
  });
  it.each([401, 403])('does not retry expired tokens or missing permissions (%i)', async status => {
    const send = vi.fn().mockResolvedValue(json(status, { token: 'never-log-me' }));
    const http = new ApiHttp('discord', { retries: 4, timeoutMs: 100, fetch: send });
    await expect(http.request('/channels/1')).rejects.toBeInstanceOf(HttpError); expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['network', 'server', 'malformed'])('never blindly retries an ambiguous POST: %s', async kind => {
    const send = vi.fn();
    if (kind === 'network') send.mockRejectedValue(new Error('secret-token'));
    else send.mockResolvedValue(kind === 'server' ? json(503) : new Response('not-json'));
    const http = new ApiHttp('trello', { retries: 4, timeoutMs: 100, fetch: send });
    await expect(http.request('/cards', { method: 'POST' })).rejects.toBeInstanceOf(AmbiguousWriteError); expect(send).toHaveBeenCalledTimes(1);
  });
  it('retries a rejected Trello write on 429', async () => {
    const send = vi.fn().mockResolvedValueOnce(json(429)).mockResolvedValueOnce(json(200, { id: 'ok' }));
    const http = new ApiHttp('trello', { retries: 1, timeoutMs: 100, fetch: send, wait: async () => {} });
    await expect(http.request('/cards', { method: 'POST' })).resolves.toEqual({ id: 'ok' }); expect(send).toHaveBeenCalledTimes(2);
  });
  it('fails after the configured retry budget', async () => {
    const send = vi.fn().mockResolvedValue(json(429));
    const http = new ApiHttp('trello', { retries: 1, timeoutMs: 100, fetch: send, wait: async () => {} });
    await expect(http.request('/boards/1')).rejects.toThrow('429'); expect(send).toHaveBeenCalledTimes(2);
  });
  it('respects exhausted Discord rate-limit headers', async () => {
    const send = vi.fn().mockResolvedValueOnce(json(200, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' })).mockResolvedValue(json(200));
    const wait = vi.fn(async () => {}), http = new ApiHttp('discord', { retries: 1, timeoutMs: 100, fetch: send, wait });
    await http.request('/channels/1'); await http.request('/channels/1'); expect(wait.mock.calls.length).toBe(1);
  });
  it('blocks Discord mutations and arbitrary URL paths before fetch', async () => {
    const send = vi.fn(), http = new ApiHttp('discord', { retries: 0, timeoutMs: 100, fetch: send });
    await expect(http.request('/channels/1/messages', { method: 'POST' })).rejects.toThrow('read-only');
    for (const path of ['https://evil.invalid', '//evil.invalid', '/../outside', '/channels/1#fragment']) await expect(http.request(path)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
