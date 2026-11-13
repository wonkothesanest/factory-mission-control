// `bun scripts/local-arch.ts [--main]` (local-factory port; start.sh runs it): stores the
// architecture (step pages, the map's step details) of every Archon sha the factories' app
// checkouts pin in factory/pack.json, unless it is already stored. Each version is parsed by
// arch-parse from local paths only: the pinned Archon checkout in the factory's cache and the
// factory template in upstream/ai-software-factory, at its checked-out commit. Reads those paths
// and `git rev-parse`; writes only mc.arch_* (through arch-parse), and nothing for a version
// already stored.
//
//   --apps <dir>          app checkouts (MC_APPS_DIR, else <factory>/apps)
//   --archon-cache <dir>  pinned Archon checkouts, <dir>/<sha>/.archon/workflows (MC_ARCHON_CACHE,
//                         else <factory>/cache/factory/archon)
//   --template <dir>      the factory template (MC_FACTORY_TEMPLATE, else
//                         <factory>/upstream/ai-software-factory/template)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packFiles, pinnedSha } from '../function/local-pins';
import { readFactories } from '../server/factories';
import { main as archParse } from './arch-parse';
import { type Main, runCli } from './lib/cli';

const USAGE =
  'usage: bun scripts/local-arch.ts [--main] [--apps <dir>] [--archon-cache <dir>] [--template <dir>]';

/** The commit a checkout is at (`git rev-parse HEAD`), or null when it is not a git checkout. */
function headOf(dir: string): string | null {
  const result = Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD'], {
    env: { PATH: process.env.PATH ?? '', GIT_OPTIONAL_LOCKS: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  const sha = result.stdout.toString().trim();
  return result.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export const main: Main = async (argv, deps) => {
  let values: {
    main?: boolean;
    help?: boolean;
    apps?: string;
    'archon-cache'?: string;
    template?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        main: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        apps: { type: 'string' },
        'archon-cache': { type: 'string' },
        template: { type: 'string' },
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
  const factoryRoot = deps.env.FACTORY_ROOT || resolve(deps.repoRoot, '..', '..');
  const apps = resolve(values.apps ?? (deps.env.MC_APPS_DIR || join(factoryRoot, 'apps')));
  const cache = resolve(
    values['archon-cache'] ??
      (deps.env.MC_ARCHON_CACHE || join(factoryRoot, 'cache/factory/archon')),
  );
  const template = resolve(
    values.template ??
      (deps.env.MC_FACTORY_TEMPLATE || join(factoryRoot, 'upstream/ai-software-factory/template')),
  );

  let factories: { name: string; repository: string }[];
  try {
    factories = readFactories(deps.env, deps.repoRoot);
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const pinned = new Map<string, string[]>();
  for (const file of packFiles(apps, factories)) {
    const sha = pinnedSha(readText(file.path));
    if (sha) pinned.set(sha, [...(pinned.get(sha) ?? []), file.factory]);
  }
  if (pinned.size === 0) {
    deps.out(`local-arch: no factory/pack.json under ${apps} pins an Archon sha; nothing to parse`);
    return 0;
  }
  const factorySha = headOf(dirname(template));
  if (!factorySha || !existsSync(template)) {
    deps.err(`local-arch: ${template} is not a template in a git checkout`);
    return 1;
  }

  let exit = 0;
  for (const [sha, by] of pinned) {
    const archonPath = join(cache, sha, '.archon/workflows');
    if (!existsSync(join(archonPath, 'sdlc'))) {
      deps.err(`local-arch: ${sha} (pinned by ${by.join(', ')}) has no pack at ${archonPath}/sdlc`);
      exit = 1;
      continue;
    }
    deps.out(`local-arch: ${sha} pinned by ${by.join(', ')}; factory template at ${factorySha}`);
    const code = await archParse(
      [
        sha,
        factorySha,
        ...(values.main ? ['--main'] : []),
        '--archon-path',
        archonPath,
        '--factory-path',
        template,
        '--if-missing',
      ],
      deps,
    );
    if (code !== 0) exit = code;
  }
  return exit;
};

if (import.meta.main) await runCli(main);
