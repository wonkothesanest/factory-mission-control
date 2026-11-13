// `bun scripts/archon-guard.ts attach|detach|status` (bin/attach.sh, bin/detach.sh): installs or
// removes the dashboard's triggers on Archon's tables in MC_DATABASE_URL's database. See
// scripts/lib/archon-guard.ts for what the guard is and why.

import { parseArgs } from 'node:util';
import {
  ATTACHED_SQL,
  attachGuard,
  DDL_ATTEMPTS,
  DDL_LOCK_TIMEOUT,
  detachSql,
  GUARD_SCHEMA,
  type ShortLockOptions,
  withShortLocks,
} from './lib/archon-guard';
import { type Deps, failing, type Main, runCli } from './lib/cli';
import type { Tx } from './lib/db';

const USAGE = [
  'usage: bun scripts/archon-guard.ts attach [--no-seed] | detach | status',
  '  attach  installs one exception-safe guard trigger per Archon table the projection reads, then',
  "          brings the run mirror up to Archon's rows (projecting runs written while detached).",
  '          A guard already in place exactly as it would be installed is left alone: no DDL, no lock.',
  "  detach  drops every dashboard trigger from Archon's tables; idempotent, and needs nothing the",
  '          dashboard installed to work.',
  "  status  lists the dashboard triggers on Archon's tables and the errors the guards caught.",
  `  Each DDL waits at most ${DDL_LOCK_TIMEOUT} for its lock on an Archon table, one table per transaction,`,
  `  and is retried (${DDL_ATTEMPTS} tries), so it never queues Archon's writes for longer than that.`,
].join('\n');

const retries = (deps: Deps, what: string): ShortLockOptions => ({
  sleep: deps.sleep,
  onRetry: (message, attempt, attempts) =>
    deps.err(
      `${what}: an Archon table was busy (${message}); trying again (${attempt}/${attempts})`,
    ),
});

async function attached(db: Tx): Promise<string[]> {
  return (await db.query(ATTACHED_SQL, [])).map((r) => `${r.table}: ${r.trigger} -> ${r.function}`);
}

export const main: Main = async (argv, deps) => {
  let parsed: { values: { help?: boolean; 'no-seed'?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' }, 'no-seed': { type: 'boolean' } },
    });
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help) {
    deps.out(USAGE);
    return 0;
  }
  if (!['attach', 'detach', 'status'].includes(command ?? '') || rest.length > 0) {
    deps.err(USAGE);
    return 2;
  }
  return failing(deps, async () => {
    const url = deps.env.MC_DATABASE_URL;
    if (!url) throw new Error('MC_DATABASE_URL is not set');
    const db = deps.openDb(url);
    try {
      if (command === 'detach') {
        // One Archon table per transaction, in name order: never one table's lock held while
        // another's is awaited.
        const rows = await db.query(ATTACHED_SQL, []);
        const tables = [...new Set(rows.map((r) => String(r.table)))].sort();
        for (const table of tables) {
          await withShortLocks(db, (tx) => tx.query(detachSql(table)), retries(deps, 'detach'));
        }
        const left = await attached(db);
        if (left.length > 0) throw new Error(`still attached: ${left.join('; ')}`);
        deps.out("detached: no dashboard trigger is left on Archon's tables");
        return;
      }
      if (command === 'attach') {
        const report = await attachGuard(db, {
          seed: !parsed.values['no-seed'],
          ...retries(deps, 'attach'),
        });
        deps.out(
          `attached guards on: ${report.attached.join(', ') || 'nothing (no shadow tables yet: run migrate first)'}`,
        );
        deps.out(
          report.changed.length > 0
            ? `trigger DDL on: ${report.changed.join(', ')}`
            : "no trigger DDL: every guard was already in place (no lock taken on Archon's tables)",
        );
        if (report.functions.length > 0) {
          deps.out(`guard functions written: ${report.functions.join(', ')}`);
        }
        if (!parsed.values['no-seed']) {
          deps.out(`mirrors brought up to Archon's rows: ${report.seeded.join(', ') || 'none'}`);
        }
      }
      const now = await attached(db);
      deps.out(now.length > 0 ? now.join('\n') : "no dashboard trigger on Archon's tables");
      const errors = await db
        .query(
          `SELECT source, error_code, count, last_at, message FROM ${GUARD_SCHEMA}.guard_errors ORDER BY last_at DESC`,
          [],
        )
        .catch(() => []);
      for (const e of errors) {
        deps.out(
          `guard caught ${e.count}x ${e.source} ${e.error_code} (last ${e.last_at}): ${e.message}`,
        );
      }
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
