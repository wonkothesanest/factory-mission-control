// Where the page's work-item links open (local-factory port). Issues and pull requests live on
// the local forge, whose board MC_FORGE_WEB_URL names; a pull request the forge published has its
// code on Bitbucket, under the factory's `code_web`. The server writes both into every page as
// `window.__MC_LINKS__` (app/lib/forge-links.ts reads it), computed when the page is served.

import type { Env } from './check-env';
import { isHttpUrl, readFactories } from './factories';

export const DEFAULT_FORGE_WEB_URL = 'http://127.0.0.1:3091';

export interface Links {
  /** The forge board's base, without a trailing `/`. */
  forgeWeb: string;
  /** Each factory's `code_web`, by factory name; a factory without one is absent. */
  codeWeb: Map<string, string>;
}

/** The boot the page reads (app/lib/forge-links.ts `LinksBoot`). */
interface LinksBoot {
  forgeWeb: string;
  bitbucket: Record<string, Record<string, string>>;
}

/** MC_FORGE_WEB_URL, an http(s) URL without a trailing `/`; unset or empty is the forge board's default address. */
export function forgeWebFromEnv(env: Env): string {
  const raw = env.MC_FORGE_WEB_URL;
  if (raw === undefined || raw === '') return DEFAULT_FORGE_WEB_URL;
  if (!isHttpUrl(raw)) throw new Error('MC_FORGE_WEB_URL must be an http(s) URL');
  return raw.replace(/\/+$/, '');
}

export function linksFromEnv(env: Env, repoRoot: string): Links {
  return {
    forgeWeb: forgeWebFromEnv(env),
    codeWeb: new Map(
      readFactories(env, repoRoot).flatMap(({ name, codeWeb }) =>
        codeWeb === undefined ? [] : [[name, codeWeb] as const],
      ),
    ),
  };
}

/** The boot for `links` and the forge's publications: a Bitbucket link for each published pull request of a factory with a `code_web`. */
export function linksBoot(links: Links, published: Map<string, Map<number, string>>): LinksBoot {
  const bitbucket: LinksBoot['bitbucket'] = {};
  for (const [factory, codeWeb] of links.codeWeb) {
    const branches = published.get(factory);
    if (branches === undefined || branches.size === 0) continue;
    bitbucket[factory] = Object.fromEntries(
      [...branches].map(([pr, branch]) => [
        String(pr),
        `${codeWeb}/branch/${branch.split('/').map(encodeURIComponent).join('/')}`,
      ]),
    );
  }
  return { forgeWeb: links.forgeWeb, bitbucket };
}

export function linksBootScript(boot: LinksBoot): string {
  return `<script>window.__MC_LINKS__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>`;
}
