import { z } from 'zod';
import type { Config } from '../config/index.js';
import { trelloId } from '../schemas/common.js';
import { actionSchema, cardSchema, labelSchema, listSchema, type Action, type Card, type Label, type TrelloList } from '../schemas/trello.js';
import { ApiHttp, type Fetch } from '../services/http.js';

export interface BoardState { cards: Card[]; lists: TrelloList[]; labels: Label[] }
export class TrelloClient {
  private readonly http: ApiHttp;
  constructor(readonly config: Config, send?: Fetch, wait?: (ms: number) => Promise<void>) {
    this.http = new ApiHttp('trello', { retries: config.retries, timeoutMs: config.timeoutMs, ...(send ? { fetch: send } : {}), ...(wait ? { wait } : {}) });
  }
  private request(path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, string>) {
    if (method !== 'GET' && this.config.dryRun) throw new Error('Trello writes are disabled by dry-run');
    const params = new URLSearchParams({ key: this.config.trello.key, token: this.config.trello.token });
    return this.http.request(`${path}${path.includes('?') ? '&' : '?'}${params}`, {
      method, ...(body ? { body: new URLSearchParams(body) } : {}),
    });
  }
  async boardState(): Promise<BoardState> {
    const boardId = trelloId.parse(this.config.trello.boardId);
    const board = z.object({ id: trelloId, closed: z.boolean() }).parse(await this.request(`/boards/${boardId}?fields=id,closed`));
    if (board.id !== boardId || board.closed) throw new Error('Configured Trello board is mismatched or archived');
    const lists = z.array(listSchema).parse(await this.request(`/boards/${boardId}/lists?filter=all&fields=id,name,idBoard,closed`));
    if (lists.some(l => l.idBoard !== boardId)) throw new Error('Trello returned a list from another board');
    const destination = lists.find(l => l.id === this.config.trello.listId);
    if (!destination || destination.closed) throw new Error('Target Trello list must be open and belong to the configured board');
    const labels = z.array(labelSchema).parse(await this.request(`/boards/${boardId}/labels?limit=1000&fields=id,name,color`));
    const cards = await this.pages(`/boards/${boardId}/cards/all?fields=id,idBoard,idList,name,desc,closed,labels`, cardSchema);
    if (cards.some(c => c.idBoard !== boardId || !lists.some(l => l.id === c.idList))) throw new Error('Trello returned a card outside the configured board');
    return { cards, lists, labels };
  }
  private async pages<T extends { id: string }>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const all = new Map<string, T>();
    let before: string | undefined;
    while (true) {
      const page = z.array(schema).max(1000).parse(await this.request(`${path}&limit=1000${before ? `&before=${before}` : ''}`));
      let fresh = 0;
      for (const item of page) if (!all.has(item.id)) { all.set(item.id, item); fresh++; }
      if (page.length < 1000) break;
      if (page.some((item, i) => i > 0 && page[i - 1]!.id <= item.id)) throw new Error('Trello returned an unordered full page; refusing a potentially incomplete snapshot');
      // IDs encode creation time; do not rely on a board's manual card order.
      const next = page.map(c => c.id).sort()[0]!;
      if (!fresh || (before && next >= before)) throw new Error('Trello pagination did not advance; refusing an incomplete snapshot');
      before = next;
    }
    return [...all.values()];
  }
  async actions(cardId: string): Promise<Action[]> {
    trelloId.parse(cardId);
    return this.pages(`/cards/${cardId}/actions?filter=commentCard&fields=id,date,data`, actionSchema);
  }
  async assertWritable(cardId: string): Promise<Card> {
    trelloId.parse(cardId);
    const card = cardSchema.parse(await this.request(`/cards/${cardId}?fields=id,idBoard,idList,name,desc,closed,labels`));
    if (card.id !== cardId || card.idBoard !== this.config.trello.boardId) throw new Error('Refusing to modify a card outside the configured board');
    if (card.closed) throw new Error('Archived cards require human review');
    return card;
  }
  async createCard(title: string, description: string, labels: string[]): Promise<Card> {
    // Recheck list membership immediately before the mutation.
    const list = listSchema.parse(await this.request(`/lists/${trelloId.parse(this.config.trello.listId)}?fields=id,name,idBoard,closed`));
    if (list.id !== this.config.trello.listId || list.idBoard !== this.config.trello.boardId || list.closed) throw new Error('Target list moved or was archived');
    const card = cardSchema.parse(await this.request('/cards', 'POST', { idList: list.id, name: title, desc: description, idLabels: labels.join(',') }));
    if (card.idBoard !== this.config.trello.boardId || card.idList !== list.id) throw new Error('Unexpected board/list in created Trello card');
    return card;
  }
  async comment(cardId: string, text: string): Promise<void> {
    await this.assertWritable(cardId);
    actionSchema.parse(await this.request(`/cards/${trelloId.parse(cardId)}/actions/comments`, 'POST', { text }));
  }
}
