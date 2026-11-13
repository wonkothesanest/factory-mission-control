import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFactories } from './factories';
import {
  DEFAULT_FORGE_WEB_URL,
  forgeWebFromEnv,
  linksBoot,
  linksBootScript,
  linksFromEnv,
} from './links';

const repoRoot = resolve(import.meta.dir, '..');
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-links-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const factory = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  repository: `o/${name}`,
  codebase: name,
  console: 'http://127.0.0.1:3090',
  ...extra,
});

/** A factories file passed as MC_FACTORIES_FILE, as this install passes factories.local.json. */
function factoriesFile(name: string, factories: unknown[]): Record<string, string> {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ factories }));
  return { MC_FACTORIES_FILE: file };
}

test('MC_FORGE_WEB_URL defaults to the forge board, loses a trailing slash, and must be http(s)', () => {
  expect(forgeWebFromEnv({})).toBe('http://127.0.0.1:3091');
  expect(forgeWebFromEnv({ MC_FORGE_WEB_URL: '' })).toBe(DEFAULT_FORGE_WEB_URL);
  expect(forgeWebFromEnv({ MC_FORGE_WEB_URL: 'http://forge.example.test:4000/' })).toBe(
    'http://forge.example.test:4000',
  );
  expect(() => forgeWebFromEnv({ MC_FORGE_WEB_URL: 'ftp://x' })).toThrow(
    'MC_FORGE_WEB_URL must be an http(s) URL',
  );
  expect(() => forgeWebFromEnv({ MC_FORGE_WEB_URL: 'not a url' })).toThrow(
    'MC_FORGE_WEB_URL must be an http(s) URL',
  );
});

test('code_web is an optional http(s) URL in the factories file', () => {
  const read = readFactories(
    factoriesFile('optional', [
      factory('widgets', { code_web: 'https://code.example.test/ws/widgets/' }),
      factory('sandbox'),
    ]),
    repoRoot,
  );
  expect(read.map((f) => f.codeWeb)).toEqual(['https://code.example.test/ws/widgets', undefined]);
  expect('codeWeb' in (read[1] ?? {})).toBe(false);
  for (const bad of [5, 'ftp://x', 'not a url']) {
    expect(() =>
      readFactories(factoriesFile('bad', [factory('f', { code_web: bad })]), repoRoot),
    ).toThrow('factories[0].code_web must be an http(s) URL');
  }
});

test('links come from the environment: the forge board and each factory that names a code_web', () => {
  const links = linksFromEnv(
    {
      MC_FORGE_WEB_URL: 'http://127.0.0.1:4000',
      ...factoriesFile('links', [
        factory('widgets', { code_web: 'https://code.example.test/ws/widgets' }),
        factory('sandbox'),
      ]),
    },
    repoRoot,
  );
  expect(links).toEqual({
    forgeWeb: 'http://127.0.0.1:4000',
    codeWeb: new Map([['widgets', 'https://code.example.test/ws/widgets']]),
  });
});

test('a published pull request of a factory with a code_web links to its branch; nothing else does', () => {
  const boot = linksBoot(
    {
      forgeWeb: DEFAULT_FORGE_WEB_URL,
      codeWeb: new Map([
        ['widgets', 'https://code.example.test/ws/widgets'],
        ['quiet', 'https://code.example.test/ws/quiet'],
      ]),
    },
    new Map([
      ['widgets', new Map([[7, 'factory/pr-7-fix #1']])],
      ['quiet', new Map()],
      ['sandbox', new Map([[3, 'factory/pr-3-x']])],
    ]),
  );
  expect(boot).toEqual({
    forgeWeb: DEFAULT_FORGE_WEB_URL,
    bitbucket: {
      widgets: { '7': 'https://code.example.test/ws/widgets/branch/factory/pr-7-fix%20%231' },
    },
  });
});

test('the boot script cannot be closed by a value', () => {
  const script = linksBootScript({
    forgeWeb: 'http://x/</script><script>alert(1)</script>',
    bitbucket: {},
  });
  expect(script.startsWith('<script>window.__MC_LINKS__=')).toBe(true);
  expect(script.indexOf('</script>')).toBe(script.length - '</script>'.length);
});
