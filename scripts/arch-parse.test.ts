import { afterEach, beforeAll, expect, test } from 'bun:test';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ARCHON_TABLES, testDb } from '../db/test-db';
import { FACTORY_PACKAGE_DIR, HOOKS_DIR, parsePack, type Step } from '../parsers/pack';
import { ARCH_TABLES, archRows, main } from './arch-parse';
import { REPO_ROOT } from './lib/cli';
import type { Db } from './lib/db';
import { DATABASE_URL, recordingDeps, scratchRepo } from './lib/test-deps';
import { migrationsDir, readMigrationFiles, runMigrations } from './migrate';

const PACK = join(REPO_ROOT, 'fixtures/pack');
const TEMPLATE = join(REPO_ROOT, 'fixtures/factory-template');
const ARCHON_SHA = readFileSync(join(PACK, 'ARCHON_COMMIT'), 'utf8').trim();
const FACTORY_SHA = readFileSync(join(TEMPLATE, 'FACTORY_COMMIT'), 'utf8').trim();
const PACKAGE = join(PACK, 'queue/factory');
const PACKAGE_SHA = readFileSync(join(PACK, 'queue/FACTORY_COMMIT'), 'utf8').trim();
const LOCAL = ['--archon-path', PACK, '--factory-path', TEMPLATE];
const TABLES = ['arch_versions', ...ARCH_TABLES];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(dir);
  return dir;
}

const pg = testDb();
/** The same in-memory database for every run, so a second run sees the first one's rows. */
const db: Db = { ...pg, async close() {} };

beforeAll(async () => {
  await pg.query(ARCHON_TABLES);
  await runMigrations({ files: readMigrationFiles(migrationsDir(REPO_ROOT)), db: pg });
});

afterEach(async () => {
  for (const table of TABLES) await pg.query(`DELETE FROM mc.${table}`);
});

/** Runs the job against the shared database on branch `check-abc` unless `options` says otherwise. */
async function run(
  argv: string[],
  options: Partial<Parameters<typeof recordingDeps>[0]> = {},
  now?: Date,
) {
  const recorder = recordingDeps({ repoRoot: repo(), branchName: 'check-abc', ...options });
  recorder.deps.openDb = (url) => {
    recorder.opened.push(url);
    return db;
  };
  if (now) recorder.deps.now = () => now;
  return { ...recorder, exit: await main(argv, recorder.deps) };
}

/** Each table's row count, as the job prints it. */
const counts = (out: string[]) => out.filter((line) => line.startsWith('mc.'));

const everyRow = () =>
  Promise.all(
    TABLES.map((table) => pg.query(`SELECT * FROM mc.${table} AS row ORDER BY row::text`)),
  );

test('stores the archon-loop steps in parser order, keyed by the full shas', async () => {
  const job = await run([ARCHON_SHA.slice(0, 8), FACTORY_SHA, ...LOCAL]);
  expect(job.exit).toBe(0);
  expect(job.out[0]).toBe(`archon ${ARCHON_SHA} factory ${FACTORY_SHA}`);
  expect(counts(job.out)).toContain('mc.arch_versions 1');

  const stored = await pg.query(
    `SELECT path FROM mc.arch_steps WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' ORDER BY position`,
    [ARCHON_SHA, FACTORY_SHA],
  );
  const loop = parsePack(join(PACK, 'sdlc'), TEMPLATE).workflows.find(
    (w) => w.name === 'archon-loop',
  );
  const inOrder = (step: Step): string[] => [step.path, ...step.steps.flatMap(inOrder)];
  expect(loop).toBeDefined();
  expect(stored.map((row) => row.path)).toEqual(loop?.steps.flatMap(inOrder) ?? []);
  expect(job.requests).toEqual([]);
});

test('a second run for the same shas leaves every row as it was', async () => {
  const first = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL]);
  expect(first.exit).toBe(0);
  const before = await everyRow();

  const second = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL], {}, new Date('2026-10-25T00:00Z'));
  expect(second.exit).toBe(0);
  expect(counts(second.out)).toEqual(counts(first.out));
  expect(await everyRow()).toEqual(before);
});

test('a CRLF checkout stores the same rows as an LF one', async () => {
  const lf = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL]);
  expect(lf.exit).toBe(0);
  const lfRows = await everyRow();
  for (const table of TABLES) await pg.query(`DELETE FROM mc.${table}`);

  const checkout = mkdtempSync(join(tmpdir(), 'arch-parse-crlf-'));
  scratch.push(checkout);
  for (const [from, to] of [
    [PACK, 'pack'],
    [TEMPLATE, 'template'],
  ] as const) {
    const dir = join(checkout, to);
    cpSync(from, dir, { recursive: true });
    for (const file of filesOf(dir)) {
      const path = join(dir, file);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
    }
  }
  expect(readFileSync(join(checkout, 'pack/sdlc/loop/archon-loop.yaml'), 'utf8')).toContain('\r\n');

  const crlf = await run([
    ARCHON_SHA,
    FACTORY_SHA,
    '--archon-path',
    join(checkout, 'pack'),
    '--factory-path',
    join(checkout, 'template'),
  ]);
  expect(crlf.err).toEqual([]);
  expect(crlf.exit).toBe(0);
  expect(crlf.out).toEqual(lf.out);
  expect(await everyRow()).toEqual(lfRows);
});

test.each(['main', 'fixture'])(
  'refuses target branch %s before reading or writing anything',
  async (branchName) => {
    const job = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL], { branchName });
    expect(job.exit).toBe(1);
    expect(job.err.join('\n')).toContain(`refusing database '${branchName}'`);
    expect(job.opened).toEqual([]);
    expect(job.requests).toEqual([]);
    expect(await pg.query('SELECT 1 FROM mc.arch_versions')).toEqual([]);
  },
);

test('arch:parse:main refuses main unless the owner confirms at a terminal', async () => {
  const job = await run(['--main', ARCHON_SHA, FACTORY_SHA, ...LOCAL], {
    branchName: 'main',
    owner: false,
  });
  expect(job.exit).toBe(1);
  expect(job.opened).toEqual([]);
});

test('refuses a local snapshot at another commit than the sha given', async () => {
  const job = await run(['0123abcd', FACTORY_SHA, ...LOCAL]);
  expect(job.exit).toBe(1);
  expect(job.err.join('\n')).toContain(`is at ${ARCHON_SHA}, not 0123abcd`);
  expect(job.opened).toEqual([]);
});

test.each([
  ['a missing directory', 'fixtures/no-such-template'],
  ['a directory without hooks', 'fixtures'],
])('refuses %s as the factory path and keeps the stored rows', async (_, factoryPath) => {
  expect((await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL])).exit).toBe(0);
  const before = await everyRow();

  const job = await run([
    ARCHON_SHA,
    FACTORY_SHA,
    '--archon-path',
    PACK,
    '--factory-path',
    factoryPath,
  ]);
  expect(job.exit).toBe(1);
  expect(job.err.join('\n')).toContain(`no ${HOOKS_DIR} under`);
  expect(job.opened).toEqual([]);
  expect(await everyRow()).toEqual(before);
});

test('refuses a missing archon path', async () => {
  const job = await run([
    ARCHON_SHA,
    FACTORY_SHA,
    '--archon-path',
    'fixtures/no-such-pack',
    '--factory-path',
    TEMPLATE,
  ]);
  expect(job.exit).toBe(1);
  expect(job.err.join('\n')).toContain('no pack at');
  expect(job.opened).toEqual([]);
});

test('every row the job builds names exactly its table columns', async () => {
  const rows = archRows(parsePack(join(PACK, 'sdlc'), TEMPLATE));
  for (const table of ARCH_TABLES) {
    const columns = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'mc' AND table_name = $1 AND column_name NOT IN ('archon_sha', 'factory_sha')`,
      [table],
    );
    const names = columns.map((c) => String(c.column_name)).sort();
    expect(rows[table].length).toBeGreaterThan(0);
    for (const row of rows[table]) expect(Object.keys(row).sort()).toEqual(names);
  }
});

test('a repeated depends_on entry is one arch_edges row', () => {
  const pack = parsePack(join(PACK, 'sdlc'), TEMPLATE);
  const once = archRows(pack).arch_edges;
  const [workflow] = pack.workflows.filter((w) => w.edges.length > 0);
  expect(workflow).toBeDefined();
  workflow?.edges.push(...(workflow?.edges ?? []));
  expect(archRows(pack).arch_edges).toEqual(once);
});

test.each([[[]], [[ARCHON_SHA]], [['not-a-sha', FACTORY_SHA]]])(
  'exits 2 with usage for %j before touching Neon',
  async (argv) => {
    const job = await run(argv);
    expect(job.exit).toBe(2);
    expect(job.err.join('\n')).toContain('usage: bun run arch:parse');
    expect(job.resolved).toEqual([]);
  },
);

/** Every file under `dir`, `/`-separated and relative to it. */
function filesOf(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((entry) => {
    const path = join(at, entry);
    return statSync(path).isDirectory()
      ? filesOf(dir, path)
      : [relative(dir, path).replaceAll('\\', '/')];
  });
}

const PACKAGE_ONLY = ['--archon-path', PACK, '--package-path', PACKAGE];

test('stores the factory package at the commit the package records, with no hooks', async () => {
  const job = await run([ARCHON_SHA, PACKAGE_SHA, ...PACKAGE_ONLY]);
  expect(job.err).toEqual([]);
  expect(job.exit).toBe(0);
  expect(job.out[0]).toBe(`archon ${ARCHON_SHA} factory ${PACKAGE_SHA}`);
  expect(job.out).toContain('mc.arch_hooks 0');
  const workflows = await pg.query('SELECT name FROM mc.arch_workflows WHERE name LIKE $1', [
    'factory-%',
  ]);
  expect(workflows.map((w) => w.name).sort()).toEqual([
    'factory-app-check',
    'factory-backlog',
    'factory-deploy',
    'factory-manager',
    'factory-setup',
  ]);
  const texts = await pg.query('SELECT path FROM mc.arch_texts WHERE path = $1', [
    `${FACTORY_PACKAGE_DIR}/app-check/commands/check.md`,
  ]);
  expect(texts).toHaveLength(1);
});

test.each([
  ['no paths', [ARCHON_SHA, FACTORY_SHA]],
  ['no factory side', [ARCHON_SHA, FACTORY_SHA, '--archon-path', PACK]],
  ['no pack', [ARCHON_SHA, FACTORY_SHA, '--factory-path', TEMPLATE]],
])('reads local paths only: %s exits 2 and reaches nothing', async (_, argv) => {
  const job = await run(argv);
  expect(job.exit).toBe(2);
  expect(job.err.join('\n')).toContain('read locally');
  expect(job.requests).toEqual([]);
  expect(job.resolved).toEqual([]);
  expect(job.opened).toEqual([]);
});

test('--if-missing stores a version that is not stored, and leaves a stored one untouched', async () => {
  const first = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL, '--if-missing']);
  expect(first.err).toEqual([]);
  expect(first.exit).toBe(0);
  expect(counts(first.out)).toContain('mc.arch_versions 1');
  const before = await everyRow();
  const versions = () =>
    pg.query('SELECT xmin::text AS x FROM mc.arch_steps ORDER BY archon_sha, workflow, path');
  const rowVersions = await versions();

  const again = await run(
    [ARCHON_SHA, FACTORY_SHA, ...LOCAL, '--if-missing'],
    {},
    new Date('2026-10-25T00:00Z'),
  );
  expect(again.exit).toBe(0);
  expect(again.out).toEqual([`archon ${ARCHON_SHA} factory ${FACTORY_SHA} already stored`]);
  expect(await everyRow()).toEqual(before);
  expect(await versions()).toEqual(rowVersions);
});

test('refuses a template and a package that record different commits', async () => {
  for (const sha of [FACTORY_SHA, PACKAGE_SHA]) {
    const job = await run([ARCHON_SHA, sha, ...LOCAL, '--package-path', PACKAGE]);
    expect(job.exit).toBe(1);
    expect(job.err.join(' ')).toMatch(/is at \w+, not|the template is at/);
    expect(job.opened).toEqual([]);
  }
});

test.each(['--factory-path=', '--package-path='])(
  'refuses an empty %s and stores no version',
  async (flag) => {
    const job = await run([ARCHON_SHA, FACTORY_SHA, '--archon-path', PACK, flag]);
    expect(job.exit).toBe(2);
    expect(job.err.join('\n')).toContain('needs a path');
    expect(await pg.query('SELECT 1 FROM mc.arch_versions')).toEqual([]);
  },
);
