/**
 * PRD invariant 2: the dashboard writes to a factory in exactly five ways, all in
 * `server/actions.ts`. This scans the dashboard's own code and fails on any other process spawn,
 * network call, Archon write verb, SQL write to Archon's tables, or GitHub/Archon client library.
 * A new entry below is for a path that does not write to GitHub, Archon or a factory, with its reason.
 *
 * Not scanned: `.archon/`, `factory/` and `.factory/` (the factory package the dashboard watches,
 * not the dashboard), `harness/` (the app check's driver) and `fixtures/` (data).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const ROOTS = ['app', 'server', 'function', 'parsers', 'db', 'scripts'];

const tracked = (await Bun.$`git ls-files ${ROOTS}`.cwd(repoRoot).text())
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|sql)$/.test(file) && !/\.test\.|\.browser\.test\./.test(file));
const sources = new Map(
  tracked.map((file) => [file, readFileSync(resolve(repoRoot, file), 'utf-8')]),
);

const matching = (pattern: RegExp) =>
  [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file);
const remedy =
  'Add a reasoned entry only for a path that writes to neither GitHub, Archon nor a factory.';

const SPAWN_SITES: Record<string, string> = {
  'server/actions.ts': 'the five writes',
  'server/build-id.ts': 'git rev-parse',
  'function/local-pins.ts': 'git log -1 --format=%aI on an app checkout, read-only (local pins)',
  'server/manager.ts': 'the Manager agent: read-only tools, proven by manager-tools.test.ts',
  'scripts/lib/archon-run.ts': 'workflow get, read',
  'scripts/lib/cdp.ts': 'headless Chrome',
  'scripts/local-arch.ts': 'git rev-parse HEAD on the factory template checkout, read-only',
  'scripts/restart-test.ts': 'start.sh against the scratch database it creates and drops',
};

const FETCH_SITES: Record<string, string> = {
  'app/lib/actions.ts': 'same-origin /api/',
  'app/lib/manager.ts': 'same-origin /api/',
  'app/live/client.ts': 'same-origin /api/',
  'app/live/LiveProvider.tsx': 'same-origin /api/',
  'function/github.ts': 'GET only, through a fetch and a root handed to it (no network default)',
  'server/serve.ts':
    "Bun.serve's own request handler, named fetch: it answers requests, it sends none",
  'scripts/restart-test.ts': 'GET /api/health and /api/forge of its own server on 127.0.0.1',
};

const ARCHON_FIXTURE_WRITERS: Record<string, string> = {
  'scripts/fixture/write.ts':
    'fixture:write, connects only through guardedDatabaseUrl(deps, "check")',
  'scripts/fixture/seed-laps.ts': 'generates the SQL fixture:write runs on a check branch',
  'scripts/projection-locks.ts': 'connects only through guardedDatabaseUrl(deps, "check")',
  'scripts/safety-test.ts':
    'writes Archon-shaped rows only in the check-safety-* scratch database it creates and drops',
  'scripts/restart-test.ts':
    'writes Archon-shaped rows only in the scratch-restart-* database it creates and drops',
};

const SPAWN =
  /Bun\.spawn|Bun\.spawnSync|Bun\.\$|node:child_process|from 'child_process'|@anthropic-ai\/claude-agent-sdk/;
const FETCH_CALL = /(^|[^\w.])(fetch|fetchImpl|doFetch)\(/m;
const ARCHON_WRITE = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.)?"?remote_agent_/i;
const ARCHON_VERBS = [
  'answer',
  'resume',
  'forge',
  'workitem.label.add',
  'workitem.close',
  'workitem.comment.upsert',
  'approve',
  'reject',
  'respond',
  'cancel',
  'abandon',
  'signal',
  'end-turn',
  'wake',
  'cleanup',
  'reset-sessions',
];

test('only the listed files spawn a process', () => {
  expect(matching(SPAWN).sort(), remedy).toEqual(Object.keys(SPAWN_SITES).sort());
});

// The Manager's own 'answer' and 'resume' are proposal kinds it streams, not argv: it spawns the agent SDK, not a CLI.
// 'run' is not listed: server/actions.ts's re-triage starts `workflow run archon-intake`, and no other spawn site may name it either way.
test('no CLI spawn site outside server/actions.ts names an Archon write or pushes to GitHub', () => {
  const quoted = new RegExp(`['"\`](${[...ARCHON_VERBS, 'gh', 'push'].join('|')})['"\`]`);
  const offenders = matching(
    /Bun\.spawn|Bun\.spawnSync|Bun\.\$|node:child_process|from 'child_process'/,
  ).filter((file) => file !== 'server/actions.ts' && quoted.test(sources.get(file) ?? ''));
  expect(offenders, 'a spawn site names an Archon write verb, gh or push').toEqual([]);
});

test('server/actions.ts sends exactly the five writes', () => {
  const text = sources.get('server/actions.ts') ?? '';
  const operations = [...text.matchAll(/['"`](workitem\.[\w.]+)['"`]/g)].map((m) => m[1]);
  expect([...new Set(operations)].sort()).toEqual([
    'workitem.close',
    'workitem.comment.upsert',
    'workitem.label.add',
  ]);
  const verbs = [...text.matchAll(/'workflow',\s*'([\w-]+)'/g)].map((m) => m[1]);
  expect([...new Set(verbs)].sort()).toEqual(['answer', 'resume', 'run']);
});

test('the operator command is read in one place', () => {
  const holders = matching(/operators\.json|MC_OPERATORS_FILE|loadOperators|actionsFromEnv/);
  expect(holders.sort()).toEqual(['server/actions.ts', 'server/main.ts']);
});

test('only the listed files make network calls, and the browser only calls its own /api/', () => {
  expect(matching(FETCH_CALL).sort(), remedy).toEqual(Object.keys(FETCH_SITES).sort());
  for (const [file, text] of sources) {
    if (!file.startsWith('app/')) continue;
    for (const call of text.matchAll(/(?:^|[^\w.])(?:fetch|fetchImpl)\(\s*(['"`/][^,)]*)/gm)) {
      expect(call[1], `${file} calls something other than its own /api/`).toMatch(/^['"`]\/api\//);
    }
  }
  // local-factory port: no code names GitHub's API or raw-content host at all (the run-stop
  // corpus is sample error text that tests classify, not a call).
  const hosts = matching(/api\.github\.com|raw\.githubusercontent\.com/).filter(
    (file) => file !== 'db/run-stops-corpus.ts',
  );
  expect(hosts, 'a source names a GitHub network host').toEqual([]);
  expect(sources.get('function/github.ts'), 'function/github.ts writes to GitHub').not.toMatch(
    /method: '(POST|PUT|PATCH|DELETE)'/,
  );
});

test("nothing writes Archon's tables except the check-branch fixture tooling", () => {
  expect(matching(ARCHON_WRITE).sort(), remedy).toEqual(Object.keys(ARCHON_FIXTURE_WRITERS).sort());
});

test('no GitHub or Archon client library is imported', () => {
  expect(matching(/from '@octokit\/|from '@archon\/|require\('@octokit|require\('@archon/)).toEqual(
    [],
  );
});
