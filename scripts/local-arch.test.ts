import { afterEach, beforeAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHON_TABLES, testDb } from '../db/test-db';
import { ARCH_TABLES } from './arch-parse';
import { REPO_ROOT } from './lib/cli';
import type { Db } from './lib/db';
import { DATABASE_URL, recordingDeps, scratchRepo } from './lib/test-deps';
import { main } from './local-arch';
import { migrationsDir, readMigrationFiles, runMigrations } from './migrate';

const PACK = join(REPO_ROOT, 'fixtures/pack');
const TEMPLATE = join(REPO_ROOT, 'fixtures/factory-template');
const ARCHON_SHA = readFileSync(join(PACK, 'ARCHON_COMMIT'), 'utf8').trim();

const pg = testDb();
const db: Db = { ...pg, async close() {} };
const scratch: string[] = [];

beforeAll(async () => {
  await pg.query(ARCHON_TABLES);
  await runMigrations({ files: readMigrationFiles(migrationsDir(REPO_ROOT)), db: pg });
});
afterEach(async () => {
  for (const table of ['arch_versions', ...ARCH_TABLES]) await pg.query(`DELETE FROM mc.${table}`);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A factory layout: apps/<repo>/factory/pack.json, the Archon cache, a template in a git checkout. */
function factory(pins: Record<string, string>, { cached = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-local-arch-'));
  scratch.push(root);
  for (const [repo, sha] of Object.entries(pins)) {
    mkdirSync(join(root, 'apps', repo, 'factory'), { recursive: true });
    writeFileSync(
      join(root, 'apps', repo, 'factory', 'pack.json'),
      JSON.stringify({ integration_revision_required: sha }),
    );
  }
  if (cached)
    cpSync(PACK, join(root, 'cache', 'factory', 'archon', ARCHON_SHA, '.archon', 'workflows'), {
      recursive: true,
    });
  const checkout = join(root, 'upstream', 'ai-software-factory');
  cpSync(TEMPLATE, join(checkout, 'template'), { recursive: true });
  // The checkout's commit names the factory version, so the fixture's recorded commit goes.
  rmSync(join(checkout, 'template', 'FACTORY_COMMIT'));
  const git = (...args: string[]) =>
    Bun.spawnSync(
      ['git', '-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args],
      {
        env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', HOME: root },
      },
    );
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'template');
  const head = Bun.spawnSync(['git', '-C', checkout, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const factories = join(root, 'factories.json');
  writeFileSync(
    factories,
    JSON.stringify({
      factories: Object.keys(pins).map((repo) => ({
        name: repo,
        repository: `example/${repo}`,
        codebase: `example/${repo}`,
        console: 'http://localhost:3090',
      })),
    }),
  );
  return { root, head, factories };
}

async function run(root: string, factories: string) {
  const repoRoot = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(repoRoot);
  const recorder = recordingDeps({
    repoRoot,
    branchName: 'check-abc',
    env: { FACTORY_ROOT: root, MC_FACTORIES_FILE: factories },
  });
  recorder.deps.openDb = (url) => {
    recorder.opened.push(url);
    return db;
  };
  return { ...recorder, exit: await main([], recorder.deps) };
}

test('parses each pinned Archon sha once, from local paths, and leaves a stored one alone', async () => {
  const { root, head, factories } = factory({
    widgets: ARCHON_SHA,
    gadgets: ARCHON_SHA,
  });
  const first = await run(root, factories);
  expect(first.err).toEqual([]);
  expect(first.exit).toBe(0);
  expect(first.out[0]).toBe(
    `local-arch: ${ARCHON_SHA} pinned by widgets, gadgets; factory template at ${head}`,
  );
  expect(first.requests).toEqual([]);
  expect(await pg.query('SELECT archon_sha, factory_sha FROM mc.arch_versions')).toEqual([
    { archon_sha: ARCHON_SHA, factory_sha: head },
  ]);
  const versions = () =>
    pg.query('SELECT xmin::text AS x FROM mc.arch_steps ORDER BY workflow, path');
  const before = await versions();
  expect(before.length).toBeGreaterThan(0);

  const second = await run(root, factories);
  expect(second.exit).toBe(0);
  expect(second.out).toContain(`archon ${ARCHON_SHA} factory ${head} already stored`);
  expect(await versions()).toEqual(before);
});

test('a pinned sha with no local pack is an error that stores nothing', async () => {
  const { root, factories } = factory({ widgets: ARCHON_SHA }, { cached: false });
  const job = await run(root, factories);
  expect(job.exit).toBe(1);
  expect(job.err.join('\n')).toContain('has no pack at');
  expect(await pg.query('SELECT 1 FROM mc.arch_versions')).toEqual([]);
});

test('no pack file pins anything: nothing to parse', async () => {
  const { root, factories } = factory({});
  const job = await run(root, factories);
  expect(job.exit).toBe(0);
  expect(job.out.join('\n')).toContain('nothing to parse');
  expect(job.opened).toEqual([]);
});
