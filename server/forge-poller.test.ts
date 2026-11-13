// Local forge ingestion (local-factory port): the poller reads a forge SQLite file read-only
// and stores what it holds through the forge seam, as GitHub's webhook deliveries would have.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archonDb, snapshot } from '../db/test-db';
import { openForge } from '../function/forge-local';
import { gitAuthoredAt } from '../function/local-pins';
import type { Db, Tx } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createForgePoller, forgePollerFromEnv } from './forge-poller';

const repoRoot = resolve(import.meta.dir, '..');
const WIDGETS = 'example/widgets';
const GADGETS = 'example/gadgets';
const FACTORIES = [
  { name: 'widgets', repository: WIDGETS },
  { name: 'gadgets', repository: GADGETS },
  { name: 'sandbox', repository: 'local/authcheck' },
];
const RUN = '00000000-0000-4000-8000-000000000001';
const ARCHON_SHA = '1cfb8fc541580fe5edf15e9a504b572bc9bb45bb';

/** The forge's v1 schema (forge/src/db.ts SCHEMA_V1), the tables the poller reads. */
const FORGE_SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, name TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE (owner, name));
CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('issue', 'pr')), title TEXT NOT NULL,
  body TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')), state_reason TEXT,
  author_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  closed_at TEXT, merged_at TEXT, head_ref TEXT, base_ref TEXT, head_oid TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0, UNIQUE (repo_id, number));
CREATE TABLE labels (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (repo_id, name));
CREATE TABLE item_labels (item_id INTEGER NOT NULL REFERENCES items(id),
  label_id INTEGER NOT NULL REFERENCES labels(id), PRIMARY KEY (item_id, label_id));
CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id),
  author_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
INSERT INTO users (id, login) VALUES (1, 'factory');
`;

/** A stand-in for the forge process: its own read-write connection, WAL, as the forge opens it. */
class FakeForge {
  readonly db: Database;
  private clock = Date.parse('2026-11-13T01:00:00Z');
  constructor(readonly file: string) {
    this.db = new Database(file, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(FORGE_SCHEMA);
    for (const full of [WIDGETS, GADGETS]) {
      const [owner, name] = full.split('/');
      this.db
        .query('INSERT INTO repos (owner, name, created_at) VALUES (?, ?, ?)')
        .run(owner, name, this.at());
    }
  }
  at(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString().replace('.000Z', 'Z');
  }
  private repo(full: string): number {
    const [owner, name] = full.split('/');
    return (
      this.db.query('SELECT id FROM repos WHERE owner = ? AND name = ?').get(owner, name) as {
        id: number;
      }
    ).id;
  }
  item(
    full: string,
    kind: 'issue' | 'pr',
    title: string,
    body = '',
    extra: { head?: string } = {},
  ) {
    const repo = this.repo(full);
    const { next } = this.db
      .query('SELECT next_number AS next FROM repos WHERE id = ?')
      .get(repo) as { next: number };
    this.db.query('UPDATE repos SET next_number = next_number + 1 WHERE id = ?').run(repo);
    const at = this.at();
    const row = this.db
      .query(
        `INSERT INTO items (repo_id, number, kind, title, body, state, author_id, created_at, updated_at, head_oid)
         VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?) RETURNING id`,
      )
      .get(repo, next, kind, title, body, at, at, extra.head ?? null) as { id: number };
    return { id: row.id, number: next };
  }
  label(full: string, itemId: number, name: string): string {
    const repo = this.repo(full);
    const at = this.at();
    this.db
      .query(
        'INSERT OR IGNORE INTO labels (repo_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(repo, name, 'ededed', at, at);
    const label = this.db
      .query('SELECT id FROM labels WHERE repo_id = ? AND name = ?')
      .get(repo, name) as { id: number };
    this.db
      .query('INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)')
      .run(itemId, label.id);
    this.db.query('UPDATE items SET updated_at = ? WHERE id = ?').run(at, itemId);
    return at;
  }
  comment(itemId: number, body: string): number {
    const at = this.at();
    const row = this.db
      .query(
        'INSERT INTO comments (item_id, author_id, body, created_at, updated_at) VALUES (?, 1, ?, ?, ?) RETURNING id',
      )
      .get(itemId, body, at, at) as { id: number };
    this.db.query('UPDATE items SET updated_at = ? WHERE id = ?').run(at, itemId);
    return row.id;
  }
  deleteComment(id: number) {
    this.db.query('DELETE FROM comments WHERE id = ?').run(id);
  }
  close() {
    this.db.close();
  }
}

/** `db`, counting every statement it runs, in or out of a transaction. */
function counting(inner: Db): { db: Db; statements: () => number } {
  let n = 0;
  const wrap = (tx: Tx): Tx => ({
    query(text, params) {
      n++;
      return tx.query(text, params);
    },
  });
  return {
    statements: () => n,
    db: {
      ...wrap(inner),
      transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
      close: () => inner.close(),
    },
  };
}

let db: Db;
let dir: string;
let forge: FakeForge;
beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db });
  dir = mkdtempSync(join(tmpdir(), 'mc-forge-'));
  forge = new FakeForge(join(dir, 'forge.db'));
});
afterEach(async () => {
  forge.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const poller = (over: Partial<Parameters<typeof createForgePoller>[0]> = {}) =>
  createForgePoller({
    db,
    factories: FACTORIES,
    forgeFile: forge.file,
    appsDir: null,
    pollMs: 0,
    log: () => {},
    ...over,
  });

const rows = (sql: string, params: unknown[] = []) => db.query(sql, params);

/** widgets #1 (needs-owner, claimed), #2 (a PR closing #1, reviewed), gadgets #1. */
function seedForge() {
  const issue = forge.item(WIDGETS, 'issue', 'Settings page forgets its filter', 'Depends on: #3');
  forge.label(WIDGETS, issue.id, 'needs-owner');
  const claim = forge.comment(issue.id, `Loop claim: run ${RUN}\n\nRoute: simple\nArea: ui`);
  const pr = forge.item(WIDGETS, 'pr', 'fix(ui): keep the settings filter', 'Closes #1', {
    head: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
  });
  const review = forge.comment(
    pr.id,
    'Loop review: sent back (route: simple)\n\n**Reason:** a test is missing',
  );
  const other = forge.item(GADGETS, 'issue', 'Sidebar collapses after every save');
  return { issue, claim, pr, review, other };
}

test('the first poll stores every issue, pull request, comment and label the forge holds', async () => {
  const seeded = seedForge();
  const report = await poller().pollOnce();
  expect(report.unchanged).toBe(false);
  expect(report.delivered).toEqual({ issues: 2, pull_request: 1, issue_comment: 2 });

  expect(
    await rows('SELECT factory, number, title, state, url FROM mc.issues ORDER BY factory, number'),
  ).toEqual([
    {
      factory: 'gadgets',
      number: 1,
      title: 'Sidebar collapses after every save',
      state: 'open',
      url: `https://github.com/${GADGETS}/issues/1`,
    },
    {
      factory: 'widgets',
      number: 1,
      title: 'Settings page forgets its filter',
      state: 'open',
      url: `https://github.com/${WIDGETS}/issues/1`,
    },
  ]);
  expect(
    await rows('SELECT factory, issue_number, label, labeled_at FROM mc.issue_labels'),
  ).toEqual([
    // The first read cannot know when it was labelled: the owner queue then waits from updated_at.
    { factory: 'widgets', issue_number: 1, label: 'needs-owner', labeled_at: null },
  ]);
  expect(await rows('SELECT issue_number, depends_on FROM mc.issue_dependencies')).toEqual([
    { issue_number: 1, depends_on: 3 },
  ]);
  expect(await rows('SELECT factory, number, state, head_sha, url FROM mc.pull_requests')).toEqual([
    {
      factory: 'widgets',
      number: 2,
      state: 'open',
      head_sha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
      url: `https://github.com/${WIDGETS}/pull/2`,
    },
  ]);
  expect(await rows('SELECT pr_number, issue_number FROM mc.pull_request_issues')).toEqual([
    { pr_number: 2, issue_number: 1 },
  ]);
  expect(
    await rows('SELECT id::int AS id, issue_number, author, url FROM mc.comments ORDER BY id'),
  ).toEqual([
    {
      id: seeded.claim,
      issue_number: 1,
      author: 'factory',
      url: `https://github.com/${WIDGETS}/issues/1#issuecomment-${seeded.claim}`,
    },
    {
      id: seeded.review,
      issue_number: 2,
      author: 'factory',
      url: `https://github.com/${WIDGETS}/pull/2#issuecomment-${seeded.review}`,
    },
  ]);
  expect(await rows('SELECT issue_number, run_id, route, area FROM mc.claims')).toEqual([
    { issue_number: 1, run_id: RUN, route: 'simple', area: 'ui' },
  ]);
  expect(await rows('SELECT pr_number, outcome, route FROM mc.reviews')).toEqual([
    { pr_number: 2, outcome: 'sent-back', route: 'simple' },
  ]);
  // A needs-owner issue is the owner queue's: the Attention page and the map read it from here.
  const queue = await rows(readFileSync(join(repoRoot, 'db/queries/owner-queue.sql'), 'utf8'), [
    'widgets',
  ]);
  expect(queue.map((r) => [r.kind, r.issue_number])).toEqual([['issue', 1]]);
});

test('a poll that finds the forge unchanged reads nothing more and writes nothing', async () => {
  seedForge();
  const watched = counting(db);
  const p = poller({ db: watched.db });
  await p.pollOnce();
  const before = await snapshot(db);
  const statements = watched.statements();
  const again = await p.pollOnce();
  expect(again.unchanged).toBe(true);
  expect(watched.statements()).toBe(statements);
  expect(await snapshot(db)).toEqual(before);
});

test('a new issue and a new comment reach the dashboard on the next poll, and only they are written', async () => {
  const { issue } = seedForge();
  const p = poller();
  await p.pollOnce();
  const created = forge.item(WIDGETS, 'issue', 'Dark mode toggle resets on reload');
  const comment = forge.comment(issue.id, 'Parked by the operator: waiting on the owner.');
  const report = await p.pollOnce();
  // The new issue; issue #1 again (its comment moved its updated_at); the new comment.
  expect(report.delivered).toEqual({ issues: 2, issue_comment: 1 });
  expect(
    await rows('SELECT number FROM mc.issues WHERE factory = $1 ORDER BY number', ['widgets']),
  ).toEqual([{ number: 1 }, { number: created.number }]);
  expect(await rows('SELECT id::int AS id FROM mc.comments WHERE id = $1', [comment])).toEqual([
    { id: comment },
  ]);
});

test('a label an issue gains between polls is the labeled delivery: it records when', async () => {
  const other = forge.item(GADGETS, 'issue', 'Export button ignores the date range');
  const p = poller();
  await p.pollOnce();
  const at = forge.label(GADGETS, other.id, 'needs-owner');
  expect((await p.pollOnce()).delivered).toEqual({ issues: 1 });
  const [label] = await rows('SELECT labeled_at FROM mc.issue_labels WHERE factory = $1', [
    'gadgets',
  ]);
  expect(new Date(String(label?.labeled_at)).toISOString()).toBe(new Date(at).toISOString());
});

test('what the forge no longer holds leaves the dashboard; the first poll reconciles, other repositories stay', async () => {
  const { claim } = seedForge();
  // Rows the forge never had: a stale widgets issue, and a sandbox issue the forge does not follow.
  for (const [factory, number] of [
    ['widgets', 99],
    ['sandbox', 5],
  ] as const) {
    await db.query(
      `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
       VALUES ($1, $2, 'gone', 'open', 'https://github.com/x/y/issues/1', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
      [factory, number],
    );
  }
  const p = poller();
  const first = await p.pollOnce();
  expect(first.removed).toEqual({ issues: 1, comments: 0 });
  expect(await rows("SELECT factory, number FROM mc.issues WHERE title = 'gone'")).toEqual([
    { factory: 'sandbox', number: 5 },
  ]);
  forge.deleteComment(claim);
  const second = await p.pollOnce();
  expect(second.removed).toEqual({ issues: 0, comments: 1 });
  expect(await rows('SELECT id FROM mc.comments WHERE id = $1', [claim])).toEqual([]);
});

test('the forge file is only ever read: polling leaves it byte for byte, and its connection refuses writes', async () => {
  seedForge();
  forge.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const digest = () => createHash('sha256').update(readFileSync(forge.file)).digest('hex');
  const before = digest();
  const p = poller();
  await p.pollOnce();
  await p.pollOnce();
  await p.stop();
  expect(digest()).toBe(before);
  const reader = openForge(forge.file);
  expect(() => reader.exec("INSERT INTO users (login) VALUES ('x')")).toThrow(/readonly/i);
  reader.close();
});

test("each pull request's newest publication is read, per factory; a forge without the table has none", async () => {
  seedForge();
  const p = poller();
  await p.pollOnce();
  expect(p.published()).toEqual(
    new Map([
      ['widgets', new Map()],
      ['gadgets', new Map()],
    ]),
  );

  // forge/src/db.ts's publications table, which an older forge does not have.
  forge.db.exec(`CREATE TABLE publications (id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id), number INTEGER NOT NULL, branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL, head_oid TEXT NOT NULL, published_at TEXT NOT NULL)`);
  const publish = (repoId: number, number: number, branch: string) =>
    forge.db
      .query(
        `INSERT INTO publications (repo_id, number, branch, commit_sha, head_oid, published_at)
         VALUES (?, ?, ?, 'c', 'h', ?)`,
      )
      .run(repoId, number, branch, forge.at());
  publish(1, 2, 'factory/pr-2-old');
  publish(2, 2, 'factory/pr-2-gadgets');
  publish(1, 2, 'factory/pr-2-new');
  publish(1, 7, 'factory/pr-7-x');
  await p.pollOnce();
  expect(p.published()).toEqual(
    new Map([
      [
        'widgets',
        new Map([
          [2, 'factory/pr-2-new'],
          [7, 'factory/pr-7-x'],
        ]),
      ],
      ['gadgets', new Map([[2, 'factory/pr-2-gadgets']])],
    ]),
  );
});

test('a missing forge file is waited for, not an error; pins still load', async () => {
  const apps = join(dir, 'apps');
  mkdirSync(join(apps, 'widgets', 'factory'), { recursive: true });
  writeFileSync(
    join(apps, 'widgets', 'factory', 'pack.json'),
    JSON.stringify({ integration_revision_required: ARCHON_SHA }),
  );
  const p = poller({
    forgeFile: join(dir, 'no-such.db'),
    appsDir: apps,
    authoredAt: () => '2026-11-13T01:24:45.000Z',
  });
  const report = await p.pollOnce();
  expect(p.status().lastError).toBeNull();
  expect(report.pins).toBe(1);
  expect(await rows('SELECT count(*)::int AS n FROM mc.issues')).toEqual([{ n: 0 }]);
});

test('pins come from the app checkouts: one per Archon sha, keyed by it, dated by the earliest pack commit', async () => {
  const apps = join(dir, 'apps');
  const pack = (repo: string, sha: string) => {
    mkdirSync(join(apps, repo, 'factory'), { recursive: true });
    writeFileSync(
      join(apps, repo, 'factory', 'pack.json'),
      JSON.stringify({ integration_revision_required: sha }),
    );
  };
  pack('widgets', ARCHON_SHA);
  pack('gadgets', ARCHON_SHA);
  const authored: Record<string, string> = {
    widgets: '2026-11-13T01:24:45.000Z',
    gadgets: '2026-11-13T01:20:00.000Z',
  };
  const watched = counting(db);
  const p = poller({
    db: watched.db,
    forgeFile: null,
    appsDir: apps,
    authoredAt: (checkout) => authored[checkout.split('/').pop() ?? ''] ?? null,
  });
  expect((await p.pollOnce()).pins).toBe(1);
  expect(await rows('SELECT sha, archon_sha, reason, committed_at FROM mc.pins')).toEqual([
    {
      sha: ARCHON_SHA,
      archon_sha: ARCHON_SHA,
      reason: 'pinned by gadgets, widgets (factory/pack.json)',
      committed_at: new Date('2026-11-13T01:20:00Z'),
    },
  ]);
  const statements = watched.statements();
  expect((await p.pollOnce()).unchanged).toBe(true);
  expect(watched.statements()).toBe(statements);

  const next = 'abcdef0123456789abcdef0123456789abcdef01';
  pack('widgets', next);
  authored.widgets = '2026-11-14T00:00:00.000Z';
  expect((await p.pollOnce()).pins).toBe(2);
  expect((await rows('SELECT sha FROM mc.pins ORDER BY committed_at')).map((r) => r.sha)).toEqual([
    ARCHON_SHA,
    next,
  ]);
});

test('gitAuthoredAt reads the author date of the last commit to the pack file, and null outside a repository', () => {
  const checkout = join(dir, 'checkout');
  mkdirSync(join(checkout, 'factory'), { recursive: true });
  writeFileSync(join(checkout, 'factory', 'pack.json'), '{}');
  const git = (...args: string[]) =>
    Bun.spawnSync(
      ['git', '-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          GIT_AUTHOR_DATE: '2026-11-13T01:24:45Z',
          GIT_CONFIG_NOSYSTEM: '1',
          HOME: dir,
        },
      },
    );
  expect(gitAuthoredAt(checkout)).toBeNull();
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'pack');
  expect(gitAuthoredAt(checkout)).toBe('2026-11-13T01:24:45.000Z');
});

test('the server runs a poller only with a database and a forge or apps directory', () => {
  const factoriesFile = join(dir, 'factories.json');
  writeFileSync(
    factoriesFile,
    JSON.stringify({
      factories: FACTORIES.map((f) => ({
        ...f,
        codebase: f.repository,
        console: 'http://localhost:3090',
      })),
    }),
  );
  const base = { MC_FACTORIES_FILE: factoriesFile };
  expect(forgePollerFromEnv({ ...base, MC_FORGE_DB: forge.file }, repoRoot)).toBeUndefined();
  expect(
    forgePollerFromEnv({ ...base, MC_DATABASE_URL: 'postgres://x@127.0.0.1:1/x' }, repoRoot),
  ).toBeUndefined();
  expect(() =>
    forgePollerFromEnv(
      {
        ...base,
        MC_DATABASE_URL: 'postgres://x@127.0.0.1:1/x',
        MC_FORGE_DB: forge.file,
        MC_FORGE_POLL_MS: 'soon',
      },
      repoRoot,
    ),
  ).toThrow('MC_FORGE_POLL_MS');
  const made = forgePollerFromEnv(
    { ...base, MC_DATABASE_URL: 'postgres://x@127.0.0.1:1/x', MC_FORGE_DB: forge.file },
    repoRoot,
  );
  expect(made?.status()).toMatchObject({ file: forge.file, pollMs: 5000, polls: 0 });
});
