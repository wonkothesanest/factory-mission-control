import { expect, test } from 'bun:test';
import {
  createLiveClient,
  RECONNECT_CEILING_MS,
  RECONNECT_FIRST_MS,
  type SocketLike,
} from './client';
import { type Live, OFFLINE_AFTER_MS, shareLive } from './LiveProvider';

type Listener = (event: { data?: unknown }) => void;

/** A socket the test drives: it records what the client sends and fires what the test says. */
class TestSocket implements SocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, data?: unknown) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.fire('close');
  }
}

function harness() {
  const sockets: TestSocket[] = [];
  const waits: { ms: number; then: () => void }[] = [];
  const client = createLiveClient(
    () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
    { wait: (ms, then) => waits.push({ ms, then }) },
  );
  return { client, sockets, waits };
}

test('subscriptions made before the socket opens are sent once it does, with their arguments', () => {
  const { client, sockets } = harness();
  client.subscribe({ query: 'status-strip', factory: 'f' }, { rows: () => {}, error: () => {} });
  client.subscribe(
    { query: 'step-detail', factory: 'f', args: ['wf', 'review', ''] },
    { rows: () => {}, error: () => {} },
  );
  expect(sockets[0]?.sent).toEqual([]);
  sockets[0]?.fire('open');
  expect(sockets[0]?.sent).toEqual([
    { type: 'subscribe', id: 's1', query: 'status-strip', factory: 'f' },
    { type: 'subscribe', id: 's2', query: 'step-detail', factory: 'f', args: ['wf', 'review', ''] },
  ]);
});

test('rows and errors reach only the subscription they name, with timestamps as Date', () => {
  const { client, sockets } = harness();
  const seen: unknown[] = [];
  client.subscribe(
    { query: 'a', factory: 'f' },
    { rows: (r) => seen.push(['a', r]), error: (e) => seen.push(['a!', e]) },
  );
  client.subscribe(
    { query: 'b', factory: 'f' },
    { rows: (r) => seen.push(['b', r]), error: () => {} },
  );
  const socket = sockets[0] as TestSocket;
  socket.fire('open');
  socket.fire(
    'message',
    JSON.stringify({
      type: 'rows',
      id: 's2',
      rows: [{ at: { $date: '2026-11-12T00:00:00.000Z' } }],
    }),
  );
  socket.fire('message', JSON.stringify({ type: 'error', id: 's1', error: 'the query failed' }));
  socket.fire('message', 'garbage');
  expect(seen).toEqual([
    ['b', [{ at: new Date('2026-11-12T00:00:00.000Z') }]],
    ['a!', 'the query failed'],
  ]);
});

test('an unsubscribe is sent and its rows are no longer delivered', () => {
  const { client, sockets } = harness();
  const seen: unknown[] = [];
  const stop = client.subscribe(
    { query: 'a', factory: 'f' },
    { rows: (r) => seen.push(r), error: () => {} },
  );
  const socket = sockets[0] as TestSocket;
  socket.fire('open');
  stop();
  stop();
  socket.fire('message', JSON.stringify({ type: 'rows', id: 's1', rows: [] }));
  expect(seen).toEqual([]);
  expect(socket.sent.at(-1)).toEqual({ type: 'unsubscribe', id: 's1' });
  expect(socket.sent.filter((m) => m.type === 'unsubscribe')).toHaveLength(1);
});

test('a dropped socket tells every subscription, reopens after a doubling wait and subscribes again', () => {
  const { client, sockets, waits } = harness();
  let lost = 0;
  client.subscribe(
    { query: 'a', factory: 'f' },
    { rows: () => {}, error: () => {}, lost: () => lost++ },
  );
  sockets[0]?.fire('open');
  sockets[0]?.fire('close');
  expect(lost).toBe(1);
  expect(waits.map((w) => w.ms)).toEqual([RECONNECT_FIRST_MS]);
  waits[0]?.then();
  sockets[1]?.fire('error');
  waits[1]?.then();
  expect(waits.map((w) => w.ms)).toEqual([RECONNECT_FIRST_MS, RECONNECT_FIRST_MS * 2]);
  sockets[2]?.fire('open');
  expect(sockets[2]?.sent).toEqual([{ type: 'subscribe', id: 's1', query: 'a', factory: 'f' }]);
  for (let i = 0; i < 10; i++) {
    const socket = sockets.at(-1) as TestSocket;
    socket.fire('close');
    waits.at(-1)?.then();
  }
  expect(Math.max(...waits.map((w) => w.ms))).toBe(RECONNECT_CEILING_MS);
});

test('a snapshot paints first, and is dropped once the socket has answered', async () => {
  const delivered: unknown[] = [];
  let release: (rows: unknown[]) => void = () => {};
  const late = new Promise<unknown[]>((ok) => {
    release = ok;
  });
  const sockets: TestSocket[] = [];
  const client = createLiveClient(
    () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
    {
      wait: () => {},
      snapshot: async ({ query }) => (query === 'early' ? [{ from: 'http' }] : late),
    },
  );
  client.subscribe(
    { query: 'early', factory: 'f' },
    { rows: (r) => delivered.push(r), error: () => {} },
  );
  client.subscribe(
    { query: 'late', factory: 'f' },
    { rows: (r) => delivered.push(r), error: () => {} },
  );
  await Bun.sleep(1);
  expect(delivered).toEqual([[{ from: 'http' }]]);
  const socket = sockets[0] as TestSocket;
  socket.fire('open');
  socket.fire('message', JSON.stringify({ type: 'rows', id: 's2', rows: [{ from: 'socket' }] }));
  release([{ from: 'stale http' }]);
  await Bun.sleep(1);
  expect(delivered).toEqual([[{ from: 'http' }], [{ from: 'socket' }]]);
});

test('a closed client opens no new socket', () => {
  const { client, sockets, waits } = harness();
  client.close();
  expect(sockets).toHaveLength(1);
  expect(waits).toEqual([]);
});

test('with the configuration in the page the provider is ready at once, and closes its client on cleanup', () => {
  const states: Live[] = [];
  let closed = false;
  const stop = shareLive(
    { factories: ['x'] },
    (live) => states.push(live),
    () => ({
      subscribe: () => () => {},
      close: () => {
        closed = true;
      },
    }),
  );
  expect(states.map((s) => s.status)).toEqual(['ready']);
  expect(states[0]?.status === 'ready' && states[0].factories).toEqual(['x']);
  stop();
  expect(closed).toBe(true);
});

test('without it the provider asks GET /api/live and reports an error when that fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response('no', { status: 503 }), {
    preconnect: original.preconnect,
  });
  try {
    const states: Live[] = [];
    shareLive(undefined, (live) => states.push(live));
    await Bun.sleep(10);
    expect(states.map((s) => s.status)).toEqual(['error']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a socket down OFFLINE_AFTER_MS is published offline, and online the moment it opens again', () => {
  const states: Live[] = [];
  const timers: { ms: number; then: () => void; cleared: boolean }[] = [];
  let report: (event: 'up' | 'down') => void = () => {};
  shareLive(
    { factories: ['x'] },
    (live) => states.push(live),
    (_boot, connection) => {
      report = connection;
      return { subscribe: () => () => {}, close: () => {} };
    },
    (ms, then) => {
      const timer = { ms, then, cleared: false };
      timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
  );
  const offline = () => states.map((s) => s.status === 'ready' && s.offline);
  expect(offline()).toEqual([false]);
  report('down');
  report('down');
  expect(timers.map((t) => t.ms)).toEqual([OFFLINE_AFTER_MS]);
  // A socket back before the wait ends never shows offline.
  report('up');
  expect(timers[0]?.cleared).toBe(true);
  expect(offline()).toEqual([false]);
  report('down');
  timers[1]?.then();
  expect(offline()).toEqual([false, true]);
  report('up');
  expect(offline()).toEqual([false, true, false]);
});

test('the client reports up on each open and down on each loss, but not on close()', () => {
  const sockets: TestSocket[] = [];
  const events: string[] = [];
  const client = createLiveClient(
    () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
    { wait: (_ms, then) => then(), connection: (event) => events.push(event) },
  );
  sockets[0]?.fire('open');
  sockets[0]?.fire('close');
  sockets[1]?.fire('open');
  client.close();
  expect(events).toEqual(['up', 'down', 'up']);
});
