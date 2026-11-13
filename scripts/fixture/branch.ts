// `bun run fixture:branch` (local-factory port): Neon branches are gone. A check gets its own
// scratch database, `check-<id>`, on the same Postgres server as MC_DATABASE_URL (the factory's),
// holding Archon's schema snapshot (fixtures/archon-schema.sql), the migrations and the seed. Each
// checkout, worktree or parallel instance makes its own, so checks never share rows; the live
// dashboard database is never written. `bun run fixture:drop` removes it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE, formatCheckEnv, parseCheckEnv } from '../../server/check-env';
import { type Deps, failing, type Main, noArguments, runCli } from '../lib/cli';
import { isCheckDatabase, requireCheckDatabase } from '../lib/guard';
import { withDatabase } from '../lib/target';
import { migrationsDir, readMigrationFiles, runMigrations } from '../migrate';

/** The maintenance database a check database is created and dropped from. */
export const ADMIN_DATABASE = 'postgres';

const USAGE =
  "usage: bun run fixture:branch (creates a check-* database on MC_DATABASE_URL's server with Archon's schema snapshot, the migrations and fixtures/seed.sql, and writes .mc-check.env naming it; run with the server's own MC_DATABASE_URL, never a check one)";

export function newCheckDatabaseName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `check-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A database name as an SQL identifier: check names hold a dash. */
export const quoteDatabase = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The server's connection string: MC_DATABASE_URL from the launching process, never a check one. */
async function serverUrl(deps: Deps): Promise<string> {
  const url = deps.env.MC_DATABASE_URL;
  if (!url) throw new Error("MC_DATABASE_URL is not set: give the factory database's URL");
  if (isCheckDatabase(await deps.databaseName(url))) {
    throw new Error(
      'MC_DATABASE_URL already names a check database: run fixture:branch with the server URL',
    );
  }
  return url;
}

async function createCheckDatabase(deps: Deps): Promise<void> {
  const envFile = join(deps.repoRoot, CHECK_ENV_FILE);
  const existing = existsSync(envFile)
    ? parseCheckEnv(readFileSync(envFile, 'utf-8')).MC_CHECK_DATABASE
    : undefined;
  if (existing) {
    throw new Error(
      `${CHECK_ENV_FILE} already names ${existing}: run \`bun run fixture:drop\` first`,
    );
  }
  const server = await serverUrl(deps);
  const name = newCheckDatabaseName();
  requireCheckDatabase(name);
  const admin = deps.openDb(withDatabase(server, ADMIN_DATABASE));
  try {
    await admin.query(`CREATE DATABASE ${quoteDatabase(name)}`);
  } finally {
    await admin.close();
  }
  const url = withDatabase(server, name);
  try {
    const db = deps.openDb(url);
    try {
      const archon = join(deps.repoRoot, 'fixtures', 'archon-schema.sql');
      await db.query(readFileSync(archon, 'utf-8'));
      deps.out('loaded fixtures/archon-schema.sql');
      for (const applied of await runMigrations({
        files: readMigrationFiles(migrationsDir(deps.repoRoot)),
        db,
      })) {
        deps.out(`applied ${applied}`);
      }
      const seed = join(deps.repoRoot, 'fixtures', 'seed.sql');
      if (existsSync(seed)) {
        const sql = readFileSync(seed, 'utf-8');
        await db.transaction((tx) => tx.query(sql).then(() => undefined));
        deps.out('loaded fixtures/seed.sql');
      }
    } finally {
      await db.close();
    }
    writeFileSync(envFile, formatCheckEnv({ MC_CHECK_DATABASE: name, MC_DATABASE_URL: url }), {
      mode: 0o600,
    });
  } catch (error) {
    const cleanup = deps.openDb(withDatabase(server, ADMIN_DATABASE));
    await cleanup
      .query(`DROP DATABASE IF EXISTS ${quoteDatabase(name)} WITH (FORCE)`)
      .catch((e) => deps.err(`could not drop ${name}, fixture:drop --all will: ${e}`))
      .finally(() => cleanup.close());
    throw error;
  }
  deps.out(`created ${name}`);
  deps.out(`wrote ${CHECK_ENV_FILE}`);
}

export const main: Main = async (argv, deps) =>
  noArguments(argv, USAGE, deps) ?? failing(deps, () => createCheckDatabase(deps));

if (import.meta.main) await runCli(main);
