// `bun scripts/restart-test.ts <archon 000_combined.sql> [--control <old checkout>]`
// (local-factory port): proves that restarting the dashboard issues no DDL and does not slow
// Archon's writes, by running the real start.sh twice against a SCRATCH database it creates and
// drops on MC_DATABASE_URL's server (Archon's schema at the pin, Archon-shaped runs).
//
// The scratch database gets an event trigger that counts every DDL command and every dropped
// object by schema (sequences, so a rolled-back transaction's DDL is counted too), and the test:
//   1. runs start.sh once (the first install: migrations, guard, mirrors) and stops the server;
//   2. holds an Archon-shaped transaction open on remote_agent_workflow_events (the state that
//      makes any trigger DDL on that table queue every later Archon write behind it), while a
//      second Archon-shaped session inserts one event row every 20 ms and updates its run every
//      100 ms, and a third samples pg_locks every 5 ms for strong locks on Archon's tables;
//   3. runs start.sh again (the restart) under that load until the server answers and its forge
//      poll has run, then stops it;
//   4. reports the DDL counted during the restart, the guard triggers' and functions' catalog row
//      versions before and after, the strong locks seen, and Archon's insert latency during the
//      restart against the same load before it.
// With --control <dir> (a checkout of the previous start, e.g. a worktree at 0426725), it then
// runs that checkout's migrate and attach the same way, under the same load, as a control.
//
// Writes Archon-shaped rows only in the scratch database, which it drops. Never prints a secret.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { withDatabase } from './lib/target';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PORT = '3093';

const AUDIT_SQL = `
CREATE SCHEMA ddl_audit;
CREATE SEQUENCE ddl_audit.commands;
CREATE SEQUENCE ddl_audit.on_archon;
CREATE SEQUENCE ddl_audit.on_dashboard;
CREATE SEQUENCE ddl_audit.on_temp;
CREATE SEQUENCE ddl_audit.on_other;
CREATE SEQUENCE ddl_audit.dropped_archon;
CREATE SEQUENCE ddl_audit.dropped_other;
CREATE TABLE ddl_audit.log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(),
  tag text, object_type text, schema_name text, identity text, app text);
-- The schema an object lives in; a trigger has none of its own, so its table's (its identity
-- reads "<trigger> on <schema>.<table>").
CREATE FUNCTION ddl_audit.schema_of(p_schema text, p_identity text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(p_schema, substring(p_identity FROM ' on ([^. ]+)[.]'), '')
$f$;
CREATE FUNCTION ddl_audit.on_command() RETURNS event_trigger LANGUAGE plpgsql AS $f$
DECLARE r record; s text;
BEGIN
  PERFORM nextval('ddl_audit.commands');
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    s := ddl_audit.schema_of(r.schema_name, r.object_identity);
    IF s = 'public' THEN PERFORM nextval('ddl_audit.on_archon');
    ELSIF s IN ('mc', 'mc_guard', 'mc_meta') THEN PERFORM nextval('ddl_audit.on_dashboard');
    ELSIF s LIKE 'pg_temp%' THEN PERFORM nextval('ddl_audit.on_temp');
    ELSE PERFORM nextval('ddl_audit.on_other');
    END IF;
    INSERT INTO ddl_audit.log (tag, object_type, schema_name, identity, app)
    VALUES (r.command_tag, r.object_type, s, r.object_identity, current_setting('application_name'));
  END LOOP;
END $f$;
CREATE FUNCTION ddl_audit.on_drop() RETURNS event_trigger LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
    IF ddl_audit.schema_of(r.schema_name, r.object_identity) = 'public' THEN PERFORM nextval('ddl_audit.dropped_archon');
    ELSE PERFORM nextval('ddl_audit.dropped_other');
    END IF;
  END LOOP;
END $f$;
CREATE EVENT TRIGGER ddl_audit_command ON ddl_command_end EXECUTE FUNCTION ddl_audit.on_command();
CREATE EVENT TRIGGER ddl_audit_drop ON sql_drop EXECUTE FUNCTION ddl_audit.on_drop();
`;

const COUNTERS = [
  'commands',
  'on_archon',
  'on_dashboard',
  'on_temp',
  'on_other',
  'dropped_archon',
  'dropped_other',
] as const;
type Counters = Record<(typeof COUNTERS)[number], number>;

const CATALOG_SQL = `SELECT string_agg(x, ', ' ORDER BY x) AS shape FROM (
  SELECT c.relname || '.' || tg.tgname || '@' || tg.xmin AS x FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
  UNION ALL
  SELECT p.proname || '()@' || p.xmin FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('mc_guard', 'mc_meta')) s`;

const STRONG_LOCKS_SQL = `SELECT DISTINCT coalesce(a.application_name, '') AS app, l.mode, l.granted, c.relname
  FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE n.nspname = 'public' AND c.relname IN ('remote_agent_workflow_runs', 'remote_agent_workflow_events')
    AND (l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock') OR NOT l.granted)`;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function connect(url: string, name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: name });
  client.on('notice', () => {});
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function counters(client: pg.Client): Promise<Counters> {
  const out = {} as Counters;
  for (const name of COUNTERS) {
    const { rows } = await client.query(
      `SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM ddl_audit.${name}`,
    );
    out[name] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

const minus = (after: Counters, before: Counters) =>
  Object.fromEntries(COUNTERS.map((k) => [k, after[k] - before[k]])) as Counters;

interface Sample {
  at: number;
  ms: number;
}

function summary(samples: Sample[]) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const pick = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
  return {
    inserts: ms.length,
    p50Ms: Number(pick(0.5).toFixed(1)),
    p99Ms: Number(pick(0.99).toFixed(1)),
    maxMs: Number((ms.at(-1) ?? 0).toFixed(1)),
    over100Ms: ms.filter((m) => m > 100).length,
  };
}

/** Archon-shaped load: an event every 20 ms and a run update every 100 ms, timed. */
function archonLoad(writer: pg.Client, run: string) {
  const samples: Sample[] = [];
  let going = true;
  let errors = 0;
  const loop = (async () => {
    let n = 0;
    while (going) {
      const t = performance.now();
      try {
        await writer.query(
          `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
           VALUES ($1, 'provider_event', 'implement', '{"type":"assistant"}')`,
          [run],
        );
        if (n % 5 === 0) {
          await writer.query(
            'UPDATE remote_agent_workflow_runs SET last_activity_at = now() WHERE id = $1',
            [run],
          );
        }
      } catch {
        errors++;
      }
      samples.push({ at: Date.now(), ms: performance.now() - t });
      n++;
      await pause(20);
    }
  })();
  return {
    samples,
    errors: () => errors,
    async stop() {
      going = false;
      await loop;
    },
  };
}

/** Samples strong locks (and lock waits) on Archon's run and event tables every 5 ms. */
function lockSampler(client: pg.Client) {
  const seen = new Map<string, number>();
  let going = true;
  const loop = (async () => {
    while (going) {
      const { rows } = await client.query(STRONG_LOCKS_SQL);
      for (const r of rows) {
        // The held Archon transaction's own RowExclusive lock is granted and not strong: not listed.
        const key = `${r.app} ${r.mode} ${r.granted ? 'held' : 'WAITING'} on ${r.relname}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      await pause(5);
    }
  })();
  return {
    async stop() {
      going = false;
      await loop;
      return Object.fromEntries(seen);
    },
  };
}

/** Runs `argv` with `env`; resolves once `ready` returns true for a line, or the process ends. */
async function runUntil(
  argv: string[],
  env: Record<string, string | undefined>,
  ready: ((line: string) => boolean) | null,
  logFile: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; readyAt: number | null; log: string[] }> {
  const proc = Bun.spawn(argv, { cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe' });
  const log: string[] = [];
  let readyAt: number | null = null;
  const readLines = async (stream: ReadableStream<Uint8Array>, onReady: () => void) => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        log.push(line);
        if (readyAt === null && ready?.(line)) {
          readyAt = Date.now();
          onReady();
        }
      }
    }
  };
  await new Promise<void>((done) => {
    void readLines(proc.stdout as ReadableStream<Uint8Array>, done);
    void readLines(proc.stderr as ReadableStream<Uint8Array>, done);
    void proc.exited.then(() => done());
  });
  await Bun.write(logFile, `${log.join('\n')}\n`);
  return { proc, readyAt, log };
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return true;
    await pause(200);
  }
  return false;
}

/** start.sh against the scratch database; stopped once it serves and its forge poll has run. */
async function startOnce(env: Record<string, string | undefined>, logFile: string) {
  const started = Date.now();
  const run = await runUntil(
    ['bash', 'start.sh'],
    env,
    (l) => l.includes('start.sh: serving on'),
    logFile,
  );
  if (run.readyAt === null) throw new Error(`start.sh did not reach "serving"; see ${logFile}`);
  const base = `http://127.0.0.1:${PORT}`;
  const healthy = await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 30_000);
  const polled = await waitFor(
    async () =>
      (((await (await fetch(`${base}/api/forge`)).json()) as { polls?: number }).polls ?? 0) >= 1,
    30_000,
  );
  const forge = await (await fetch(`${base}/api/forge`)).json().catch(() => null);
  const servedAt = Date.now();
  run.proc.kill('SIGTERM');
  await Promise.race([run.proc.exited, pause(10_000)]);
  if (run.proc.exitCode === null) run.proc.kill('SIGKILL');
  return {
    seconds: Number(((servedAt - started) / 1000).toFixed(1)),
    healthy,
    polled,
    forge,
    steps: run.log.filter(
      (l) =>
        l.includes('start.sh:') ||
        /^(attached|trigger DDL|no trigger DDL|applied|mirrors|reconcile|local-arch|archon )/.test(
          l,
        ),
    ),
    started,
    servedAt,
  };
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const schemaFile = args[0];
  const controlAt = args.indexOf('--control');
  const control = controlAt >= 0 ? args[controlAt + 1] : undefined;
  const server = Bun.env.MC_DATABASE_URL;
  if (!schemaFile || !server) {
    console.error(
      'usage: MC_DATABASE_URL=<server url> bun scripts/restart-test.ts <000_combined.sql> [--control <dir>]',
    );
    return 2;
  }
  const name = `scratch-restart-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(16)}`;
  const admin = await connect(withDatabase(server, 'postgres'), 'mc-restart-admin');
  await admin.query(`CREATE DATABASE "${name}"`);
  console.log(`scratch database ${name} created`);
  const url = withDatabase(server, name);
  const outDir = join(REPO_ROOT, '.tmp', 'restart-test');
  const clients: pg.Client[] = [];
  const report: Record<string, unknown> = { database: name };
  let ok = false;
  try {
    const setup = await connect(url, 'mc-restart-setup');
    clients.push(setup);
    await setup.query(readFileSync(schemaFile, 'utf-8'));
    const codebases = (
      await setup.query(
        `INSERT INTO remote_agent_codebases (name, default_cwd) VALUES
           ('example/widgets', '/tmp'), ('example/gadgets', '/tmp')
         RETURNING id`,
      )
    ).rows.map((r) => String(r.id));
    const run = String(
      (
        await setup.query(
          `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message, metadata)
           VALUES ('archon-loop', $1, 'running', 'restart test', '{"workflow_source": {"digest": "sha256:restart"}}')
           RETURNING id`,
          [codebases[0]],
        )
      ).rows[0].id,
    );
    // Finished runs with step events, as the live database has: a start's reconcile:laps replays
    // each one (through session temp tables) while the restart is measured.
    for (const [i, codebase] of codebases.entries()) {
      const done = String(
        (
          await setup.query(
            `INSERT INTO remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message, metadata)
             VALUES ('archon-loop', $1, 'running', $2, '{"workflow_source": {"digest": "sha256:restart"}}')
             RETURNING id`,
            [codebase, `finished ${i}`],
          )
        ).rows[0].id,
      );
      for (const step of ['pick', 'implement']) {
        for (const type of ['node_started', 'node_completed']) {
          await setup.query(
            `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
             VALUES ($1, $2, $3, $4)`,
            [
              done,
              type,
              step,
              JSON.stringify({ nodeId: step, timing: { startedAt: new Date().toISOString() } }),
            ],
          );
        }
      }
      await setup.query(
        `UPDATE remote_agent_workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
        [done],
      );
    }
    await setup.query(AUDIT_SQL);

    const env = {
      ...process.env,
      MC_DATABASE_URL: url,
      MC_OWNER_CONFIRM: name,
      MC_PORT: PORT,
      MC_FORGE_DB: Bun.env.MC_FORGE_DB,
      MC_FORGE_POLL_MS: '1000',
    };

    // 1. The first start: everything is installed.
    const before1 = await counters(setup);
    const first = await startOnce(env, join(outDir, 'start-1.log'));
    report.firstStart = { ...first, ddl: minus(await counters(setup), before1) };
    console.log(`first start: ${JSON.stringify(report.firstStart)}`);

    // 2./3. The restart, under Archon-shaped load and an open Archon transaction.
    const restart = async (label: string, work: () => Promise<unknown>) => {
      const holder = await connect(url, 'archon-shaped-holder');
      const writer = await connect(url, 'archon-shaped-writer');
      const sampler = await connect(url, 'mc-restart-lock-sampler');
      clients.push(holder, writer, sampler);
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         VALUES ($1, 'provider_event', 'held', '{"type":"assistant"}')`,
        [run],
      );
      const load = archonLoad(writer, run);
      await pause(2000);
      const catalogBefore = (await setup.query(CATALOG_SQL)).rows[0]?.shape;
      const ddlBefore = await counters(setup);
      const logFrom = Number(
        (await setup.query('SELECT coalesce(max(id), 0) AS id FROM ddl_audit.log')).rows[0]?.id,
      );
      const locks = lockSampler(sampler);
      const startedAt = Date.now();
      let result: unknown;
      let error = '';
      try {
        result = await work();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const endedAt = Date.now();
      const strong = await locks.stop();
      await pause(1000);
      await load.stop();
      await holder.query('COMMIT');
      const ddl = minus(await counters(setup), ddlBefore);
      const catalogAfter = (await setup.query(CATALOG_SQL)).rows[0]?.shape;
      const logged = (
        await setup.query(
          `SELECT tag, object_type, schema_name, identity, app FROM ddl_audit.log WHERE id > $1 ORDER BY id`,
          [logFrom],
        )
      ).rows;
      const during = load.samples.filter((s) => s.at >= startedAt && s.at <= endedAt + 1000);
      const baseline = load.samples.filter((s) => s.at < startedAt);
      return {
        label,
        error,
        result,
        ddl,
        ddlLog: logged.filter((r) => !String(r.schema_name).startsWith('pg_temp')),
        tempDdlCommands: logged.filter((r) => String(r.schema_name).startsWith('pg_temp')).length,
        catalogUnchanged: catalogBefore === catalogAfter,
        catalogBefore,
        catalogAfter,
        strongLocksOnArchonTables: strong,
        archonInsertsBefore: summary(baseline),
        archonInsertsDuringRestart: summary(during),
        archonWriteErrors: load.errors(),
      };
    };

    const second = await restart('restart (this checkout start.sh)', () =>
      startOnce(env, join(outDir, 'start-2.log')),
    );
    report.restart = second;
    console.log(`restart: ${JSON.stringify(second, null, 2)}`);

    if (control) {
      const controlEnv = { ...env, MC_FACTORIES_FILE: join(REPO_ROOT, 'factories.local.json') };
      const bun = process.execPath;
      report.control = await restart(
        `control: previous start's migrate + attach (${control})`,
        async () => {
          const migrate = await runUntil(
            [bun, join(control, 'scripts/migrate.ts'), '--main', '--configured-factories'],
            controlEnv,
            null,
            join(outDir, 'control-migrate.log'),
          );
          const attach = await runUntil(
            [bun, join(control, 'scripts/archon-guard.ts'), 'attach'],
            controlEnv,
            null,
            join(outDir, 'control-attach.log'),
          );
          return {
            migrate: migrate.proc.exitCode,
            attach: attach.proc.exitCode,
            attachLog: attach.log.slice(-4),
          };
        },
      );
      console.log(`control: ${JSON.stringify(report.control, null, 2)}`);
    }

    const r = second as Awaited<ReturnType<typeof restart>>;
    const firstDdl = (report.firstStart as { ddl: Counters }).ddl;
    const checks = {
      'the audit sees trigger DDL on Archon tables (the first start installs the guard)':
        firstDdl.on_archon > 0,
      'the restart served and polled the forge':
        (r.result as { healthy?: boolean; polled?: boolean })?.healthy === true &&
        (r.result as { polled?: boolean })?.polled === true,
      'no DDL command touched an Archon table': r.ddl.on_archon === 0 && r.ddl.dropped_archon === 0,
      'no DDL command touched the dashboard schemas':
        r.ddl.on_dashboard === 0 && r.ddl.dropped_other === 0,
      // Any other DDL is reconcile:laps's session temp tables (pg_temp), counted, never persistent.
      'any other DDL was on session temp tables only': r.ddl.on_other === 0,
      'guard triggers and functions are the same catalog rows': r.catalogUnchanged,
      'no strong lock or lock wait on Archon tables':
        Object.keys(r.strongLocksOnArchonTables as object).length === 0,
      "Archon's inserts were not slowed (max under 100 ms, none failed)":
        r.archonInsertsDuringRestart.maxMs < 100 && r.archonWriteErrors === 0,
    };
    report.checks = checks;
    for (const [check, passed] of Object.entries(checks))
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${check}`);
    ok = Object.values(checks).every(Boolean);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const gone = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    console.log(
      `scratch database ${name} dropped${gone.rowCount === 0 ? ' (confirmed gone)' : ' (STILL THERE)'}`,
    );
    await admin.end();
    await Bun.write(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  return ok ? 0 : 1;
}

process.exit(await main());
