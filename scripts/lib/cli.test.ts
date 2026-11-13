import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { main as branch } from '../fixture/branch';
import { main as drop } from '../fixture/drop';
import { main as seed } from '../fixture/seed';
import { main as projectionLocks } from '../projection-locks';
import { guardedDatabaseUrl, type Main } from './cli';
import { DATABASE_URL, recordingDeps, scratchRepo } from './test-deps';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(main: Main, argv: string[]) {
  const repoRoot = scratchRepo({ MC_CHECK_DATABASE: 'check-abc' });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot });
  const code = await main(argv, recorder.deps);
  return { ...recorder, code };
}

const SCRIPTS: Record<string, Main> = {
  'fixture:drop': drop,
  'fixture:branch': branch,
  'fixture:seed': seed,
  'projection:locks': projectionLocks,
};
const NAMES = Object.keys(SCRIPTS);

test.each([
  ['fixture:drop', ['--all', '--bogus']],
  ['fixture:drop', ['--bogus', '--all']],
  ...NAMES.map((name) => [name, ['--bogus']]),
] as [string, string[]][])('%s %j names --bogus as the argument it refuses', async (name, argv) => {
  const { code, err, out, resolved, opened } = await run(SCRIPTS[name], argv);
  expect(code).toBe(2);
  expect(err[0]?.split('\n')[0]).toBe('unexpected argument --bogus');
  expect(err.join('\n')).toContain(`usage: bun run ${name}`);
  expect(out).toEqual([]);
  expect(resolved).toEqual([]);
  expect(opened).toEqual([]);
});

test.each(
  NAMES.flatMap((name) => [
    [name, '--help'],
    [name, '-h'],
  ]),
)('%s %s alone prints usage and exits 0', async (name, flag) => {
  const { code, err, out, opened } = await run(SCRIPTS[name], [flag]);
  expect(code).toBe(0);
  expect(out.join('\n')).toContain(`usage: bun run ${name}`);
  expect(err).toEqual([]);
  expect(opened).toEqual([]);
});

async function guarded(target: 'check' | 'main', database: string) {
  const repoRoot = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot, branchName: database });
  return guardedDatabaseUrl(recorder.deps, target);
}

test('a check command takes only a check-* database', async () => {
  expect(await guarded('check', 'check-abc')).toBe(DATABASE_URL);
  await expect(guarded('check', 'archon')).rejects.toThrow(
    "refusing database 'archon': only check-* databases",
  );
});

test('a :main command takes the live database and refuses a check one', async () => {
  expect(await guarded('main', 'archon')).toBe(DATABASE_URL);
  await expect(guarded('main', 'check-abc')).rejects.toThrow(
    "refusing database 'check-abc': a :main command writes the live database",
  );
});

test('without MC_DATABASE_URL nothing is resolved or opened', async () => {
  const repoRoot = scratchRepo();
  scratch.push(repoRoot);
  const recorder = recordingDeps({ repoRoot });
  await expect(guardedDatabaseUrl(recorder.deps, 'check')).rejects.toThrow(
    'MC_DATABASE_URL is not set',
  );
  expect(recorder.resolved).toEqual([]);
  expect(recorder.opened).toEqual([]);
});
