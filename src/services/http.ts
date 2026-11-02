import { setTimeout as sleep } from 'node:timers/promises';

export type Fetch = typeof fetch;
export class HttpError extends Error {
  constructor(readonly service: string, readonly status: number) { super(`${service} API returned HTTP ${status}${status === 401 || status === 403 ? ' (check credentials, permissions, and token expiry)' : ''}`); }
}
export class AmbiguousWriteError extends Error {
  constructor() { super('Trello write outcome is unknown. Recover by automation marker before retrying.'); }
}
interface HttpOptions { fetch?: Fetch; retries: number; timeoutMs: number; wait?: (ms: number) => Promise<void> }
export class ApiHttp {
  private readonly send: Fetch;
  private readonly wait: (ms: number) => Promise<void>;
  private cooldownUntil = 0;
  constructor(readonly service: 'discord' | 'trello', private readonly options: HttpOptions) {
    this.send = options.fetch ?? fetch;
    this.wait = options.wait ?? (async ms => { await sleep(ms); });
  }
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const base = this.service === 'discord' ? 'https://discord.com/api/v10' : 'https://api.trello.com/1';
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#]|\.\./.test(path)) throw new Error('Disallowed API path');
    const url = new URL(base + path);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname + '/')) throw new Error('Disallowed API origin');
    const write = (init.method ?? 'GET') !== 'GET';
    if (this.service === 'discord' && write) throw new Error('Discord is strictly read-only');
    for (let attempt = 0; ; attempt++) {
      const delay = this.cooldownUntil - Date.now();
      if (delay > 0) await this.wait(delay);
      let response: Response;
      try { response = await this.send(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs) }); }
      catch {
        if (write) throw new AmbiguousWriteError();
        if (attempt >= this.options.retries) throw new Error(`${this.service} API network request failed or timed out`);
        await this.wait(this.backoff(attempt)); continue;
      }
      if (response.status === 429) {
        let body: unknown;
        try { body = await response.json(); } catch { body = null; }
        const hint = body && typeof body === 'object' && 'retry_after' in body ? Number(body.retry_after) * 1000 : 0;
        const header = response.headers.get('retry-after');
        const retry = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
        if (attempt >= this.options.retries) throw new HttpError(this.service, 429);
        await this.wait(Math.max(this.backoff(attempt), Number.isFinite(hint) ? hint : 0, Number.isFinite(retry) ? retry : 0)); continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        if (write) throw new AmbiguousWriteError();
        if (attempt >= this.options.retries) throw new HttpError(this.service, response.status);
        await this.wait(this.backoff(attempt)); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(this.service, response.status); }
      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const seconds = Number(response.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(seconds) && seconds > 0) this.cooldownUntil = Date.now() + seconds * 1000;
      }
      // Trello exposes separate API-key/token budgets. Use a conservative pause on exhaustion.
      if (['x-rate-limit-api-key-remaining', 'x-rate-limit-api-token-remaining'].some(h => response.headers.get(h) === '0')) this.cooldownUntil = Date.now() + 10000;
      try { return await response.json(); }
      catch { if (write) throw new AmbiguousWriteError(); throw new Error(`${this.service} API returned malformed JSON`); }
    }
  }
  private backoff(attempt: number) { return Math.min(30000, 500 * 2 ** attempt) + Math.floor(Math.random() * 100); }
}
