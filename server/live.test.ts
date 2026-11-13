import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeRows } from '../app/live/client';
import { createApp } from './app';
import {
  factoryNames,
  LIVE_SOCKET_PATH,
  type Live,
  liveBootScript,
  liveParams,
  loadLiveQueries,
} from './live';
import { encodeRows, handleClientMessage, LiveHub, type LiveSink, QUERY_FAILED } from './live-hub';
import { sameOrigin, serve } from './serve';

const repoRoot = resolve(import.meta.dir, '..');
const queries = loadLiveQueries(join(repoRoot, 'db', 'queries'));
let distDir: string;

beforeAll(() => {
  distDir = join(mkdtempSync(join(tmpdir(), 'mc-live-')), 'dist');
  mkdirSync(distDir, { recursive: true });
  copyFileSync(join(repoRoot, 'app', 'index.html'), join(distDir, 'index.html'));
});

afterAll(() => rmSync(resolve(distDir, '..'), { recursive: true, force: true }));

/** A hub whose database answers `answer(sql, params)` and records every query it ran. */
function fakeHub(answer: (sql: string, params: readonly string[]) => unknown[] = () => []) {
  const ran: [string, readonly string[]][] = [];
  const hub = new LiveHub({
    run: async (sql, params) => {
      ran.push([sql, params]);
      return answer(sql, params);
    },
    queries,
    factories: ['mission-control'],
    pollMs: 0,
    debounceMs: 5,
    log: () => {},
  });
  return { hub, ran };
}

/** A sink that keeps every frame the hub sends it, parsed as the browser parses it. */
function sink() {
  const frames: { type: string; id?: string; rows?: unknown[]; error?: string }[] = [];
  const s: LiveSink & { frames: typeof frames } = {
    frames,
    send: (message) => frames.push(decodeRows(message) as (typeof frames)[number]),
  };
  return s;
}

const settle = () => Bun.sleep(20);

function fakeLive(hub: LiveHub): Live {
  return { factories: ['mission-control'], queries, hub, close: async () => {} };
}

describe('the live hub', () => {
  test('runs a named query with the factory as $1 and pushes its rows to the subscriber', async () => {
    const { hub, ran } = fakeHub(() => [{ running: 2 }]);
    const tab = sink();
    expect(hub.subscribe(tab, { id: 'a', query: 'status-strip', factory: 'mission-control' })).toBe(
      undefined,
    );
    await settle();
    expect(ran).toEqual([[queries.get('status-strip') as string, ['mission-control']]]);
    expect(tab.frames).toEqual([{ type: 'rows', id: 'a', rows: [{ running: 2 }] }]);
  });

  test('refuses an unknown query, an unknown factory and arguments that do not fit, running nothing', async () => {
    const { hub, ran } = fakeHub();
    const tab = sink();
    expect(hub.subscribe(tab, { id: 'a', query: 'nope', factory: 'mission-control' })).toBe(
      'unknown live query',
    );
    expect(hub.subscribe(tab, { id: 'a', query: 'status-strip', factory: 'other' })).toBe(
      'unknown factory',
    );
    expect(
      hub.subscribe(tab, {
        id: 'a',
        query: 'status-strip',
        factory: 'mission-control',
        args: ['x'],
      }),
    ).toBe('wrong arguments for this query');
    await settle();
    expect(ran).toEqual([]);
  });

  test('a change notification re-runs the query and pushes only rows that differ', async () => {
    let running = 1;
    const { hub } = fakeHub(() => [{ running }]);
    const tab = sink();
    hub.subscribe(tab, { id: 'a', query: 'status-strip', factory: 'mission-control' });
    await settle();
    hub.changed();
    await settle();
    expect(tab.frames).toHaveLength(1);
    running = 3;
    hub.changed();
    hub.changed();
    await settle();
    expect(tab.frames.map((f) => f.rows)).toEqual([[{ running: 1 }], [{ running: 3 }]]);
  });

  test('two tabs on the same query share one run, and an unsubscribed tab hears nothing more', async () => {
    let n = 0;
    const { hub, ran } = fakeHub(() => [{ n: ++n }]);
    const one = sink();
    const two = sink();
    hub.subscribe(one, { id: 'a', query: 'status-strip', factory: 'mission-control' });
    await settle();
    hub.subscribe(two, { id: 'b', query: 'status-strip', factory: 'mission-control' });
    expect(two.frames).toEqual([{ type: 'rows', id: 'b', rows: [{ n: 1 }] }]);
    hub.unsubscribe(one, 'a');
    await hub.refresh();
    expect(ran).toHaveLength(2);
    expect(one.frames).toHaveLength(1);
    expect(two.frames.at(-1)).toEqual({ type: 'rows', id: 'b', rows: [{ n: 2 }] });
    hub.drop(two);
    expect(hub.size).toBe(0);
  });

  test('a failing query sends no database text, once, and its rows again once it recovers', async () => {
    let fail = true;
    const { hub } = fakeHub(() => {
      if (fail) throw new Error('relation "mc.secret_table" does not exist');
      return [{ ok: true }];
    });
    const tab = sink();
    hub.subscribe(tab, { id: 'a', query: 'status-strip', factory: 'mission-control' });
    await settle();
    await hub.refresh();
    expect(tab.frames).toEqual([{ type: 'error', id: 'a', error: QUERY_FAILED }]);
    fail = false;
    await hub.refresh();
    expect(tab.frames.at(-1)).toEqual({ type: 'rows', id: 'a', rows: [{ ok: true }] });
  });

  test('timestamps reach the browser as Date and int8/numeric stay text, as Neon Realtime gave them', () => {
    const at = new Date('2026-11-12T10:00:00.123Z');
    const decoded = decodeRows(encodeRows([{ at, cost: '0.4213', n: '42', j: { a: [1] } }]));
    expect(decoded).toEqual([{ at, cost: '0.4213', n: '42', j: { a: [1] } }]);
    expect((decoded as { at: Date }[])[0]?.at).toBeInstanceOf(Date);
  });

  test('a malformed frame is ignored and a refused subscribe is answered with its reason', () => {
    const { hub } = fakeHub();
    const tab = sink();
    handleClientMessage(hub, tab, 'not json');
    handleClientMessage(hub, tab, JSON.stringify({ type: 'subscribe', id: 'x', query: 1 }));
    handleClientMessage(
      hub,
      tab,
      JSON.stringify({ type: 'subscribe', id: 'x', query: 'nope', factory: 'mission-control' }),
    );
    expect(tab.frames).toEqual([{ type: 'error', id: 'x', error: 'unknown live query' }]);
  });
});

describe('liveParams', () => {
  test('the factory, then exactly the arguments the query takes after $1', () => {
    expect(liveParams('SELECT $1, $3', 'f', ['a', 'b'])).toEqual(['f', 'a', 'b']);
    expect(liveParams('SELECT $1', 'f', ['a'])).toBeUndefined();
    expect(liveParams('SELECT $1, $2', 'f', [1])).toBeUndefined();
  });
});

describe('the live socket', () => {
  test('a tab subscribes over the WebSocket and gets its rows, then a change', async () => {
    let running = 1;
    const { hub } = fakeHub(() => [{ running, at: new Date('2026-11-12T00:00:00Z') }]);
    const live = fakeLive(hub);
    const server = serve({
      app: createApp({ buildId: 'test', distDir, live }),
      live,
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      const frames: { type: string; rows?: { running: number; at: Date }[] }[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}${LIVE_SOCKET_PATH}`);
      socket.addEventListener('message', (e) => frames.push(decodeRows(String(e.data)) as never));
      await new Promise((ok) => socket.addEventListener('open', ok));
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          id: 's1',
          query: 'status-strip',
          factory: 'mission-control',
        }),
      );
      const until = async (n: number) => {
        for (let i = 0; i < 200 && frames.length < n; i++) await Bun.sleep(10);
      };
      await until(2);
      running = 2;
      hub.changed();
      await until(3);
      socket.close();
      expect(frames[0]).toEqual({ type: 'ready' });
      expect(frames.slice(1).map((f) => f.rows?.[0]?.running)).toEqual([1, 2]);
      expect(frames[1]?.rows?.[0]?.at).toBeInstanceOf(Date);
    } finally {
      server.stop(true);
    }
  });

  test('a page from another origin cannot open the socket', () => {
    const at = (origin: string | null) =>
      new Request('http://127.0.0.1:3092/api/live/socket', {
        headers: { host: '127.0.0.1:3092', ...(origin && { origin }) },
      });
    expect(sameOrigin(at(null))).toBe(true);
    expect(sameOrigin(at('http://127.0.0.1:3092'))).toBe(true);
    expect(sameOrigin(at('http://evil.example'))).toBe(false);
  });

  test('without live configuration the socket answers 503', async () => {
    const server = serve({
      app: createApp({ buildId: 'test', distDir }),
      live: undefined,
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${LIVE_SOCKET_PATH}`);
      expect(res.status).toBe(503);
    } finally {
      server.stop(true);
    }
  });
});

describe('factoryNames', () => {
  test("factories.json's names, unless MC_FACTORIES_FILE names another file", () => {
    expect(factoryNames({}, repoRoot)).toEqual(
      (
        JSON.parse(readFileSync(join(repoRoot, 'factories.json'), 'utf-8')) as {
          factories: { name: string }[];
        }
      ).factories.map((f) => f.name),
    );
    const file = join(resolve(distDir, '..'), 'factories.json');
    writeFileSync(file, JSON.stringify({ factories: [{ name: 'a' }, { name: 'b' }] }));
    expect(factoryNames({ MC_FACTORIES_FILE: file }, repoRoot)).toEqual(['a', 'b']);
  });

  test.each([
    null,
    [[]],
    {},
    { factories: null },
    { factories: {} },
    { factories: [null] },
    { factories: [[]] },
    { factories: [123] },
    { factories: [{}] },
    { factories: [{ name: 123 }] },
  ])('rejects malformed served configuration %j', (config) => {
    const file = join(resolve(distDir, '..'), 'factories.json');
    writeFileSync(file, JSON.stringify(config));
    expect(() => factoryNames({ MC_FACTORIES_FILE: file }, repoRoot)).toThrow(
      'Invalid factories configuration:',
    );
  });
});

/** The configuration the inline script in the page hands the app. */
function bootConfig(html: string): unknown {
  const match = /<head><script>window\.__MC_LIVE__=(\{.*?\})<\/script>/.exec(html);
  return match ? JSON.parse(match[1] as string) : undefined;
}

describe('POST /api/live/:name, a first-paint snapshot', () => {
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('answers the named query for a known factory, timestamps encoded as for the socket', async () => {
    const { hub, ran } = fakeHub(() => [{ running: 1, at: new Date('2026-11-12T00:00:00Z') }]);
    const app = createApp({ buildId: 'test', distDir, live: fakeLive(hub) });
    const res = await app.request('/api/live/status-strip', post({ factory: 'mission-control' }));
    expect(res.status).toBe(200);
    const answer = decodeRows(await res.text()) as { rows: { at: Date }[] };
    expect(answer.rows[0]?.at).toEqual(new Date('2026-11-12T00:00:00Z'));
    expect(ran).toEqual([[queries.get('status-strip') as string, ['mission-control']]]);
  });

  test('an unknown query is a 404, an unknown factory or wrong arguments a 400, and none runs', async () => {
    const { hub, ran } = fakeHub();
    const app = createApp({ buildId: 'test', distDir, live: fakeLive(hub) });
    expect((await app.request('/api/live/nope', post({ factory: 'mission-control' }))).status).toBe(
      404,
    );
    expect((await app.request('/api/live/status-strip', post({ factory: 'x' }))).status).toBe(400);
    expect((await app.request('/api/live/status-strip', post({}))).status).toBe(400);
    expect(
      (
        await app.request(
          '/api/live/status-strip',
          post({ factory: 'mission-control', args: ['extra'] }),
        )
      ).status,
    ).toBe(400);
    expect(ran).toEqual([]);
  });

  test('a failing query is a 502 with no database text', async () => {
    const { hub } = fakeHub(() => {
      throw new Error('relation "mc.x" does not exist');
    });
    const app = createApp({ buildId: 'test', distDir, live: fakeLive(hub) });
    const res = await app.request('/api/live/status-strip', post({ factory: 'mission-control' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: QUERY_FAILED });
  });
});

describe('the page the server answers', () => {
  const app = () => createApp({ buildId: 'test', distDir, live: fakeLive(fakeHub().hub) });

  test('carries what GET /api/live answers: the factories and the socket path, no secret', async () => {
    const res = await app().request('/');
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(bootConfig(html)).toEqual({ factories: ['mission-control'], socket: LIVE_SOCKET_PATH });
    expect(html).toContain('<div id="root"></div>');
    const api = (await (await app().request('/api/live')).json()) as Record<string, unknown>;
    expect(api.factories).toEqual(['mission-control']);
    expect(api.socket).toBe(LIVE_SOCKET_PATH);
  });

  test('a client-side route gets the same page', async () => {
    expect(bootConfig(await (await app().request('/runs')).text())).toBeDefined();
  });

  test('a factory name cannot end the script', () => {
    const script = liveBootScript({ factories: ['</script><b>'], socket: LIVE_SOCKET_PATH });
    expect(script.indexOf('</script>')).toBe(script.length - '</script>'.length);
  });
});

describe('without live configuration', () => {
  const app = () => createApp({ buildId: 'test', distDir });

  test('the page carries no live configuration', async () => {
    const html = await (await app().request('/')).text();
    expect(html).not.toContain('__MC_LIVE__');
  });

  test('the live routes are 503, the removed rewind routes are gone, and health stays 200', async () => {
    expect((await app().request('/api/live')).status).toBe(503);
    expect((await app().request('/api/live/status-strip', { method: 'POST' })).status).toBe(503);
    expect((await app().request('/api/rewind', { method: 'POST' })).status).toBe(404);
    expect((await app().request('/api/rewind/branches')).status).toBe(404);
    expect((await app().request('/api/health')).status).toBe(200);
  });
});
