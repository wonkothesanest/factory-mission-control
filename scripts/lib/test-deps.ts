import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub, type GetFetch } from '../../function/github';
import { CHECK_ENV_FILE, type Env } from '../../server/check-env';
import type { RunStatus } from './archon-run';
import type { Deps } from './cli';
import type { Db, Row } from './db';
import type { TakePassLock } from './pass-lock';

/** A root no request can reach: the fake GitHub below answers nothing. */
const UNREACHABLE_ROOT = 'http://forge.invalid';

export const NOW = new Date('2026-10-24T12:00:00Z');

export function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

/** A connection string the fake resolves to `branchName`'s database (local-factory port). */
export const DATABASE_URL = 'postgresql://u:p@127.0.0.1:55432/factory';

/** An in-memory pass lock: undefined while `job` on `url` is held, until its `release`. */
export function memoryPassLock(): TakePassLock {
  const held = new Set<string>();
  return async (url, job) => {
    const key = `${url}\n${job}`;
    if (held.has(key)) return undefined;
    held.add(key);
    return { release: async () => void held.delete(key) };
  };
}

export type Recorder = {
  deps: Deps;
  /** Every connection string whose database a command asked the name of, in order. */
  resolved: string[];
  /** Every GitHub URL requested; the fake answers none of them. */
  githubCalls: string[];
  opened: string[];
  sql: string[];
  /** Every request a command sent through `deps.fetch`, as `<method> <url>`. */
  requests: string[];
  /** Each query's parameters, in the order `sql` holds its text. */
  params: (unknown[] | undefined)[];
  /** Every run a command asked Archon about, in order. */
  runStatusCalls: string[];
  out: string[];
  err: string[];
};

export function scratchRepo(checkEnv?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-scripts-'));
  if (checkEnv) {
    writeFileSync(
      join(dir, CHECK_ENV_FILE),
      Object.entries(checkEnv)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  return dir;
}

/**
 * Deps where every connection string names database `branchName` (a check database, `check-*`, or
 * the live one), over a database that answers every query with `rows(sql)`. Every call is recorded.
 */
export function recordingDeps(options: {
  repoRoot: string;
  env?: Env;
  branchName?: string;
  rows?: (sql: string) => Row[];
  owner?: boolean;
  /** Answers `deps.fetch`; without it every request fails, as with no network. */
  fetch?: GetFetch;
  /** Answers `deps.runStatus`; without it Archon cannot be asked, so no run is ever judged ended. */
  runStatus?: (run: string) => RunStatus;
  /** The single-pass lock; defaults to a fresh `memoryPassLock()`. */
  passLock?: TakePassLock;
}): Recorder {
  const recorder: Omit<Recorder, 'deps'> = {
    resolved: [],
    githubCalls: [],
    opened: [],
    sql: [],
    requests: [],
    params: [],
    runStatusCalls: [],
    out: [],
    err: [],
  };
  const rows = options.rows ?? (() => []);
  const db: Db = {
    async query(sql, params) {
      recorder.sql.push(sql);
      recorder.params.push(params);
      return rows(sql);
    },
    async transaction(fn) {
      await fn(db);
    },
    async close() {},
  };
  const deps: Deps = {
    env: { ...options.env },
    repoRoot: options.repoRoot,
    databaseName: async (url) => {
      recorder.resolved.push(url);
      return options.branchName ?? 'check-abc';
    },
    github: () =>
      createGitHub(async (url) => {
        recorder.githubCalls.push(url);
        throw new Error(`fake GitHub: no response for ${url}`);
      }, UNREACHABLE_ROOT),
    passLock: options.passLock ?? memoryPassLock(),
    openDb: (url) => {
      recorder.opened.push(url);
      return db;
    },
    fetch: async (url, init) => {
      recorder.requests.push(`${init.method} ${url}`);
      if (!options.fetch) throw new Error(`fake network: no route to ${url}`);
      return options.fetch(url, init);
    },
    now: () => NOW,
    sleep: async () => {},
    out: (line) => recorder.out.push(line),
    err: (line) => recorder.err.push(line),
    confirmOwner: () => options.owner ?? false,
    runStatus: async (run) => {
      recorder.runStatusCalls.push(run);
      return options.runStatus?.(run) ?? { state: 'unknown', reason: 'fake Archon: no answer' };
    },
  };
  return { ...recorder, deps };
}
