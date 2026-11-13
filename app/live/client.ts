// The browser side of the local live layer (local-factory port; replaces @neon/realtime):
// one WebSocket per tab to the server's live socket, over which every panel subscribes to a query
// file by name. The server pushes the query's rows on subscribe and whenever they change. A
// dropped socket is reopened with a doubling wait and every subscription is sent again.

/** The part of a WebSocket the client uses, so tests and fixtures can hand it a fake. */
export interface SocketLike {
  readonly readyState: number;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export type OpenSocket = () => SocketLike;

export interface LiveRequest {
  query: string;
  factory: string;
  args?: readonly string[];
}

export interface LiveListener<Row> {
  rows(rows: readonly Row[]): void;
  error(message: string): void;
  /** The socket is gone and no rows can arrive until it is back. */
  lost?(): void;
}

export interface LiveClient {
  subscribe<Row>(request: LiveRequest, listener: LiveListener<Row>): () => void;
  close(): void;
}

const OPEN = 1;

/** The wait before reopening a dropped socket; it doubles to the ceiling and resets once open. */
export const RECONNECT_FIRST_MS = 500;
export const RECONNECT_CEILING_MS = 10_000;

/** Turns the server's `{"$date": iso}` back into the Date the panels read (server/live-hub.ts encodeRows). */
export function decodeRows(json: string): unknown {
  return JSON.parse(json, (_key, value) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.$date === 'string' &&
      Object.keys(value).length === 1
    ) {
      return new Date(value.$date);
    }
    return value;
  });
}

/** The live socket's address on the page's own host. */
export function socketUrl(path: string, location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}

type Subscription = {
  request: LiveRequest;
  listener: LiveListener<unknown>;
  /** The socket has answered: a snapshot arriving after that is older, and dropped. */
  answered?: boolean;
};

/** One answer of a query over plain HTTP (the server's `POST /api/live/:name`), or undefined. */
export type Snapshot = (request: LiveRequest) => Promise<readonly unknown[] | undefined>;

/** The page's own server's snapshot route. */
export const httpSnapshot: Snapshot = async ({ query, factory, args }) => {
  const res = await fetch(`/api/live/${encodeURIComponent(query)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ factory, ...(args && { args }) }),
  });
  if (!res.ok) return undefined;
  const answer = decodeRows(await res.text()) as { rows?: unknown };
  return Array.isArray(answer.rows) ? answer.rows : undefined;
};

/**
 * The tab's live client over the socket `open` makes. With `snapshot`, each subscription also asks
 * for its rows once over HTTP, so a page paints them while its socket is still opening; the socket's
 * rows win from then on.
 */
export function createLiveClient(
  open: OpenSocket,
  {
    wait = (ms: number, then: () => void) => setTimeout(then, ms),
    snapshot,
  }: { wait?: (ms: number, then: () => void) => unknown; snapshot?: Snapshot } = {},
): LiveClient {
  const subscriptions = new Map<string, Subscription>();
  let next = 0;
  let socket: SocketLike | undefined;
  let closed = false;
  let delay = 0;

  const send = (message: object) => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
  };
  const subscribeMessage = (id: string, { request }: Subscription) => ({
    type: 'subscribe',
    id,
    query: request.query,
    factory: request.factory,
    ...(request.args && { args: [...request.args] }),
  });

  const connect = () => {
    if (closed) return;
    const current = open();
    socket = current;
    let opened = false;
    const onOpen = () => {
      if (opened || socket !== current) return;
      opened = true;
      delay = 0;
      for (const [id, subscription] of subscriptions) send(subscribeMessage(id, subscription));
    };
    current.addEventListener('open', onOpen);
    // A socket handed over already open (a fixture's fake) fires no `open`.
    if (current.readyState === OPEN) queueMicrotask(onOpen);
    current.addEventListener('message', ({ data }) => {
      if (socket !== current) return;
      let message: { type?: string; id?: string; rows?: unknown; error?: string };
      try {
        message = decodeRows(String(data)) as typeof message;
      } catch {
        return;
      }
      const subscription = message.id === undefined ? undefined : subscriptions.get(message.id);
      if (!subscription) return;
      if (message.type === 'rows' && Array.isArray(message.rows)) {
        subscription.answered = true;
        subscription.listener.rows(message.rows);
      } else if (message.type === 'error') {
        subscription.answered = true;
        subscription.listener.error(String(message.error ?? 'the query failed'));
      }
    });
    let ended = false;
    const end = () => {
      if (ended || socket !== current) return;
      ended = true;
      socket = undefined;
      for (const { listener } of subscriptions.values()) listener.lost?.();
      if (closed) return;
      delay = Math.min(RECONNECT_CEILING_MS, Math.max(RECONNECT_FIRST_MS, delay * 2));
      wait(delay, connect);
    };
    current.addEventListener('close', end);
    current.addEventListener('error', end);
  };

  connect();

  return {
    subscribe<Row>(request: LiveRequest, listener: LiveListener<Row>) {
      next += 1;
      const id = `s${next}`;
      const subscription: Subscription = { request, listener: listener as LiveListener<unknown> };
      subscriptions.set(id, subscription);
      send(subscribeMessage(id, subscription));
      snapshot?.(request).then(
        (rows) => {
          if (rows && !subscription.answered && subscriptions.get(id) === subscription) {
            subscription.listener.rows(rows);
          }
        },
        () => {},
      );
      return () => {
        if (!subscriptions.delete(id)) return;
        send({ type: 'unsubscribe', id });
      };
    },
    close() {
      closed = true;
      subscriptions.clear();
      socket?.close();
      socket = undefined;
    },
  };
}
