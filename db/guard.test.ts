// The HARD SAFETY RULE, offline (local-factory port): with the dashboard installed and its
// projection broken, Archon's writes still succeed. `bun scripts/safety-test.ts` proves the same on
// a real Postgres scratch database, with timings and a lock held by another session.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { eventData } from '../scripts/fixture/write';
import {
  ATTACHED_SQL,
  attachGuard,
  DDL_LOCK_TIMEOUT,
  DETACH_SQL,
  detachSql,
  isLockWaitLost,
  whenOf,
  withShortLocks,
} from '../scripts/lib/archon-guard';
import type { Db, Row, Tx } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { archonDb, migrationFiles, type TestDb } from './test-db';

let db: TestDb;
let codebase: string;

beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
  const [row] = await db.query(
    `INSERT INTO public.remote_agent_codebases (name) VALUES ('safety') RETURNING id`,
    [],
  );
  codebase = String(row?.id);
});
afterEach(() => db.close());

const NOW = new Date('2026-11-12T12:00:00Z');

/** Archon's own writes for one run: its row, step events, a heartbeat, a pause and its end. */
async function archonRun(): Promise<string> {
  const [run] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message)
     VALUES ('archon-loop', $1, 'running', 'safety') RETURNING id`,
    [codebase],
  );
  const id = String(run?.id);
  for (const [type, step] of [
    ['node_started', 'pick'],
    ['provider_event', 'pick'],
    ['node_completed', 'pick'],
  ] as const) {
    await db.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, $2, $3, $4)`,
      [id, type, step, JSON.stringify(type === 'provider_event' ? {} : eventData(step, type, NOW))],
    );
  }
  await db.query(
    'UPDATE public.remote_agent_workflow_runs SET last_activity_at = now() WHERE id = $1',
    [id],
  );
  await db.query(`UPDATE public.remote_agent_workflow_runs SET status = 'paused' WHERE id = $1`, [
    id,
  ]);
  await db.query(
    `UPDATE public.remote_agent_workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
    [id],
  );
  return id;
}

const one = async (sql: string, params: unknown[] = []): Promise<Row | undefined> =>
  (await db.query(sql, params))[0];

test("Archon's tables carry only the guards, each in schema mc_guard", async () => {
  const attached = await db.query(ATTACHED_SQL, []);
  expect(attached.length).toBeGreaterThan(0);
  for (const row of attached) expect(String(row.function)).toStartWith('mc_guard.guard_');
});

test('healthy, the projection follows Archon through the guard, and the pass-through shadow keeps nothing', async () => {
  const run = await archonRun();
  expect(await one('SELECT status FROM mc.laps WHERE run_id = $1', [run])).toEqual({
    status: 'completed',
  });
  expect(await one('SELECT status FROM mc.lap_steps WHERE run_id = $1', [run])).toEqual({
    status: 'completed',
  });
  expect(await one('SELECT count(*)::int AS n FROM mc_guard.remote_agent_workflow_events')).toEqual(
    { n: 0 },
  );
  expect(
    await one('SELECT status FROM mc_guard.remote_agent_workflow_runs WHERE id = $1', [run]),
  ).toEqual({ status: 'completed' });
});

test.each([
  [
    'its error recorder is gone',
    'DROP FUNCTION mc.record_projection_error(text, uuid, uuid, text, text) CASCADE',
  ],
  ['a table it writes is gone', 'DROP TABLE mc.lap_steps CASCADE; DROP TABLE mc.laps CASCADE'],
  ['the whole mc schema is gone', 'DROP SCHEMA mc CASCADE'],
  ['a shadow table is gone', 'DROP TABLE mc_guard.remote_agent_workflow_events'],
])(
  'with the projection broken (%s), every Archon insert, update and delete succeeds',
  async (_, breakIt) => {
    await db.query(breakIt);
    const before = await one('SELECT count(*)::int AS n FROM public.remote_agent_workflow_events');
    const run = await archonRun();
    expect(await one('SELECT count(*)::int AS n FROM public.remote_agent_workflow_events')).toEqual(
      {
        n: Number(before?.n) + 3,
      },
    );
    expect(
      await one('SELECT status FROM public.remote_agent_workflow_runs WHERE id = $1', [run]),
    ).toEqual({ status: 'completed' });
    await db.query('DELETE FROM public.remote_agent_workflow_runs WHERE id = $1', [run]);
    await db.query('TRUNCATE public.remote_agent_workflow_runs CASCADE');
  },
);

test('what the guard caught is counted, by table, operation and error code', async () => {
  await db.query('DROP FUNCTION mc.record_projection_error(text, uuid, uuid, text, text) CASCADE');
  await db.query('DROP TABLE mc.lap_steps CASCADE');
  await archonRun();
  const caught = await db.query(
    'SELECT source, error_code FROM mc_guard.guard_errors ORDER BY source, error_code',
  );
  expect(caught).toContainEqual({
    source: 'remote_agent_workflow_events INSERT',
    error_code: '42883',
  });
});

test('without the guard, the same broken projection fails the Archon insert (the hazard it closes)', async () => {
  await db.query(DETACH_SQL);
  await db.query(
    `CREATE TRIGGER upstream_style AFTER INSERT ON public.remote_agent_workflow_events
       FOR EACH ROW EXECUTE FUNCTION mc.project_step_event()`,
  );
  await db.query('DROP FUNCTION mc.record_projection_error(text, uuid, uuid, text, text) CASCADE');
  await db.query('DROP TABLE mc.lap_steps CASCADE');
  const [run] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message)
     VALUES ('archon-loop', $1, 'running', 'x') RETURNING id`,
    [codebase],
  );
  await expect(
    db.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_started', 'pick', $2)`,
      [run?.id, JSON.stringify(eventData('pick', 'node_started', NOW))],
    ),
  ).rejects.toThrow('record_projection_error');
});

test('detach drops every dashboard trigger from Archon, twice cleanly; attach puts the guards back', async () => {
  await db.query(DETACH_SQL);
  await db.query(DETACH_SQL);
  expect(await db.query(ATTACHED_SQL, [])).toEqual([]);
  const run = await archonRun();
  expect(await one('SELECT count(*)::int AS n FROM mc.laps WHERE run_id = $1', [run])).toEqual({
    n: 0,
  });
  const report = await attachGuard(db, { seed: true });
  expect(report.changed).toEqual(report.attached);
  expect(report.attached.sort()).toEqual([
    'remote_agent_state_revisions',
    'remote_agent_workflow_events',
    'remote_agent_workflow_runs',
  ]);
  expect(report.seeded).toEqual(['remote_agent_workflow_runs']);
  // The seed projected the run written while detached.
  expect(await one('SELECT status FROM mc.laps WHERE run_id = $1', [run])).toEqual({
    status: 'completed',
  });
});

test("a TRUNCATE of Archon's runs empties the mirror, so a run inserted again is projected as new", async () => {
  const run = await archonRun();
  await db.query('TRUNCATE public.remote_agent_workflow_runs CASCADE');
  expect(await one('SELECT count(*)::int AS n FROM mc_guard.remote_agent_workflow_runs')).toEqual({
    n: 0,
  });
  await db.query('DELETE FROM mc.laps');
  await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (id, workflow_name, codebase_id, status, user_message)
     VALUES ($1, 'archon-loop', $2, 'running', 'again')`,
    [run, codebase],
  );
  expect(await one('SELECT status FROM mc.laps WHERE run_id = $1', [run])).toEqual({
    status: 'running',
  });
});

test('whenOf reads a trigger definition’s condition', () => {
  expect(
    whenOf(
      "CREATE TRIGGER t AFTER INSERT ON x FOR EACH ROW WHEN (((new.a)::text = 'b'::text)) EXECUTE FUNCTION f()",
    ),
  ).toBe("((new.a)::text = 'b'::text)");
  expect(whenOf('CREATE TRIGGER t AFTER INSERT ON x FOR EACH ROW EXECUTE FUNCTION f()')).toBeNull();
});

/** `db`, recording every statement it runs, in or out of a transaction. */
function recording(inner: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const wrap = (tx: Tx): Tx => ({
    query(text, params) {
      sql.push(text);
      return tx.query(text, params);
    },
  });
  return {
    sql,
    db: {
      ...wrap(inner),
      transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
      close: () => inner.close(),
    },
  };
}

/**
 * Statements that are DDL: any that begins with CREATE, ALTER, DROP or COMMENT, or creates or
 * replaces a trigger or function anywhere in it. A DO block whose loop finds nothing to create
 * (the live NOTIFY triggers) is told apart by `catalogShape` instead.
 */
const ddl = (sql: string[]) =>
  sql.filter(
    (text) =>
      /^\s*(CREATE|ALTER|DROP|COMMENT)\b/i.test(text) ||
      (!/^\s*DO\b/i.test(text) &&
        /CREATE (OR REPLACE )?(TRIGGER|FUNCTION)|DROP TRIGGER/i.test(text)),
  );

/** Every trigger and FMC function, by its catalog row version: any DDL on them changes it. */
const catalogShape = async () =>
  (
    await db.query(
      `SELECT string_agg(x, ',' ORDER BY x) AS shape FROM (
        SELECT 'tg:' || tg.tgrelid::regclass || '.' || tg.tgname || ':' || tg.xmin AS x FROM pg_trigger tg WHERE NOT tg.tgisinternal
        UNION ALL
        SELECT 'fn:' || p.oid::regprocedure || ':' || p.xmin FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('mc', 'mc_guard', 'mc_meta')
        UNION ALL
        SELECT 'rel:' || c.oid::regclass || ':' || c.xmin FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('mc', 'mc_guard', 'mc_meta', 'public')) s`,
      [],
    )
  )[0]?.shape;

test('attaching an attached guard issues no DDL at all: no trigger, no function', async () => {
  const before = await catalogShape();
  const { db: watched, sql } = recording(db);
  const report = await attachGuard(watched, { seed: true });
  expect(report.changed).toEqual([]);
  expect(report.functions).toEqual([]);
  expect(report.attached.length).toBeGreaterThan(0);
  expect(ddl(sql)).toEqual([]);
  expect(await catalogShape()).toBe(before);
});

test('a second migrate run issues no DDL at all, on Archon’s tables or the dashboard’s', async () => {
  const before = await catalogShape();
  const { db: watched, sql } = recording(db);
  expect(await runMigrations({ files: migrationFiles, db: watched })).toEqual([]);
  expect(ddl(sql)).toEqual([]);
  expect(await catalogShape()).toBe(before);
});

test('migrate replaces a stale live NOTIFY function and adds a missing NOTIFY trigger, nothing else', async () => {
  await db.query(`CREATE OR REPLACE FUNCTION mc_meta.notify_live() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RETURN NULL; END $$`);
  await db.query('DROP TRIGGER mc_live_notify ON mc.issues');
  const { db: watched, sql } = recording(db);
  await runMigrations({ files: migrationFiles, db: watched, guard: false });
  expect(ddl(sql)).toHaveLength(1);
  expect(ddl(sql)[0]).toContain('CREATE OR REPLACE FUNCTION mc_meta.notify_live()');
  const [trigger] = await db.query(
    `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'mc.issues'::regclass AND tgname = 'mc_live_notify'`,
    [],
  );
  expect(trigger?.n).toBe(1);
  const before = await catalogShape();
  await runMigrations({ files: migrationFiles, db, guard: false });
  expect(await catalogShape()).toBe(before);
});

test('attach rewrites only what differs: one missing trigger, one changed function', async () => {
  await db.query(detachSql('remote_agent_workflow_events'));
  await db.query(`CREATE OR REPLACE FUNCTION mc_guard.guard_remote_agent_workflow_runs() RETURNS trigger
    LANGUAGE plpgsql SET lock_timeout = '100ms' AS $$ BEGIN RETURN NULL; END $$`);
  const { db: watched, sql } = recording(db);
  const report = await attachGuard(watched);
  expect(report.changed).toEqual(['remote_agent_workflow_events']);
  expect(report.functions).toEqual(['guard_remote_agent_workflow_runs']);
  const triggers = ddl(sql).filter((text) => /CREATE OR REPLACE TRIGGER/.test(text));
  expect(triggers).toHaveLength(1);
  expect(triggers[0]).toContain('ON public."remote_agent_workflow_events"');
  // The guard works again on both tables.
  const run = await archonRun();
  expect(await one('SELECT status FROM mc.laps WHERE run_id = $1', [run])).toEqual({
    status: 'completed',
  });
  expect(await one('SELECT status FROM mc.lap_steps WHERE run_id = $1', [run])).toEqual({
    status: 'completed',
  });
});

test('a disabled guard trigger, or one with other events, counts as different and is replaced', async () => {
  await db.query(
    'ALTER TABLE public.remote_agent_workflow_runs DISABLE TRIGGER mc_guard_projection',
  );
  await db.query(`CREATE OR REPLACE TRIGGER mc_guard_projection AFTER UPDATE ON public.remote_agent_workflow_events
    FOR EACH ROW EXECUTE FUNCTION mc_guard.guard_remote_agent_workflow_events()`);
  const report = await attachGuard(db);
  expect(report.changed.sort()).toEqual([
    'remote_agent_workflow_events',
    'remote_agent_workflow_runs',
  ]);
  expect((await attachGuard(db)).changed).toEqual([]);
  const run = await archonRun();
  expect(await one('SELECT status FROM mc.lap_steps WHERE run_id = $1', [run])).toEqual({
    status: 'completed',
  });
});

test('detachSql(table) drops the dashboard triggers of that Archon table only', async () => {
  await db.query(detachSql('remote_agent_workflow_events'));
  const left = (await db.query(ATTACHED_SQL, [])).map((r) => String(r.table));
  expect(left).not.toContain('remote_agent_workflow_events');
  expect(left).toContain('remote_agent_workflow_runs');
});

/** A Db whose transactions fail with `errors` in turn, then run. */
function failingDb(errors: unknown[]): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const tx: Tx = {
    async query(text) {
      statements.push(text);
      return [];
    },
  };
  return {
    statements,
    db: {
      ...tx,
      async transaction(fn) {
        const error = errors.shift();
        if (error) {
          await fn(tx);
          throw error;
        }
        await fn(tx);
      },
      async close() {},
    },
  };
}

test('withShortLocks bounds every lock wait and retries a lost one after a growing pause', async () => {
  const lost = Object.assign(new Error('canceling statement due to lock timeout'), {
    errno: '55P03',
  });
  const { db: flaky, statements } = failingDb([lost, lost]);
  const pauses: number[] = [];
  const retried: number[] = [];
  const result = await withShortLocks(flaky, async () => 'done', {
    sleep: async (ms) => {
      pauses.push(ms);
    },
    onRetry: (_, attempt) => retried.push(attempt),
  });
  expect(result).toBe('done');
  expect(pauses).toEqual([100, 200]);
  expect(retried).toEqual([1, 2]);
  expect(statements).toEqual(Array(3).fill(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT}'`));
});

test('withShortLocks gives up after its tries, and never retries any other error', async () => {
  const lost = { code: '55P03', message: 'lock timeout' };
  const { db: busy } = failingDb([lost, lost, lost]);
  await expect(
    withShortLocks(busy, async () => {}, { attempts: 3, sleep: async () => {} }),
  ).rejects.toEqual(lost);
  const other = new Error('relation "mc.x" does not exist');
  const { db: broken, statements } = failingDb([other]);
  await expect(withShortLocks(broken, async () => {}, { sleep: async () => {} })).rejects.toBe(
    other,
  );
  expect(statements).toHaveLength(1);
});

test('isLockWaitLost reads Bun’s errno, node-postgres’s code and the message', () => {
  expect(isLockWaitLost({ errno: '55P03' })).toBe(true);
  expect(isLockWaitLost({ code: '40P01' })).toBe(true);
  expect(isLockWaitLost(new Error('canceling statement due to lock timeout'))).toBe(true);
  expect(isLockWaitLost(new Error('syntax error'))).toBe(false);
  expect(isLockWaitLost(undefined)).toBe(false);
});
