// The local replacement for Neon Realtime (local-factory port): the browser names a query file,
// a factory and the query's arguments over one WebSocket per tab; the server runs that file's one
// read-only SELECT and pushes its rows, then runs it again whenever Postgres notifies that a
// dashboard table changed (server/live-listen.ts), and on a short poll as a fallback. Rows are only
// pushed when they differ from the last rows that subscription saw.

import { liveParams } from './live-params';

/** Runs one read-only SELECT with its parameters and answers its rows. */
export type RunQuery = (sql: string, params: readonly string[]) => Promise<unknown[]>;

/** One browser connection, as the hub sees it: a socket it can send text frames to. */
export interface LiveSink {
  send(message: string): void;
}

export interface SubscribeRequest {
  id: string;
  query: string;
  factory: string;
  args?: unknown;
}

/** What the server sends a tab. `rows` and `error` name the subscription by the id the tab chose. */
export type ServerMessage =
  | { type: 'ready' }
  | { type: 'rows'; id: string; rows: unknown[] }
  | { type: 'error'; id: string; error: string };

/** What a tab sends the server. */
export type ClientMessage =
  | { type: 'subscribe'; id: string; query: string; factory: string; args?: string[] }
  | { type: 'unsubscribe'; id: string };

/**
 * JSON for the wire: a Date (Postgres timestamptz/date, as node-postgres decodes it) is sent as
 * `{"$date": "<ISO>"}`, which the browser turns back into a Date, so panels see the same values
 * Neon Realtime handed them.
 */
export function encodeRows(rows: unknown[]): string {
  return JSON.stringify(rows, function replacer(this: Record<string, unknown>, key, value) {
    const raw = this[key];
    if (raw instanceof Date) {
      return Number.isNaN(raw.getTime()) ? null : { $date: raw.toISOString() };
    }
    if (typeof raw === 'bigint') return raw.toString();
    return value;
  });
}

interface Entry {
  key: string;
  sql: string;
  params: string[];
  /** Every sink reading this query, with the subscription ids it chose for it. */
  readers: Map<LiveSink, Set<string>>;
  /** The rows last sent, encoded; undefined until the first answer. */
  last?: string;
  /** The error last sent, so a failing query is not reported again every refresh. */
  lastError?: string;
  running?: Promise<void>;
  /** A refresh asked for while this one ran: it runs again once this one ends. */
  again?: boolean;
}

export interface LiveHubOptions {
  run: RunQuery;
  queries: Map<string, string>;
  factories: readonly string[];
  /** How long after a change notification the hub waits for more before it refreshes. */
  debounceMs?: number;
  /** The fallback poll: every subscription is refreshed this often even with no notification. 0 turns it off. */
  pollMs?: number;
  log?: (line: string) => void;
}

/** What a tab is told when its query fails: no database text, as Realtime's safe mode gave none. */
export const QUERY_FAILED = 'the query failed';

export const DEFAULT_DEBOUNCE_MS = 100;
export const DEFAULT_POLL_MS = 15_000;

function rowsMessage(id: string, rows: string): string {
  return `{"type":"rows","id":${JSON.stringify(id)},"rows":${rows}}`;
}

function errorMessage(id: string, error: string): string {
  return JSON.stringify({ type: 'error', id, error } satisfies ServerMessage);
}

function safeSend(sink: LiveSink, message: string): void {
  try {
    sink.send(message);
  } catch {
    // A socket that closed mid-send is dropped when its close event arrives.
  }
}

export class LiveHub {
  private readonly entries = new Map<string, Entry>();
  /** Which entry each sink's subscription id reads, so an unsubscribe or a close finds it. */
  private readonly bySink = new Map<LiveSink, Map<string, string>>();
  private readonly run: RunQuery;
  private readonly queries: Map<string, string>;
  private readonly factories: readonly string[];
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly log: (line: string) => void;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;

  constructor(options: LiveHubOptions) {
    this.run = options.run;
    this.queries = options.queries;
    this.factories = options.factories;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** Starts the fallback poll. */
  start(): void {
    if (this.pollMs > 0 && this.poll === undefined) {
      this.poll = setInterval(() => void this.refresh(), this.pollMs);
    }
  }

  stop(): void {
    clearInterval(this.poll);
    clearTimeout(this.debounce);
    this.poll = undefined;
    this.debounce = undefined;
  }

  /** How many distinct queries are subscribed now, for health and tests. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Subscribes `sink` to a named query for a factory. Answers an error message's text when the
   * request is refused (unknown query, unknown factory, arguments that do not fit), else undefined.
   */
  subscribe(sink: LiveSink, request: SubscribeRequest): string | undefined {
    const sql = this.queries.get(request.query);
    if (sql === undefined) return 'unknown live query';
    if (!this.factories.includes(request.factory)) return 'unknown factory';
    const params = liveParams(sql, request.factory, request.args ?? []);
    if (!params) return 'wrong arguments for this query';
    this.unsubscribe(sink, request.id);
    const key = `${request.query} ${JSON.stringify(params)}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, sql, params, readers: new Map() };
      this.entries.set(key, entry);
    }
    let ids = entry.readers.get(sink);
    if (!ids) {
      ids = new Set();
      entry.readers.set(sink, ids);
    }
    ids.add(request.id);
    let mine = this.bySink.get(sink);
    if (!mine) {
      mine = new Map();
      this.bySink.set(sink, mine);
    }
    mine.set(request.id, key);
    if (entry.last !== undefined) {
      safeSend(sink, rowsMessage(request.id, entry.last));
    } else {
      if (entry.lastError !== undefined) safeSend(sink, errorMessage(request.id, QUERY_FAILED));
      void this.refreshEntry(entry);
    }
    return undefined;
  }

  /**
   * One answer of a named query, without subscribing: what a page shows first, over plain HTTP,
   * while its socket opens. The rows a live subscription last saw, when there is one, else a run
   * now. Answers the encoded rows, or the reason the request was refused or failed.
   */
  async snapshot(
    request: Omit<SubscribeRequest, 'id'>,
  ): Promise<{ rows: string } | { refused: string } | { failed: string }> {
    const sql = this.queries.get(request.query);
    if (sql === undefined) return { refused: 'unknown live query' };
    if (!this.factories.includes(request.factory)) return { refused: 'unknown factory' };
    const params = liveParams(sql, request.factory, request.args ?? []);
    if (!params) return { refused: 'wrong arguments for this query' };
    const live = this.entries.get(`${request.query} ${JSON.stringify(params)}`);
    if (live?.last !== undefined) return { rows: live.last };
    try {
      return { rows: encodeRows(await this.run(sql, params)) };
    } catch (error) {
      this.log(
        `live snapshot ${request.query} failed: ${error instanceof Error ? error.message : error}`,
      );
      return { failed: QUERY_FAILED };
    }
  }

  unsubscribe(sink: LiveSink, id: string): void {
    const mine = this.bySink.get(sink);
    const key = mine?.get(id);
    if (key === undefined) return;
    mine?.delete(id);
    const entry = this.entries.get(key);
    const ids = entry?.readers.get(sink);
    ids?.delete(id);
    if (entry && ids?.size === 0) entry.readers.delete(sink);
    if (entry && entry.readers.size === 0) this.entries.delete(key);
  }

  /** A closed socket: every subscription it held ends. */
  drop(sink: LiveSink): void {
    for (const id of [...(this.bySink.get(sink)?.keys() ?? [])]) this.unsubscribe(sink, id);
    this.bySink.delete(sink);
  }

  /** A dashboard table changed: every subscription is refreshed once the burst settles. */
  changed(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh();
    }, this.debounceMs);
  }

  /** Runs every subscribed query again and pushes the rows that changed. */
  async refresh(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.refreshEntry(entry)));
  }

  private refreshEntry(entry: Entry): Promise<void> {
    if (entry.running) {
      entry.again = true;
      return entry.running;
    }
    entry.running = (async () => {
      do {
        entry.again = false;
        await this.runEntry(entry);
      } while (entry.again && this.entries.get(entry.key) === entry);
    })().finally(() => {
      entry.running = undefined;
    });
    return entry.running;
  }

  private async runEntry(entry: Entry): Promise<void> {
    let encoded: string;
    try {
      encoded = encodeRows(await this.run(entry.sql, entry.params));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`live query ${entry.key} failed: ${reason}`);
      if (entry.lastError === reason) return;
      entry.lastError = reason;
      entry.last = undefined;
      for (const [sink, ids] of entry.readers) {
        for (const id of ids) safeSend(sink, errorMessage(id, QUERY_FAILED));
      }
      return;
    }
    entry.lastError = undefined;
    if (encoded === entry.last) return;
    entry.last = encoded;
    for (const [sink, ids] of entry.readers) {
      for (const id of ids) safeSend(sink, rowsMessage(id, encoded));
    }
  }
}

/** Parses one frame from a tab; undefined for anything that is not a well-formed message. */
export function parseClientMessage(data: unknown): ClientMessage | undefined {
  let message: unknown;
  try {
    message = JSON.parse(
      typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array),
    );
  } catch {
    return undefined;
  }
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 200) return undefined;
  if (m.type === 'unsubscribe') return { type: 'unsubscribe', id: m.id };
  if (m.type !== 'subscribe') return undefined;
  if (typeof m.query !== 'string' || typeof m.factory !== 'string') return undefined;
  if (m.args !== undefined && !Array.isArray(m.args)) return undefined;
  return {
    type: 'subscribe',
    id: m.id,
    query: m.query,
    factory: m.factory,
    ...(m.args !== undefined && { args: m.args as string[] }),
  };
}

/** Handles one frame from `sink`: a subscribe (refused ones answered with an error) or an unsubscribe. */
export function handleClientMessage(hub: LiveHub, sink: LiveSink, data: unknown): void {
  const message = parseClientMessage(data);
  if (!message) return;
  if (message.type === 'unsubscribe') {
    hub.unsubscribe(sink, message.id);
    return;
  }
  const refused = hub.subscribe(sink, message);
  if (refused !== undefined) safeSend(sink, errorMessage(message.id, refused));
}
