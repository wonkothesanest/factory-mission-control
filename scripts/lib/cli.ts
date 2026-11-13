import { resolve } from 'node:path';
import { type GetFetch, type GitHub, offlineFetch, offlineGitHub } from '../../function/github';
import { type Env, loadCheckEnv } from '../../server/check-env';
import { askArchon, type RunStatus } from './archon-run';
import { type OpenDb, openDb } from './db';
import { isCheckDatabase, RefusedDatabase, requireCheckDatabase } from './guard';
import { databaseNameOf } from './target';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');

export type Sleep = (ms: number) => Promise<void>;

/** Everything a command touches outside itself, so tests can record it. */
export type Deps = {
  env: Env;
  repoRoot: string;
  /**
   * The database a connection string names (local-factory port: a local database stands
   * where a Neon branch stood, and is told apart by its name, `check-*` or not).
   */
  databaseName: (url: string) => Promise<string>;
  /**
   * The forge seam (local-factory port): GitHub-shaped reads of issues, pull requests and
   * files. Offline by default, so nothing reaches github.com; the local forge plugs in here.
   */
  github: () => GitHub;
  openDb: OpenDb;
  /** GET-only fetch for commands that read raw repository contents (`arch:parse`); offline by default. */
  fetch: GetFetch;
  now: () => Date;
  sleep: Sleep;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The `:main` commands ask; true when the operator confirmed the live database by name. */
  confirmOwner: (database: string) => boolean;
  /** Asks Archon, read-only, whether run `run` is still active. */
  runStatus: (run: string) => Promise<RunStatus>;
};

export type Main = (argv: string[], deps: Deps) => Promise<number>;

/**
 * The operator confirms a `:main` write by typing the database's name at a terminal, or, for an
 * unattended start (`start.sh`), by setting MC_OWNER_CONFIRM to that name.
 */
function confirmOwnerAtTerminal(database: string): boolean {
  if (Bun.env.MC_OWNER_CONFIRM === database) return true;
  if (!process.stdin.isTTY) return false;
  return prompt(`Type the database name (${database}) to write to it:`) === database;
}

export function defaultDeps(): Deps {
  return {
    env: Bun.env,
    repoRoot: REPO_ROOT,
    databaseName: async (url) => databaseNameOf(url),
    github: () => offlineGitHub(),
    openDb,
    fetch: offlineFetch,
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    confirmOwner: confirmOwnerAtTerminal,
    runStatus: (run) => askArchon(Bun.env, REPO_ROOT, run),
  };
}

export async function runCli(main: Main): Promise<never> {
  process.exit(await main(Bun.argv.slice(2), defaultDeps()));
}

/**
 * The exit code for a command that takes no arguments when given some: usage and 0 for `--help`,
 * usage and 2 for anything else. Undefined when `argv` is empty and the command may run. A command
 * that takes flags of its own and sends the rest here lists them in `accepted`, so the refusal
 * names the first argument it does not take rather than one it does.
 */
export function noArguments(
  argv: string[],
  usage: string,
  deps: Deps,
  accepted: string[] = [],
): number | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    deps.out(usage);
    return 0;
  }
  const refused = argv.find((arg) => !accepted.includes(arg)) ?? argv[0];
  deps.err(`unexpected argument ${refused}\n${usage}`);
  return 2;
}

/** Runs `work`, turning any failure (a refusal included) into its message and exit code 1. */
export async function failing(deps: Deps, work: () => Promise<void>): Promise<number> {
  try {
    await work();
    return 0;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * `MC_DATABASE_URL` once its database is a `check-*` one (a check's scratch database), or, for
 * the operator's `:main` commands, the live dashboard database (any name but `check-*`). Nothing
 * may connect to the URL before this returns.
 */
export async function guardedDatabaseUrl(deps: Deps, target: 'check' | 'main'): Promise<string> {
  loadCheckEnv(deps.repoRoot, deps.env);
  const url = deps.env.MC_DATABASE_URL;
  if (!url) throw new Error('MC_DATABASE_URL is not set: run `bun run fixture:branch` first');
  const name = await deps.databaseName(url);
  if (target === 'check') {
    requireCheckDatabase(name);
    return url;
  }
  if (isCheckDatabase(name)) {
    throw new RefusedDatabase(name, 'a :main command writes the live database, not a check one');
  }
  return url;
}
