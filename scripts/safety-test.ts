// `bun scripts/safety-test.ts <archon-schema.sql>` (local-factory port): proves the HARD SAFETY
// RULE on a real Postgres, in a scratch database it creates and always drops: with the dashboard
// installed and its projection deliberately broken, Archon-shaped inserts, updates and deletes
// still succeed, and fast; a lock held on the dashboard's tables delays Archon's write by at most
// the guard's lock timeout; detach leaves no trigger behind. It never touches the live database:
// it connects to MC_DATABASE_URL's server only to create and drop `check-safety-<id>`.
//
// As a control it also shows the failure the guard closes: the upstream arrangement (the
// projection trigger straight on Archon's table) makes the same Archon insert fail once the
// projection is broken this way.
//
// It also replays a dashboard start (migrate --no-attach, then attach, as start.sh runs them)
// while an Archon transaction is open on Archon's tables, and times Archon's writes meanwhile:
// with the guard in place the start takes no lock on Archon's tables; when it must (re)install a
// trigger, Archon waits at most the DDL's short lock wait; and with Archon holding the runs table
// and then writing an event, there is no lock cycle. The previous start (unconditional trigger
// DDL on both tables in one transaction, waiting up to 5 s) runs the same way as a control.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { eventData } from './fixture/write';
import {
  ATTACHED_SQL,
  type AttachReport,
  attachGuard,
  DETACH_SQL,
  detachSql,
  guardTriggerSql,
  planGuards,
} from './lib/archon-guard';
import type { Db, Row, Tx } from './lib/db';
import { withDatabase } from './lib/target';
import { migrationsDir, readMigrationFiles, runMigrations } from './migrate';

const REPO_ROOT = resolve(import.meta.dir, '..');

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** The scripts' `Db` over one node-postgres client: a single session, like an Archon connection. */
function clientDb(client: pg.Client): Db {
  const query = async (sql: string, params?: unknown[]) =>
    (
      await client.query(
        sql,
        params?.map((p) => (Array.isArray(p) ? JSON.stringify(p) : p)),
      )
    ).rows as Row[];
  return {
    query,
    async transaction(fn: (tx: Tx) => Promise<void>) {
      await client.query('BEGIN');
      try {
        await fn({ query });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    close: () => client.end(),
  };
}

async function connect(url: string, name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: name });
  client.on('notice', () => {});
  await client.connect();
  return client;
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

const NOW = new Date();
const event = (step: string, type: 'node_started' | 'node_completed' | 'node_failed') =>
  JSON.stringify(eventData(step, type, NOW));

/** Archon's own writes for one run, as its workflow engine makes them. */
async function archonRun(archon: pg.Client, codebase: string, label: string): Promise<string> {
  const run = await archon.query(
    `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message, metadata)
     VALUES ('archon-loop', $1, 'running', $2, '{"workflow_source": {"digest": "sha256:safety"}}')
     RETURNING id`,
    [codebase, `safety ${label}`],
  );
  const id = String(run.rows[0].id);
  for (const step of ['pick', 'implement']) {
    await archon.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_started', $2, $3)`,
      [id, step, event(step, 'node_started')],
    );
    await archon.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'provider_event', $2, '{"type":"assistant"}')`,
      [id, step],
    );
    await archon.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_completed', $2, $3)`,
      [id, step, event(step, 'node_completed')],
    );
    await archon.query(
      'UPDATE remote_agent_workflow_runs SET last_activity_at = now() WHERE id = $1',
      [id],
    );
  }
  await archon.query(
    `UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = metadata || '{"x":1}' WHERE id = $1`,
    [id],
  );
  await archon.query(
    `UPDATE remote_agent_workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
    [id],
  );
  return id;
}

const count = async (client: pg.Client, sql: string, params: unknown[] = []) =>
  Number((await client.query(sql, params)).rows[0]?.n ?? -1);

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** How long Archon keeps its transaction open on the events table in the 'events' shape. */
const HOLD_MS = 1500;
/** When the dashboard's start begins, after Archon's transaction did. */
const START_AT_MS = 100;

interface Contention {
  /** The slowest one-row event insert another Archon session made meanwhile. */
  slowestMs: number;
  inserts: number;
  /** In the 'runs-then-events' shape: how long Archon's own event insert took. */
  eventMs: number;
  archonError: string;
  startError: string;
  startResult: unknown;
}

/**
 * Archon keeps a transaction open while the dashboard's start (`start`, on its own connection)
 * runs, and a second Archon session writes one event row every 25 ms. Shape 'events': Archon
 * inserted an event and keeps working for HOLD_MS. Shape 'runs-then-events': Archon updated its
 * run, and inserts the run's event 400 ms later (the order a lock cycle with a two-table DDL needs).
 */
async function underOpenArchonTransaction(
  url: string,
  run: string,
  shape: 'events' | 'runs-then-events',
  start: (db: Db) => Promise<unknown>,
): Promise<Contention> {
  const holder = await connect(url, 'archon-shaped-holder');
  const writer = await connect(url, 'archon-shaped-writer');
  const fmc = await connect(url, 'mission-control-start');
  const result: Contention = {
    slowestMs: 0,
    inserts: 0,
    eventMs: 0,
    archonError: '',
    startError: '',
    startResult: undefined,
  };
  const insertEvent = `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
    VALUES ($1, 'provider_event', $2, '{"type":"assistant"}')`;
  let holding = true;
  try {
    await holder.query('BEGIN');
    const archon = (async () => {
      try {
        if (shape === 'events') {
          await holder.query(insertEvent, [run, 'held']);
          await pause(HOLD_MS);
        } else {
          await holder.query(
            `UPDATE remote_agent_workflow_runs SET metadata = metadata || '{"held":1}' WHERE id = $1`,
            [run],
          );
          await pause(400);
          const t = performance.now();
          await holder.query(insertEvent, [run, 'held']);
          result.eventMs = performance.now() - t;
          await pause(400);
        }
        await holder.query('COMMIT');
      } catch (error) {
        result.archonError = error instanceof Error ? error.message : String(error);
        await holder.query('ROLLBACK').catch(() => {});
      } finally {
        holding = false;
      }
    })();
    const dashboard = (async () => {
      await pause(START_AT_MS);
      try {
        result.startResult = await start(clientDb(fmc));
      } catch (error) {
        result.startError = error instanceof Error ? error.message : String(error);
      }
    })();
    const writes = (async () => {
      await pause(START_AT_MS + 20);
      while (holding) {
        const t = performance.now();
        await writer.query(insertEvent, [run, 'writer']);
        result.slowestMs = Math.max(result.slowestMs, performance.now() - t);
        result.inserts++;
        await pause(25);
      }
    })();
    await Promise.all([archon, dashboard, writes]);
  } finally {
    for (const client of [holder, writer, fmc]) await client.end().catch(() => {});
  }
  return result;
}

const changedOf = (result: unknown) => (result as AttachReport | undefined)?.changed ?? [];

async function main(): Promise<number> {
  const schemaFile = Bun.argv[2];
  const server = Bun.env.MC_DATABASE_URL;
  if (!schemaFile || !server) {
    console.error(
      'usage: MC_DATABASE_URL=<server url> bun scripts/safety-test.ts <archon 000_combined.sql>',
    );
    return 2;
  }
  const name = `check-safety-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(16)}`;
  const admin = await connect(withDatabase(server, 'postgres'), 'mc-safety-admin');
  await admin.query(`CREATE DATABASE "${name}"`);
  console.log(`scratch database ${name} created`);
  const url = withDatabase(server, name);
  const clients: pg.Client[] = [];
  try {
    const setup = await connect(url, 'mc-safety-setup');
    clients.push(setup);
    await setup.query(readFileSync(schemaFile, 'utf-8'));
    const archonTables = await count(
      setup,
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    console.log(`Archon schema applied: ${archonTables} tables in public (${schemaFile})`);
    const applied = await runMigrations({
      files: readMigrationFiles(migrationsDir(REPO_ROOT)),
      db: clientDb(setup),
    });
    console.log(`FMC migrations applied: ${applied.length}`);
    const attached = (await setup.query(ATTACHED_SQL)).rows;
    check(
      "only the guard's triggers are on Archon's tables",
      attached.length > 0 &&
        attached.every((r) => String(r.function).startsWith('mc_guard.guard_')),
      attached.map((r) => `${r.table}.${r.trigger}`).join(', '),
    );
    const cb = await setup.query(
      `INSERT INTO remote_agent_codebases (name, default_cwd) VALUES ('safety', '/tmp') RETURNING id`,
    );
    const codebase = String(cb.rows[0].id);

    // 1. Healthy: the projection follows Archon.
    const archon = await connect(url, 'archon-shaped');
    clients.push(archon);
    const healthy = await timed(() => archonRun(archon, codebase, 'healthy'));
    const laps = await count(setup, 'SELECT count(*) AS n FROM mc.laps WHERE run_id = $1', [
      healthy.value,
    ]);
    const steps = await count(setup, 'SELECT count(*) AS n FROM mc.lap_steps WHERE run_id = $1', [
      healthy.value,
    ]);
    check(
      'healthy: a run and its step events are projected',
      laps === 1 && steps === 2,
      `laps ${laps}, steps ${steps}, ${healthy.ms.toFixed(0)} ms for 11 writes`,
    );

    // 2. A lock held on a dashboard table delays Archon's write by at most the guard's timeout.
    const locker = await connect(url, 'mc-safety-locker');
    clients.push(locker);
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE mc.laps IN ACCESS EXCLUSIVE MODE');
    await locker.query('LOCK TABLE mc_guard.remote_agent_workflow_runs IN ACCESS EXCLUSIVE MODE');
    const locked = await timed(() =>
      archon.query(
        `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message)
         VALUES ('archon-loop', $1, 'running', 'while locked') RETURNING id`,
        [codebase],
      ),
    );
    await locker.query('ROLLBACK');
    check(
      "a dashboard table locked by another session: Archon's insert still succeeds, within the guard's lock wait",
      locked.value.rowCount === 1 && locked.ms < 1000,
      `${locked.ms.toFixed(0)} ms`,
    );

    // 2b. The dashboard's start while an Archon transaction is open on Archon's tables.
    const migrationFiles = readMigrationFiles(migrationsDir(REPO_ROOT));
    const startNow = async (db: Db) => {
      await runMigrations({ files: migrationFiles, db, guard: false });
      return attachGuard(db, { seed: true });
    };
    /** The start as it was: every guard trigger re-created in one transaction, 5 s lock wait. */
    const startBefore = (db: Db) =>
      db.transaction(async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '5s'`);
        for (const plan of await planGuards(tx)) await tx.query(guardTriggerSql(plan));
      });
    const held = String(
      (
        await setup.query(
          `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message)
           VALUES ('archon-loop', $1, 'running', 'held open') RETURNING id`,
          [codebase],
        )
      ).rows[0].id,
    );
    const guardedTables = ['remote_agent_workflow_events', 'remote_agent_workflow_runs'];
    const detachAll = async () => {
      for (const table of guardedTables) await setup.query(detachSql(table));
    };
    const fmt = (c: Contention) =>
      `slowest of ${c.inserts} Archon inserts ${c.slowestMs.toFixed(0)} ms` +
      (c.eventMs ? `, Archon's own event insert ${c.eventMs.toFixed(0)} ms` : '') +
      (c.archonError ? `, Archon error: ${c.archonError}` : '') +
      (c.startError ? `, start error: ${c.startError}` : '');

    const unchanged = await underOpenArchonTransaction(url, held, 'events', startNow);
    check(
      "start with the guard in place: no trigger DDL, and Archon's inserts are not delayed",
      changedOf(unchanged.startResult).length === 0 &&
        unchanged.startError === '' &&
        unchanged.archonError === '' &&
        unchanged.slowestMs < 100,
      fmt(unchanged),
    );
    const previous = await underOpenArchonTransaction(url, held, 'events', startBefore);
    check(
      'control: the previous start (unconditional trigger DDL, 5 s lock wait) delays the same inserts',
      previous.slowestMs > 500,
      fmt(previous),
    );

    await setup.query(detachSql('remote_agent_workflow_events'));
    const needed = await underOpenArchonTransaction(url, held, 'events', startNow);
    check(
      "start that must re-install a guard trigger: Archon's inserts wait at most its short lock wait, and the guard is back",
      changedOf(needed.startResult).includes('remote_agent_workflow_events') &&
        needed.startError === '' &&
        needed.archonError === '' &&
        needed.slowestMs < 150,
      fmt(needed),
    );

    await detachAll();
    const crossing = await underOpenArchonTransaction(url, held, 'runs-then-events', startNow);
    check(
      'start re-installing both guards while Archon holds runs and then writes an event: no lock cycle, no delay',
      changedOf(crossing.startResult).length === 2 &&
        crossing.startError === '' &&
        crossing.archonError === '' &&
        crossing.eventMs < 150,
      fmt(crossing),
    );
    await detachAll();
    const crossingBefore = await underOpenArchonTransaction(
      url,
      held,
      'runs-then-events',
      startBefore,
    );
    check(
      'control: the previous start (both tables in one transaction) stalls or deadlocks that Archon transaction',
      crossingBefore.archonError !== '' || crossingBefore.eventMs > 500,
      fmt(crossingBefore),
    );
    await attachGuard(clientDb(setup));
    const guards = (await setup.query(ATTACHED_SQL)).rows.map((r) => `${r.table}.${r.trigger}`);
    check(
      'after the start scenarios the guards are attached as before',
      guards.includes('remote_agent_workflow_events.mc_guard_projection') &&
        guards.includes('remote_agent_workflow_runs.mc_guard_projection') &&
        guards.includes('remote_agent_workflow_runs.mc_guard_truncate'),
      guards.join(', '),
    );

    // 3. Break the projection the ways that escape a trigger's own exception block upstream.
    await setup.query(
      'DROP FUNCTION mc.record_projection_error(text, uuid, uuid, text, text) CASCADE',
    );
    await setup.query('DROP TABLE mc.lap_steps CASCADE');
    await setup.query('DROP TABLE mc.laps CASCADE');
    console.log('broke the projection: dropped mc.record_projection_error, mc.lap_steps, mc.laps');
    const before = await count(archon, 'SELECT count(*) AS n FROM remote_agent_workflow_events');
    const broken = await timed(() => archonRun(archon, codebase, 'broken'));
    const after = await count(archon, 'SELECT count(*) AS n FROM remote_agent_workflow_events');
    const runRow = (
      await archon.query('SELECT status FROM remote_agent_workflow_runs WHERE id = $1', [
        broken.value,
      ])
    ).rows[0];
    check(
      'broken projection: every Archon insert and update succeeds and is stored',
      after - before === 6 && runRow?.status === 'completed',
      `${after - before} events stored, run ${runRow?.status}, ${broken.ms.toFixed(0)} ms for 11 writes (healthy took ${healthy.ms.toFixed(0)} ms)`,
    );
    const deleted = await archon.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [
      broken.value,
    ]);
    check('broken projection: an Archon delete succeeds', deleted.rowCount === 1);
    const caught = (
      await setup.query('SELECT source, error_code, count FROM mc_guard.guard_errors ORDER BY 1')
    ).rows;
    check(
      'the guard counted what it caught',
      caught.length > 0,
      caught.map((r) => `${r.source} ${r.error_code} x${r.count}`).join('; '),
    );

    // 4. Speed: 200 event inserts with the broken projection attached, then with nothing attached.
    const run = String(
      (
        await archon.query(
          `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message)
           VALUES ('archon-loop', $1, 'running', 'speed') RETURNING id`,
          [codebase],
        )
      ).rows[0].id,
    );
    const burst = () =>
      timed(async () => {
        for (let i = 0; i < 200; i++) {
          await archon.query(
            `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
             VALUES ($1, $2, 'implement', $3)`,
            [
              run,
              i % 3 === 0 ? 'provider_event' : 'node_completed',
              event('implement', 'node_completed'),
            ],
          );
        }
      });
    const guarded = await burst();

    // 5. Detach: nothing left on Archon's tables, idempotent.
    await setup.query(DETACH_SQL);
    await setup.query(DETACH_SQL);
    const left = (await setup.query(ATTACHED_SQL)).rows.length;
    check(
      "detach leaves no dashboard trigger on Archon's tables, and runs twice cleanly",
      left === 0,
    );
    const bare = await burst();
    check(
      'a broken, attached dashboard does not slow Archon materially',
      guarded.ms < bare.ms * 3 + 200,
      `200 inserts: ${guarded.ms.toFixed(0)} ms attached+broken vs ${bare.ms.toFixed(0)} ms detached`,
    );

    // 6. Control: the upstream arrangement, the projection trigger straight on Archon's table.
    await setup.query(
      `CREATE TRIGGER upstream_style AFTER INSERT ON public.remote_agent_workflow_events
         FOR EACH ROW WHEN (NEW.event_type = 'node_started') EXECUTE FUNCTION mc.project_step_event()`,
    );
    let upstreamError = '';
    try {
      await archon.query(
        `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         VALUES ($1, 'node_started', 'review', $2)`,
        [run, event('review', 'node_started')],
      );
    } catch (error) {
      upstreamError = error instanceof Error ? error.message : String(error);
    }
    await setup.query('DROP TRIGGER upstream_style ON public.remote_agent_workflow_events');
    check(
      "control: without the guard, the same broken projection fails Archon's insert",
      upstreamError !== '',
      upstreamError || 'the insert succeeded',
    );
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const gone = await count(admin, 'SELECT count(*) AS n FROM pg_database WHERE datname = $1', [
      name,
    ]);
    console.log(
      `scratch database ${name} dropped (${gone === 0 ? 'confirmed gone' : 'STILL THERE'})`,
    );
    await admin.end();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
