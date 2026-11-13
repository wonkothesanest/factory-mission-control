// `bun run fixture:drop` (local-factory port): drops this checkout's check database (the one
// `.mc-check.env` names) and removes the file. `--all` also drops every other `check-*` database
// on the server: for cleaning up after crashed checks, when no other check is running. Only
// `check-*` databases are ever dropped.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_FILE, parseCheckEnv } from '../../server/check-env';
import { type Deps, failing, type Main, noArguments, runCli } from '../lib/cli';
import { isCheckDatabase, requireCheckDatabase } from '../lib/guard';
import { databaseNameOf, withDatabase } from '../lib/target';
import { ADMIN_DATABASE, quoteDatabase } from './branch';

const USAGE = [
  'usage: bun run fixture:drop (drops the check-* database .mc-check.env names and removes the file)',
  '       bun run fixture:drop --all (also drops every other check-* database on the server; only when no other check is running)',
].join('\n');

async function drop(deps: Deps, all: boolean): Promise<void> {
  const envFile = join(deps.repoRoot, CHECK_ENV_FILE);
  const recorded = existsSync(envFile) ? parseCheckEnv(readFileSync(envFile, 'utf-8')) : {};
  const own = recorded.MC_CHECK_DATABASE;
  if (own !== undefined) requireCheckDatabase(own);
  const server = recorded.MC_DATABASE_URL ?? deps.env.MC_DATABASE_URL;
  if (!server) {
    deps.out(`no ${CHECK_ENV_FILE} and no MC_DATABASE_URL: nothing to drop`);
    return;
  }
  if (own !== undefined && databaseNameOf(server) !== own) {
    throw new Error(`${CHECK_ENV_FILE} names ${own} but its URL names another database`);
  }
  const admin = deps.openDb(withDatabase(server, ADMIN_DATABASE));
  try {
    const names = new Set<string>(own === undefined ? [] : [own]);
    if (all) {
      for (const row of await admin.query(
        "SELECT datname FROM pg_database WHERE datname LIKE 'check-%' ORDER BY 1",
        [],
      )) {
        if (isCheckDatabase(String(row.datname))) names.add(String(row.datname));
      }
    }
    for (const name of names) {
      requireCheckDatabase(name);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(name)} WITH (FORCE)`);
      deps.out(`dropped ${name}`);
    }
    if (names.size === 0) deps.out('no check database to drop');
  } finally {
    await admin.close();
  }
  if (own !== undefined) {
    rmSync(envFile, { force: true });
    deps.out(`removed ${CHECK_ENV_FILE}`);
  }
}

export const main: Main = async (argv, deps) => {
  if (argv.length === 1 && argv[0] === '--all') return failing(deps, () => drop(deps, true));
  return noArguments(argv, USAGE, deps, ['--all']) ?? failing(deps, () => drop(deps, false));
};

if (import.meta.main) await runCli(main);
