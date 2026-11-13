// The Archon guard (local-factory port). HARD SAFETY RULE: nothing this dashboard installs may
// ever make an Archon write fail or slow materially.
//
// Upstream put the projection's triggers straight on Archon's tables. Their bodies catch errors,
// but some failures escape a PL/pgSQL exception block: an error raised inside the handler itself
// (its `mc.record_projection_error` call when that function is gone), a body that no longer
// compiles because a type it declares was dropped, a trigger function that is missing. Any of
// those would fail Archon's own INSERT or UPDATE.
//
// Here the projection never runs on Archon's tables directly:
//
//   public.remote_agent_X  --(one guard trigger, mc_guard.guard_X())-->  mc_guard.remote_agent_X
//                                                                         (a shadow table carrying
//                                                                          the projection triggers)
//
// * `bun run migrate` moves every trigger a migration puts on an Archon table onto that table's
//   shadow in `mc_guard`, inside the migration's own transaction (ADOPT_SQL), so Archon never sees
//   an FMC trigger but the guard.
// * The guard function copies the row into the shadow inside a BEGIN ... EXCEPTION WHEN OTHERS
//   block: whatever the projection does, raises or fails to compile, is caught there, logged with
//   RAISE WARNING, counted in mc_guard.guard_errors, and Archon's statement goes on. It declares no
//   type of ours, waits at most 100 ms for any lock (lock_timeout), and returns NULL (AFTER trigger).
// * A shadow whose triggers fire on UPDATE or DELETE is a mirror of Archon's rows (upserted,
//   deleted), so OLD and NEW in the projection mean what they meant on Archon's table. Any other
//   shadow only passes rows through: inserted, projected, deleted in the same call.
// * `bin/detach.sh` drops every FMC trigger from Archon's tables (DETACH_SQL, idempotent and
//   independent of anything FMC installed); `bin/attach.sh` installs the guards again.
// * Emergency stop from psql, no FMC code needed: `DROP SCHEMA mc_guard CASCADE;` drops every guard
//   function and with it every trigger on Archon's tables.
//
// Trigger DDL on an Archon table takes a lock that conflicts with Archon's writes, and while that
// DDL waits for its lock every Archon write to the table queues behind it. So (Archon's own adapter
// skips its trigger DDL at boot for the same reason, packages/core/src/db/adapters/postgres.ts):
// * attach compares the catalog with what it would install and issues no DDL when they match, so
//   an ordinary start takes no lock on Archon's tables at all;
// * a DDL that is needed waits at most DDL_LOCK_TIMEOUT for its lock and is retried after a pause
//   (withShortLocks), so Archon's writes queue behind it for at most that long per try;
// * each Archon table gets its own transaction, in a fixed order, so FMC never holds one Archon
//   table's lock while it waits for another's (no lock cycle with an Archon transaction).

import type { Db, Row, Tx } from './db';

export const GUARD_SCHEMA = 'mc_guard';
/** The one trigger the guard puts on each Archon table it watches. */
export const GUARD_TRIGGER = 'mc_guard_projection';
/** Archon columns that change without meaning anything to the projection (a run's heartbeat). */
export const HEARTBEAT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  remote_agent_workflow_runs: ['last_activity_at'],
};
/** How long the guard, and everything it runs, may wait for any lock before giving up. */
export const GUARD_LOCK_TIMEOUT = '100ms';
/**
 * How long a DDL that may touch an Archon table (attach, detach, a migration) waits for its lock,
 * per try. Archon's writes to that table queue behind the waiting DDL, so this is their worst
 * delay per try; well under Postgres's deadlock_timeout (1s), so FMC gives up first.
 */
export const DDL_LOCK_TIMEOUT = '50ms';
/** How many tries a short-lock transaction gets; the pauses between them grow to 1s (about 16s in all). */
export const DDL_ATTEMPTS = 20;

/** Postgres's lock_not_available (a lock wait past lock_timeout) or deadlock_detected. */
export function isLockWaitLost(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const codes = [(error as { errno?: unknown }).errno, (error as { code?: unknown }).code].map(
    String,
  );
  if (codes.includes('55P03') || codes.includes('40P01')) return true;
  const message = error instanceof Error ? error.message : '';
  return /lock timeout|deadlock detected/i.test(message);
}

export interface ShortLockOptions {
  /** Tries in all (default DDL_ATTEMPTS). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Told about each lost lock wait that will be tried again. */
  onRetry?: (message: string, attempt: number, attempts: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs `work` in its own transaction whose every lock wait ends after DDL_LOCK_TIMEOUT; a lost
 * wait rolls the transaction back and it is tried again after a pause, up to `attempts` times.
 */
export async function withShortLocks<T>(
  db: Db,
  work: (tx: Tx) => Promise<T>,
  { attempts = DDL_ATTEMPTS, sleep = defaultSleep, onRetry }: ShortLockOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      let result: T | undefined;
      await db.transaction(async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT}'`);
        result = await work(tx);
      });
      return result as T;
    } catch (error) {
      if (!isLockWaitLost(error) || attempt >= attempts) throw error;
      onRetry?.(error instanceof Error ? error.message : String(error), attempt, attempts);
      await sleep(Math.min(100 * attempt, 1000));
    }
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Run inside each migration's transaction, after its SQL: every trigger on a table in `public`
 * whose function lives in `mc` moves to the shadow table of the same name in `mc_guard` (created,
 * with Archon's primary key and no other constraint, on first use). Self-contained: it depends on
 * nothing a migration created.
 */
export const ADOPT_SQL = `DO $adopt$
DECLARE
  t record;
  def text;
  keycols text;
  col record;
  saved text := current_setting('search_path');
BEGIN
  -- Qualified names in pg_get_triggerdef, whatever the session's path.
  PERFORM set_config('search_path', 'pg_catalog', true);
  FOR t IN
    SELECT tg.oid, tg.tgname, c.relname
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
     WHERE n.nspname = 'public' AND NOT tg.tgisinternal AND pn.nspname = 'mc'
     ORDER BY c.relname, tg.tgname
  LOOP
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS ${GUARD_SCHEMA}';
    IF to_regclass(format('${GUARD_SCHEMA}.%I', t.relname)) IS NULL THEN
      EXECUTE format('CREATE TABLE ${GUARD_SCHEMA}.%I (LIKE public.%I)', t.relname, t.relname);
      FOR col IN
        SELECT a.attname FROM pg_attribute a
         WHERE a.attrelid = format('${GUARD_SCHEMA}.%I', t.relname)::regclass
           AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
      LOOP
        EXECUTE format('ALTER TABLE ${GUARD_SCHEMA}.%I ALTER COLUMN %I DROP NOT NULL', t.relname, col.attname);
      END LOOP;
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) INTO keycols
        FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indrelid = format('public.%I', t.relname)::regclass AND i.indisprimary;
      IF keycols IS NOT NULL THEN
        EXECUTE format('ALTER TABLE ${GUARD_SCHEMA}.%I ADD PRIMARY KEY (%s)', t.relname, keycols);
      END IF;
      EXECUTE format('COMMENT ON TABLE ${GUARD_SCHEMA}.%I IS %L', t.relname,
        'Shadow of public.' || t.relname || ': carries the projection triggers (scripts/lib/archon-guard.ts)');
    END IF;
    def := pg_get_triggerdef(t.oid);
    def := regexp_replace(def, '^CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER');
    def := replace(def, ' ON public.' || quote_ident(t.relname) || ' ',
      ' ON ${GUARD_SCHEMA}.' || quote_ident(t.relname) || ' ');
    EXECUTE def;
    EXECUTE format('DROP TRIGGER %I ON public.%I', t.tgname, t.relname);
  END LOOP;
  PERFORM set_config('search_path', saved, true);
END
$adopt$`;

/**
 * Drops every trigger on a table in `public` (only `table`, when given) whose function lives in
 * `mc` or `mc_guard`: the guards, and any projection trigger a migration left there. Idempotent;
 * depends on nothing FMC installed, so it works on a half-broken install.
 */
export function detachSql(table?: string): string {
  const only = table === undefined ? '' : ` AND c.relname = '${table.replace(/'/g, "''")}'`;
  return `DO $detach$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tg.tgname, c.relname
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
     WHERE n.nspname = 'public' AND NOT tg.tgisinternal AND pn.nspname IN ('mc', '${GUARD_SCHEMA}')${only}
     ORDER BY c.relname, tg.tgname
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t.tgname, t.relname);
    RAISE NOTICE 'detached % from public.%', t.tgname, t.relname;
  END LOOP;
END
$detach$`;
}

/** Every FMC trigger off every Archon table, in one statement (psql, tests). */
export const DETACH_SQL = detachSql();

/** The FMC triggers on Archon's tables now: what detach drops and attach installs. */
export const ATTACHED_SQL = `SELECT c.relname AS "table", tg.tgname AS "trigger", pn.nspname || '.' || p.proname AS "function"
  FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = tg.tgfoid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace
 WHERE n.nspname = 'public' AND NOT tg.tgisinternal AND pn.nspname IN ('mc', '${GUARD_SCHEMA}')
 ORDER BY 1, 2`;

/**
 * Live updates: every table in `mc` gets one statement-level trigger that NOTIFYs `mc_live` with
 * its name (server/live-listen.ts listens). Run after every migration run, so a new table is
 * covered. The notify is caught too: a dashboard refresh is never worth a failed write.
 */
/** mc_meta.notify_live()'s body exactly as pg_proc.prosrc keeps it. */
const NOTIFY_LIVE_BODY = `
BEGIN
  BEGIN
    PERFORM pg_notify('mc_live', TG_TABLE_NAME);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
`;

const NOTIFY_LIVE_FUNCTION_SQL = `CREATE SCHEMA IF NOT EXISTS mc_meta;
CREATE OR REPLACE FUNCTION mc_meta.notify_live() RETURNS trigger LANGUAGE plpgsql AS $notify$${NOTIFY_LIVE_BODY}$notify$`;

/** One NOTIFY trigger on each mc table that has none (a DO block: DDL only for a table lacking one). */
const LIVE_TRIGGERS_SQL = `DO $live$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'mc' AND c.relkind IN ('r', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND tg.tgname = 'mc_live_notify')
  LOOP
    EXECUTE format('CREATE TRIGGER mc_live_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON mc.%I
      FOR EACH STATEMENT EXECUTE FUNCTION mc_meta.notify_live()', t.relname);
  END LOOP;
END
$live$`;

/** Everything LIVE_NOTIFY_SQL installs, in one string (psql, tests). */
export const LIVE_NOTIFY_SQL = `${NOTIFY_LIVE_FUNCTION_SQL};\n${LIVE_TRIGGERS_SQL}`;

/**
 * Installs the live-update NOTIFY: the function when it is missing or differs, and a trigger on
 * each mc table lacking one. With both in place it runs no DDL at all (a catalog read and a DO
 * block that finds nothing to do). Touches only mc_meta and mc, never Archon's tables.
 */
export async function ensureLiveNotify(db: Tx): Promise<void> {
  const [row] = await db.query(
    `SELECT p.prosrc AS src FROM pg_proc p WHERE p.oid = to_regprocedure('mc_meta.notify_live()')`,
    [],
  );
  if (row?.src !== NOTIFY_LIVE_BODY) await db.query(NOTIFY_LIVE_FUNCTION_SQL);
  await db.query(LIVE_TRIGGERS_SQL);
}

const ERRORS_SQL = `CREATE SCHEMA IF NOT EXISTS ${GUARD_SCHEMA};
CREATE TABLE IF NOT EXISTS ${GUARD_SCHEMA}.guard_errors (
  source text NOT NULL,
  error_code text NOT NULL,
  message text NOT NULL,
  count bigint NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, error_code)
)`;

/** The guard's error counter, created only when it is missing (no DDL once it exists). */
async function ensureErrorCounter(db: Tx): Promise<void> {
  const [row] = await db.query(
    `SELECT to_regclass('${GUARD_SCHEMA}.guard_errors') IS NOT NULL AS present`,
    [],
  );
  if (row?.present !== true) await db.query(ERRORS_SQL);
}

/** The shadow tables: those in mc_guard named for a table that exists in public. */
const SHADOWS_SQL = `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '${GUARD_SCHEMA}' AND c.relkind = 'r'
    AND to_regclass(format('public.%I', c.relname)) IS NOT NULL
  ORDER BY 1`;

const COLUMNS_SQL = `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;

const KEY_SQL = `SELECT a.attname AS name
  FROM pg_index i
  CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY k.ord`;

/** tgtype bits: 4 INSERT, 8 DELETE, 16 UPDATE. */
const SHADOW_TRIGGERS_SQL = `SELECT tg.tgname AS name, tg.tgtype::int AS type, pg_get_triggerdef(tg.oid) AS def
  FROM pg_trigger tg WHERE tg.tgrelid = to_regclass($1) AND NOT tg.tgisinternal ORDER BY 1`;

export interface ShadowTrigger {
  name: string;
  type: number;
  def: string;
}

export interface GuardPlan {
  table: string;
  mode: 'mirror' | 'pass';
  ops: ('INSERT' | 'UPDATE' | 'DELETE')[];
  columns: { name: string; type: string }[];
  key: string[];
  /** The projection triggers' WHEN conditions, OR-ed: a pass-through row that meets none is skipped. */
  when: string | null;
}

/** The WHEN condition of a trigger definition, or null when it fires on every row. */
export function whenOf(def: string): string | null {
  const match = / WHEN \((.*)\) EXECUTE (?:FUNCTION|PROCEDURE) /s.exec(def);
  return match ? match[1] : null;
}

export function planGuard(
  table: string,
  shadowColumns: { name: string; type: string }[],
  archonColumns: string[],
  key: string[],
  triggers: ShadowTrigger[],
): GuardPlan {
  const insert = triggers.some((t) => (t.type & 4) !== 0);
  const del = triggers.some((t) => (t.type & 8) !== 0);
  const update = triggers.some((t) => (t.type & 16) !== 0);
  const mode = update || del ? 'mirror' : 'pass';
  const ops: GuardPlan['ops'] =
    mode === 'mirror' ? ['INSERT', 'UPDATE', 'DELETE'] : insert ? ['INSERT'] : [];
  const conditions = triggers.filter((t) => (t.type & 4) !== 0).map((t) => whenOf(t.def));
  const when =
    mode === 'pass' && conditions.length > 0 && conditions.every((c) => c !== null)
      ? conditions.map((c) => `(${c})`).join(' OR ')
      : null;
  return {
    table,
    mode,
    ops,
    columns: shadowColumns.filter((c) => archonColumns.includes(c.name)),
    key,
    when,
  };
}

/** The settings every guard function carries (pg_proc.proconfig). */
const GUARD_FUNCTION_CONFIG = [`lock_timeout=${GUARD_LOCK_TIMEOUT}`];

/** `CREATE OR REPLACE FUNCTION mc_guard.<name>()` with `body` exactly as pg_proc.prosrc keeps it. */
function guardFunctionDdl(name: string, body: string): string {
  return `CREATE OR REPLACE FUNCTION ${GUARD_SCHEMA}.${ident(name)}() RETURNS trigger
LANGUAGE plpgsql SET lock_timeout = '${GUARD_LOCK_TIMEOUT}' AS $guard$${body}$guard$`;
}

const guardFunctionName = (plan: GuardPlan) => `guard_${plan.table}`;
const truncateFunctionName = (plan: GuardPlan) => `guard_truncate_${plan.table}`;

/** The guard trigger function for `plan`: copies Archon's row into its shadow, catching everything. */
export function guardFunctionSql(plan: GuardPlan): string {
  return guardFunctionDdl(guardFunctionName(plan), guardFunctionBody(plan));
}

function guardFunctionBody(plan: GuardPlan): string {
  const shadow = `${GUARD_SCHEMA}.${ident(plan.table)}`;
  const cols = plan.columns.map((c) => ident(c.name));
  const keyMatch = (row: 'NEW' | 'OLD') =>
    plan.key.map((k) => `${ident(k)} = ${row}.${ident(k)}`).join(' AND ');
  const insertRow = `INSERT INTO ${shadow} AS s (${cols.join(', ')})
        SELECT ${cols.map((c) => `r.${c}`).join(', ')}
          FROM jsonb_populate_record(NULL::${shadow}, to_jsonb(NEW)) AS r`;
  const comparable = (alias: string, c: { name: string; type: string }) =>
    c.type === 'json' ? `${alias}.${ident(c.name)}::text` : `${alias}.${ident(c.name)}`;
  const nonKey = plan.columns.filter((c) => !plan.key.includes(c.name));
  const heartbeat = HEARTBEAT_COLUMNS[plan.table] ?? [];
  const minusHeartbeat = (row: string) =>
    heartbeat.length === 0
      ? `to_jsonb(${row})`
      : `(to_jsonb(${row}) - ARRAY[${heartbeat.map((h) => `'${h}'`).join(', ')}])`;
  const body =
    plan.mode === 'mirror'
      ? `IF TG_OP = 'DELETE' THEN
      DELETE FROM ${shadow} WHERE ${keyMatch('OLD')};
    ELSIF TG_OP = 'INSERT' OR ${minusHeartbeat('NEW')} IS DISTINCT FROM ${minusHeartbeat('OLD')} THEN
      ${insertRow}
        ON CONFLICT (${plan.key.map(ident).join(', ')}) DO UPDATE SET
          ${nonKey.map((c) => `${ident(c.name)} = EXCLUDED.${ident(c.name)}`).join(',\n          ')}
        WHERE (${nonKey.map((c) => comparable('s', c)).join(', ')})
          IS DISTINCT FROM (${nonKey.map((c) => comparable('EXCLUDED', c)).join(', ')});
    END IF;`
      : `IF ${plan.when ?? 'true'} THEN
      ${insertRow};
      DELETE FROM ${shadow} WHERE ${keyMatch('NEW')};
    END IF;`;
  return `
DECLARE
  v_state text;
  v_message text;
BEGIN
  BEGIN
    ${body}
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    v_message := SQLERRM;
    BEGIN
      RAISE WARNING 'mission-control projection skipped on %.% (%): % %',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, v_state, v_message;
      PERFORM set_config('lock_timeout', '5ms', true);
      -- (No column may be named sqlstate: PL/pgSQL would read it as the SQLSTATE variable.)
      INSERT INTO ${GUARD_SCHEMA}.guard_errors AS e (source, error_code, message)
      VALUES (TG_TABLE_NAME || ' ' || TG_OP, v_state, v_message)
      ON CONFLICT (source, error_code) DO UPDATE SET
        count = e.count + 1, message = EXCLUDED.message, last_at = EXCLUDED.last_at;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
  RETURN NULL;
END
`;
}

/**
 * A TRUNCATE of an Archon table fires no row trigger, so a mirror would keep rows Archon no longer
 * has; this empties it the same way (no projection trigger fires, as none did upstream).
 */
export function truncateFunctionSql(plan: GuardPlan): string {
  return guardFunctionDdl(truncateFunctionName(plan), truncateFunctionBody(plan));
}

function truncateFunctionBody(plan: GuardPlan): string {
  return `
BEGIN
  BEGIN
    TRUNCATE ${GUARD_SCHEMA}.${ident(plan.table)};
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      RAISE WARNING 'mission-control mirror not emptied on %.%: % %', TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
  RETURN NULL;
END
`;
}

export const GUARD_TRUNCATE_TRIGGER = 'mc_guard_truncate';

/** One trigger the guard puts on an Archon table, as pg_trigger describes it. */
interface GuardTriggerSpec {
  name: string;
  /** pg_trigger.tgtype: 1 FOR EACH ROW, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE; AFTER has no bit. */
  type: number;
  /** The function it runs, as to_regprocedure reads it. */
  function: string;
  ddl: string;
}

const OP_BITS: Record<GuardPlan['ops'][number], number> = { INSERT: 4, DELETE: 8, UPDATE: 16 };

/** The triggers `plan` puts on its Archon table: the row guard, and for a mirror the TRUNCATE one. */
export function guardTriggerSpecs(plan: GuardPlan): GuardTriggerSpec[] {
  const table = `public.${ident(plan.table)}`;
  const fn = (name: string) => `${GUARD_SCHEMA}.${ident(name)}()`;
  const specs: GuardTriggerSpec[] = [
    {
      name: GUARD_TRIGGER,
      type: plan.ops.reduce((bits, op) => bits | OP_BITS[op], 1),
      function: fn(guardFunctionName(plan)),
      ddl: `CREATE OR REPLACE TRIGGER ${GUARD_TRIGGER} AFTER ${plan.ops.join(' OR ')} ON ${table}
  FOR EACH ROW EXECUTE FUNCTION ${fn(guardFunctionName(plan))}`,
    },
  ];
  if (plan.mode === 'mirror') {
    specs.push({
      name: GUARD_TRUNCATE_TRIGGER,
      type: 32,
      function: fn(truncateFunctionName(plan)),
      ddl: `CREATE OR REPLACE TRIGGER ${GUARD_TRUNCATE_TRIGGER} AFTER TRUNCATE ON ${table}
  FOR EACH STATEMENT EXECUTE FUNCTION ${fn(truncateFunctionName(plan))}`,
    });
  }
  return specs;
}

export function guardTriggerSql(plan: GuardPlan): string {
  return guardTriggerSpecs(plan)
    .map((spec) => spec.ddl)
    .join(';\n');
}

/**
 * Whether the trigger is on `table` exactly as `spec` would put it: same events, AFTER, enabled,
 * no WHEN, no arguments, no column list, not a constraint trigger, the same function. A catalog
 * read: it takes no lock on the table.
 */
const TRIGGER_MATCHES_SQL = `SELECT count(*)::int AS n FROM pg_trigger tg
  WHERE tg.tgrelid = to_regclass($1::text) AND tg.tgname = $2::text AND NOT tg.tgisinternal
    AND tg.tgtype::int = $3::int AND tg.tgenabled::text = 'O' AND tg.tgqual IS NULL
    AND tg.tgnargs = 0 AND cardinality(tg.tgattr::int2[]) = 0 AND tg.tgconstraint = 0
    AND tg.tgfoid = to_regprocedure($4::text)`;

async function triggerMatches(db: Tx, table: string, spec: GuardTriggerSpec): Promise<boolean> {
  const [row] = await db.query(TRIGGER_MATCHES_SQL, [
    `public.${ident(table)}`,
    spec.name,
    spec.type,
    spec.function,
  ]);
  return Number(row?.n) === 1;
}

/** The function's body, settings, language and return type as pg_proc keeps them, or nothing. */
const FUNCTION_SQL = `SELECT p.prosrc AS src, array_to_string(p.proconfig, E'\\n') AS config,
    l.lanname AS lang, p.prorettype = 'trigger'::regtype AS returns_trigger
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure($1::text)`;

async function functionMatches(db: Tx, name: string, body: string): Promise<boolean> {
  const [row] = await db.query(FUNCTION_SQL, [`${GUARD_SCHEMA}.${ident(name)}()`]);
  return (
    row !== undefined &&
    row.src === body &&
    row.config === GUARD_FUNCTION_CONFIG.join('\n') &&
    row.lang === 'plpgsql' &&
    row.returns_trigger === true
  );
}

/** Brings a mirror up to Archon's rows: inserts and updates what differs, deletes what Archon lost. */
export function seedMirrorSql(plan: GuardPlan): string[] {
  const shadow = `${GUARD_SCHEMA}.${ident(plan.table)}`;
  const cols = plan.columns.map((c) => ident(c.name));
  const nonKey = plan.columns.filter((c) => !plan.key.includes(c.name));
  const comparable = (alias: string, c: { name: string; type: string }) =>
    c.type === 'json' ? `${alias}.${ident(c.name)}::text` : `${alias}.${ident(c.name)}`;
  return [
    `DELETE FROM ${shadow} s WHERE NOT EXISTS (SELECT 1 FROM public.${ident(plan.table)} p
       WHERE ${plan.key.map((k) => `p.${ident(k)} = s.${ident(k)}`).join(' AND ')})`,
    `INSERT INTO ${shadow} AS s (${cols.join(', ')})
       SELECT ${cols.map((c) => `p.${c}`).join(', ')} FROM public.${ident(plan.table)} p
       ON CONFLICT (${plan.key.map(ident).join(', ')}) DO UPDATE SET
         ${nonKey.map((c) => `${ident(c.name)} = EXCLUDED.${ident(c.name)}`).join(', ')}
       WHERE (${nonKey.map((c) => comparable('s', c)).join(', ')})
         IS DISTINCT FROM (${nonKey.map((c) => comparable('EXCLUDED', c)).join(', ')})`,
  ];
}

const str = (row: Row, key: string) => String(row[key]);

/** Reads what the guard needs from the catalog and plans one guard per shadow table. */
export async function planGuards(db: Tx): Promise<GuardPlan[]> {
  const plans: GuardPlan[] = [];
  for (const shadow of await db.query(SHADOWS_SQL, [])) {
    const table = str(shadow, 'name');
    const shadowName = `${GUARD_SCHEMA}.${ident(table)}`;
    const publicName = `public.${ident(table)}`;
    const archon = (await db.query(COLUMNS_SQL, [publicName])).map((r) => ({
      name: str(r, 'name'),
      type: str(r, 'type'),
    }));
    let have = (await db.query(COLUMNS_SQL, [shadowName])).map((r) => str(r, 'name'));
    // A column Archon added since the shadow was made: the shadow gets it, nullable.
    for (const column of archon.filter((c) => !have.includes(c.name))) {
      await db.query(
        `ALTER TABLE ${shadowName} ADD COLUMN IF NOT EXISTS ${ident(column.name)} ${column.type}`,
        [],
      );
    }
    have = [...have, ...archon.filter((c) => !have.includes(c.name)).map((c) => c.name)];
    const shadowColumns = (await db.query(COLUMNS_SQL, [shadowName])).map((r) => ({
      name: str(r, 'name'),
      type: str(r, 'type'),
    }));
    const key = (await db.query(KEY_SQL, [shadowName])).map((r) => str(r, 'name'));
    const triggers = (await db.query(SHADOW_TRIGGERS_SQL, [shadowName])).map((r) => ({
      name: str(r, 'name'),
      type: Number(r.type),
      def: str(r, 'def'),
    }));
    if (key.length === 0 || triggers.length === 0) continue;
    plans.push(
      planGuard(
        table,
        shadowColumns,
        archon.map((c) => c.name),
        key,
        triggers,
      ),
    );
  }
  return plans.filter((plan) => plan.ops.length > 0);
}

/** How long seeding a mirror waits for a lock: it writes only mc_guard and mc, never Archon's tables. */
export const SEED_LOCK_TIMEOUT = '2s';

export interface AttachReport {
  /** Every Archon table whose guard is in place afterwards. */
  attached: string[];
  /** The Archon tables whose triggers needed DDL (the others were left untouched, unlocked). */
  changed: string[];
  /** The guard functions (re)written, by name: new or different from what pg_proc held. */
  functions: string[];
  seeded: string[];
}

/**
 * Installs the guards: the error counter, one guard function per shadow table, and one guard
 * trigger per Archon table. Each step compares the catalog first and writes only what differs, so
 * attaching an attached guard runs no DDL at all. The functions (no lock on Archon's tables) go in
 * one short-lock transaction; each Archon table's triggers go in their own, in table order, so no
 * lock on one Archon table is held while another's is awaited. With `seed`, each mirror is then
 * brought up to Archon's rows, which projects any run the mirror lacks (a first attach, or runs
 * written while detached).
 */
export async function attachGuard(
  db: Db,
  { seed = false, ...locks }: { seed?: boolean } & ShortLockOptions = {},
): Promise<AttachReport> {
  const report: AttachReport = { attached: [], changed: [], functions: [], seeded: [] };
  const plans = await withShortLocks(
    db,
    async (tx) => {
      // A retry after a lost lock wait starts this transaction over: so does its record.
      report.functions = [];
      await ensureErrorCounter(tx);
      const planned = (await planGuards(tx)).sort((a, b) => a.table.localeCompare(b.table));
      for (const plan of planned) {
        const functions: [string, string][] = [[guardFunctionName(plan), guardFunctionBody(plan)]];
        if (plan.mode === 'mirror') {
          functions.push([truncateFunctionName(plan), truncateFunctionBody(plan)]);
        }
        for (const [name, body] of functions) {
          if (await functionMatches(tx, name, body)) continue;
          await tx.query(guardFunctionDdl(name, body));
          report.functions.push(name);
        }
      }
      return planned;
    },
    locks,
  );
  for (const plan of plans) {
    const specs = guardTriggerSpecs(plan);
    const stale: GuardTriggerSpec[] = [];
    for (const spec of specs) if (!(await triggerMatches(db, plan.table, spec))) stale.push(spec);
    if (stale.length > 0) {
      // Checked again inside the transaction: a retry after a lost lock wait may find it in place.
      await withShortLocks(
        db,
        async (tx) => {
          for (const spec of stale) {
            if (!(await triggerMatches(tx, plan.table, spec))) await tx.query(spec.ddl);
          }
        },
        locks,
      );
      report.changed.push(plan.table);
    }
    report.attached.push(plan.table);
  }
  // After the triggers, so a row Archon writes meanwhile is upserted by its guard, not missed.
  if (seed) {
    await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL lock_timeout = '${SEED_LOCK_TIMEOUT}'`);
      report.seeded.push(...(await seedMirrors(tx)));
    });
  }
  return report;
}

/**
 * Brings each mirror up to Archon's rows, without touching Archon's tables' triggers (no DDL lock
 * on them): for after `attachGuard`, in its own transaction.
 */
export async function seedMirrors(db: Tx): Promise<string[]> {
  const seeded: string[] = [];
  for (const plan of (await planGuards(db)).filter((p) => p.mode === 'mirror')) {
    for (const sql of seedMirrorSql(plan)) await db.query(sql, []);
    seeded.push(plan.table);
  }
  return seeded;
}

/** Drops every FMC trigger from Archon's tables; answers the ones still there (none). */
export async function detachGuard(db: Tx): Promise<Row[]> {
  await db.query(DETACH_SQL);
  return db.query(ATTACHED_SQL, []);
}
