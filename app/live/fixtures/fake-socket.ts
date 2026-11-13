import type { SocketLike } from '../client';

type Listener = (event: { data?: unknown }) => void;

/**
 * A live socket for browser fixtures: it is open from the start and answers every subscribe with
 * `rowsFor(query, args)`'s rows (no rows when it answers undefined), as the server's live socket
 * does (server/live-hub.ts). `queries` records what was subscribed, in order.
 */
export class FakeLiveSocket implements SocketLike {
  readyState = 1;
  readonly queries: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(private rowsFor: (query: string, args: readonly string[]) => unknown[] | undefined) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    const message = JSON.parse(data) as {
      type: string;
      id: string;
      query: string;
      args?: string[];
    };
    if (message.type !== 'subscribe') return;
    this.queries.push(message.query);
    const rows = this.rowsFor(message.query, message.args ?? []) ?? [];
    queueMicrotask(() =>
      this.emit('message', { data: JSON.stringify({ type: 'rows', id: message.id, rows }) }),
    );
  }

  close(): void {
    this.readyState = 3;
  }
}
