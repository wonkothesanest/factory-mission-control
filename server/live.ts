// Live queries on the factory's own Postgres (local-factory port; Neon Realtime removed).
//
// The browser opens one WebSocket per tab at LIVE_SOCKET_PATH and subscribes to query files by
// name, for a factory, with the query's arguments; it never sends SQL. The server runs each file
// as one read-only SELECT on a read-only pool and pushes the rows (server/live-hub.ts), and runs it
// again when a dashboard table NOTIFYs a change (server/live-listen.ts) or the fallback poll fires.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import pg from 'pg';
import type { Env } from './check-env';
import { readFactoryNames } from './factories';
import { DEFAULT_POLL_MS, LiveHub, type RunQuery } from './live-hub';
import { type ListenHandle, listenForChanges } from './live-listen';

export { liveParams, parameterCount } from './live-params';

export const LIVE_QUERY_NAME = /^[a-z0-9-]+$/;

/** Where a tab opens its live socket. */
export const LIVE_SOCKET_PATH = '/api/live/socket';

/** What the server needs to serve live queries; absent when it has no database. */
export interface Live {
  /** The factories this server shows and serves queries for, from its factories file. */
  factories: string[];
  /** Every file in `db/queries/` by its name without `.sql`: the only SQL the server runs. */
  queries: Map<string, string>;
  hub: LiveHub;
  /** The change feed, absent in tests that drive the hub by hand. */
  listen?: ListenHandle;
  close(): Promise<void>;
}

/** The one directory of live queries, for the page, the Manager's tools and the briefing alike. */
export const LIVE_QUERIES_DIR = join(import.meta.dir, '..', 'db', 'queries');

export function loadLiveQueries(dir: string): Map<string, string> {
  const queries = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const name = file.slice(0, -'.sql'.length);
    if (!LIVE_QUERY_NAME.test(name)) throw new Error(`live query file name ${file} is not allowed`);
    queries.set(name, readFileSync(join(dir, file), 'utf-8').trim());
  }
  return queries;
}

/**
 * The factories file: `MC_FACTORIES_FILE` when set (a check's own list), else the repository's
 * factories.json. Only its names are shown and served: a row of `mc.factories` the file does not
 * name is never listed, so one entry means one factory.
 */
export function factoryNames(env: Env, repoRoot: string): string[] {
  return readFactoryNames(env, repoRoot);
}

/** Postgres interval has no Realtime decoding: it reaches the browser as its text, as it did. */
const INTERVAL_OID = 1186;

/**
 * A read-only pool for live queries. node-postgres decodes values the way Neon Realtime's client
 * did (its parsers "match node-postgres"): int8 and numeric as strings, timestamps and dates as
 * Date, json as values.
 */
export function liveQueryRunner(databaseUrl: string): { run: RunQuery; end: () => Promise<void> } {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    application_name: 'mission-control-live',
    options: '-c default_transaction_read_only=on -c statement_timeout=15000',
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        oid === INTERVAL_OID
          ? (value: string) => value
          : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
  pool.on('error', (error) => console.error(`live query pool: ${error.message}`));
  return {
    run: async (sql, params) => (await pool.query(sql, [...params])).rows,
    end: () => pool.end(),
  };
}

function pollMs(env: Env): number {
  const raw = env.MC_LIVE_POLL_MS;
  if (raw === undefined || raw === '') return DEFAULT_POLL_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0)
    throw new Error('MC_LIVE_POLL_MS must be a whole number of ms');
  return ms;
}

/** The live layer over `MC_DATABASE_URL`, or undefined without one. */
export function liveFromEnv(env: Env, repoRoot: string): Live | undefined {
  const databaseUrl = env.MC_DATABASE_URL;
  if (!databaseUrl) return undefined;
  const runner = liveQueryRunner(databaseUrl);
  const hub = new LiveHub({
    run: runner.run,
    queries: loadLiveQueries(LIVE_QUERIES_DIR),
    factories: factoryNames(env, repoRoot),
    pollMs: pollMs(env),
  });
  hub.start();
  const listen = listenForChanges(databaseUrl, () => hub.changed());
  return {
    factories: factoryNames(env, repoRoot),
    queries: loadLiveQueries(LIVE_QUERIES_DIR),
    hub,
    listen,
    async close() {
      hub.stop();
      await listen.stop();
      await runner.end();
    },
  };
}

/** What `GET /api/live` answers and the page's boot script carries: no secret, no connection string. */
export function liveConfig(live: Live) {
  return { factories: live.factories, socket: LIVE_SOCKET_PATH };
}

export type LiveConfig = ReturnType<typeof liveConfig>;

const NOT_CONFIGURED = { error: 'live queries are not configured' };

export function liveRoutes(app: Hono, live: Live | undefined): void {
  app.get('/api/live', (c) => {
    if (!live) return c.json(NOT_CONFIGURED, 503);
    return c.json({
      ...liveConfig(live),
      listening: live.listen?.connected() ?? false,
      subscribed: live.hub.size,
    });
  });

  // A query's rows once, for a page's first paint while its socket opens. The browser names a
  // query file, a factory and the query's arguments after $1; it never sends SQL.
  app.post('/api/live/:name', async (c) => {
    if (!live) return c.json(NOT_CONFIGURED, 503);
    const body: unknown = await c.req.json().catch(() => undefined);
    const field = (key: string) =>
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)[key]
        : undefined;
    const factory = field('factory');
    if (typeof factory !== 'string') return c.json({ error: 'unknown factory' }, 400);
    const answer = await live.hub.snapshot({
      query: c.req.param('name'),
      factory,
      args: field('args'),
    });
    if ('refused' in answer) {
      return c.json({ error: answer.refused }, answer.refused === 'unknown live query' ? 404 : 400);
    }
    if ('failed' in answer) return c.json({ error: answer.failed }, 502);
    return c.body(`{"rows":${answer.rows}}`, 200, { 'content-type': 'application/json' });
  });
}

/**
 * An inline script for `index.html`: it hands the browser what `GET /api/live` answers, so the
 * app opens its socket without asking first.
 */
export function liveBootScript(config: LiveConfig): string {
  const boot = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<script>window.__MC_LIVE__=${boot}</script>`;
}
