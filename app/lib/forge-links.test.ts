import { afterEach, expect, test } from 'bun:test';
import { bitbucketHref, forgeAllHref, forgeHref, forgeWeb } from './forge-links';

afterEach(() => {
  globalThis.__MC_LINKS__ = undefined;
});

const WEB = 'http://127.0.0.1:3091';

test('an issue or pull request URL opens its page on the forge board, without a comment anchor', () => {
  expect(forgeHref('https://github.com/o/r/issues/17')).toBe(`${WEB}/r/o/r/issues/17`);
  expect(forgeHref('https://github.com/o/r/pull/410')).toBe(`${WEB}/r/o/r/pull/410`);
  expect(forgeHref('https://github.com/o/r/pull/410/')).toBe(`${WEB}/r/o/r/pull/410`);
  expect(forgeHref('https://github.com/o/r/issues/7#issuecomment-12')).toBe(
    `${WEB}/r/o/r/issues/7`,
  );
});

test('any other github.com URL opens the board; anything else is unchanged', () => {
  expect(forgeHref('https://github.com/o/r/issues?q=is%3Aclosed')).toBe(`${WEB}/`);
  expect(forgeHref('https://github.com/o/r/pull/7/files')).toBe(`${WEB}/r/o/r/pull/7`);
  expect(forgeHref('https://github.com')).toBe(`${WEB}/`);
  expect(forgeHref('http://www.GitHub.com/o')).toBe(`${WEB}/`);
  expect(forgeHref('http://127.0.0.1:3090/runs/abc')).toBe('http://127.0.0.1:3090/runs/abc');
  expect(forgeHref('/f/x/runs/abc')).toBe('/f/x/runs/abc');
  expect(forgeHref('https://github.company.test/o/r/issues/1')).toBe(
    'https://github.company.test/o/r/issues/1',
  );
});

test("the board listing every item is the forge's ?state=all", () => {
  expect(forgeAllHref()).toBe(`${WEB}/?state=all`);
});

test("the page's links boot sets the forge board's base and the published pull requests' code", () => {
  expect(bitbucketHref('f', 7)).toBeNull();
  globalThis.__MC_LINKS__ = {
    forgeWeb: 'http://127.0.0.1:4000',
    bitbucket: { f: { '7': 'https://code.example.test/ws/r/branch/factory/pr-7-x' } },
  };
  expect(forgeWeb()).toBe('http://127.0.0.1:4000');
  expect(forgeHref('https://github.com/o/r/pull/7')).toBe('http://127.0.0.1:4000/r/o/r/pull/7');
  expect(forgeAllHref()).toBe('http://127.0.0.1:4000/?state=all');
  expect(bitbucketHref('f', 7)).toBe('https://code.example.test/ws/r/branch/factory/pr-7-x');
  expect(bitbucketHref('f', 8)).toBeNull();
  expect(bitbucketHref('g', 7)).toBeNull();
  expect(bitbucketHref('f', null)).toBeNull();
});
