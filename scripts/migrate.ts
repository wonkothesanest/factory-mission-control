import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import factories from '../factories.json';
import { readFactories } from '../server/factories';
import {
  ADOPT_SQL,
  attachGuard,
  ensureLiveNotify,
  type ShortLockOptions,
  withShortLocks,
} from './lib/archon-guard';
import { failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Db } from './lib/db';
import { loadFactories } from './lib/load-factories';

export type MigrationFile = { name: string; sql: string };

export function readMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf-8') }));
}

/**
 * The `00NN_` files that predate the timestamp form (#580). They keep their names because the
 * runner records applied migrations by filename. Never add to it: a new migration uses the timestamp form.
 */
export const LEGACY_MIGRATIONS: ReadonlySet<string> = new Set([
  '0001_mc_schema.sql',
  '0002_github_mirror.sql',
  '0003_versions_decisions.sql',
  '0004_architecture.sql',
  '0005_laps.sql',
  '0006_projection.sql',
  '0007_step_attempts.sql',
  '0008_rewind_branches.sql',
  '0008_versions_projection.sql',
  '0009_project_run_compiles_unlocked.sql',
  '0010_step_attempt_eligibility.sql',
  '0011_pin_full_archon_sha.sql',
  '0012_arch_text_lf.sql',
  '0013_step_attempt_identity.sql',
  '0014_pre_existing_refs.sql',
  '0015_step_attempt_usage.sql',
  '0016_pin_reason_optional.sql',
  '0017_app_check_line_ids.sql',
  '0018_issue_label_time.sql',
  '0019_attention_items.sql',
  '0019_queue_laps.sql',
  '0019_structured_output_string.sql',
  '0020_queue_step_events.sql',
  '0021_split_step_events.sql',
  '0022_queue_versions.sql',
  '0023_arch_step_child_workflow.sql',
  '0024_queue_app_check_lines.sql',
  '0025_queue_app_check_sealed.sql',
  '0026_pull_request_references.sql',
  '0027_queue_app_check_published.sql',
  '0028_work_item_states.sql',
  '0029_lap_step_pr_number.sql',
  '0030_aggregate_attempt_cost.sql',
  '0031_attention_data.sql',
  '0031_run_stops.sql',
  '0032_attempt_event_time.sql',
  '0032_lap_step_pr_url.sql',
  '0032_stop_line.sql',
]);

/** A new migration's name: `<YYYYMMDDTHHMMZ>_<name>.sql`, e.g. `20261109T1430Z_stop_line.sql`. */
export const TIMESTAMP_MIGRATION = /^\d{8}T\d{4}Z_[a-z0-9_]+\.sql$/;

/** Names that are neither legacy nor timestamp-form, and timestamp prefixes shared by more than one file. */
export function migrationNameProblems(names: readonly string[]): string[] {
  const sql = [...names].sort();
  const problems = sql
    .filter((name) => !LEGACY_MIGRATIONS.has(name) && !TIMESTAMP_MIGRATION.test(name))
    .map(
      (name) =>
        `${name} is not named <YYYYMMDDTHHMMZ>_<name>.sql with <name> in lowercase a-z, 0-9 and _ (e.g. 20261109T1430Z_stop_line.sql)`,
    );
  const byPrefix = new Map<string, string[]>();
  for (const name of sql.filter((n) => TIMESTAMP_MIGRATION.test(n))) {
    const prefix = name.slice(0, name.indexOf('_'));
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }
  for (const [prefix, group] of byPrefix) {
    if (group.length > 1) problems.push(`${group.join(', ')} share the prefix ${prefix}`);
  }
  return problems;
}

export function migrationsDir(repoRoot: string): string {
  return join(repoRoot, 'db', 'migrations');
}

/**
 * The ledger of applied migrations. local-factory port: it lives in the dashboard's own
 * schema `mc_meta`, not in `public`, which is Archon's.
 */
export const LEDGER = 'mc_meta.schema_migrations';

/**
 * Applies each file not yet recorded, file and record in one transaction; returns those applied.
 * In the same transaction, any trigger the file put on an Archon table moves onto its shadow in
 * `mc_guard` (scripts/lib/archon-guard.ts ADOPT_SQL), so Archon's tables never carry one. After the
 * files, every dashboard table gets its live-update NOTIFY trigger, and, unless `guard` is false,
 * the guard triggers that feed the projection from Archon's tables are attached (attachGuard: no
 * DDL when they are already in place).
 *
 * A migration can lock an Archon table (a trigger on it, or ADOPT_SQL moving one off it), and
 * Archon's writes queue behind a DDL that waits for its lock. So every transaction here waits at
 * most DDL_LOCK_TIMEOUT for any lock and is retried after a pause (withShortLocks), and the
 * guard's DDL is never folded into a migration's transaction.
 */
export async function runMigrations({
  files,
  db,
  guard = true,
  ...locks
}: {
  files: MigrationFile[];
  db: Db;
  guard?: boolean;
} & ShortLockOptions): Promise<string[]> {
  // Created only when missing: a run with nothing to apply issues no DDL at all.
  const [ledger] = await db.query(`SELECT to_regclass('${LEDGER}') IS NOT NULL AS present`);
  if (ledger?.present !== true) {
    await db.query('CREATE SCHEMA IF NOT EXISTS mc_meta');
    await db.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
  }
  const recorded = new Set(
    (await db.query(`SELECT name FROM ${LEDGER}`)).map((row) => String(row.name)),
  );
  const applied: string[] = [];
  for (const file of files) {
    if (recorded.has(file.name)) continue;
    try {
      await withShortLocks(
        db,
        async (tx) => {
          await tx.query(file.sql);
          await tx.query(ADOPT_SQL);
          await tx.query(`INSERT INTO ${LEDGER} (name) VALUES ($1)`, [file.name]);
        },
        locks,
      );
    } catch (error) {
      const committed = applied.length > 0 ? ` after applying ${applied.join(', ')}` : '';
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${file.name} failed${committed}: ${reason}`, { cause: error });
    }
    applied.push(file.name);
  }
  // Only the dashboard's own tables: a NOTIFY trigger on each mc table that lacks one (no DDL
  // when every table has one and the function is current).
  await withShortLocks(db, (tx) => ensureLiveNotify(tx), locks);
  if (guard) await attachGuard(db, locks);
  return applied;
}

const USAGE = [
  'usage: bun run migrate (the check database in .mc-check.env) | bun run migrate:main (the live dashboard database)',
  '  After adding a factory, load it and attribute its existing laps on the live database:',
  '  bun run migrate -- --configured-factories (check-* only)',
  '  bun run migrate:main -- --configured-factories (the live database; the operator confirms its name at a terminal, or MC_OWNER_CONFIRM names it)',
  '  --configured-factories reads MC_FACTORIES_FILE when nonempty, otherwise the repository factories.json.',
  "  --no-attach applies the migrations without the guard triggers on Archon's tables (as bin/detach.sh left them).",
  '  Use the same MC_DATABASE_URL and MC_FACTORIES_FILE as the server; .mc-check.env fills unset values.',
  '  Without --configured-factories, migrate loads the committed factories.json regardless of MC_FACTORIES_FILE.',
].join('\n');

export const main: Main = async (argv, deps) => {
  let values: {
    main?: boolean;
    help?: boolean;
    'configured-factories'?: boolean;
    'no-attach'?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        main: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        'configured-factories': { type: 'boolean' },
        'no-attach': { type: 'boolean' },
      },
    }));
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  const target = values.main ? 'main' : 'check';
  return failing(deps, async () => {
    const url = await guardedDatabaseUrl(deps, target);
    if (target === 'main' && !deps.confirmOwner(await deps.databaseName(url))) {
      throw new Error('migrate:main is for the owner, at a terminal (or MC_OWNER_CONFIRM)');
    }
    const entries = values['configured-factories']
      ? readFactories(deps.env, deps.repoRoot)
      : factories.factories;
    const db = deps.openDb(url);
    try {
      const applied = await runMigrations({
        files: readMigrationFiles(migrationsDir(deps.repoRoot)),
        db,
        guard: !values['no-attach'],
      });
      for (const name of applied) deps.out(`applied ${name}`);
      deps.out(`applied ${applied.length} migration(s)`);
      const changed = await loadFactories({ entries, db });
      const source = values['configured-factories'] ? 'configured factories' : 'factories.json';
      deps.out(
        `${source}: ${changed.factories} factory row(s) written, ${changed.laps} lap(s) re-attributed`,
      );
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
