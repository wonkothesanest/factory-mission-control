// Where a work-item link opens (local-factory port). Issues and pull requests keep their
// github.com-shaped URLs as their identity (function/forge-local.ts); they exist only on the local
// forge, so every anchor that opens one translates it here, at render time. The forge board's base
// and the Bitbucket links of published pull requests come from the server's inline script
// (server/links.ts `linksBootScript`).

/** The forge board's documented address, used when the page carries no links boot. */
export const DEFAULT_FORGE_WEB = 'http://127.0.0.1:3091';

/** What the server's inline script leaves on `window.__MC_LINKS__`. */
export interface LinksBoot {
  forgeWeb: string;
  /** A published pull request's code on Bitbucket, by factory, then by pull request number. */
  bitbucket: Record<string, Record<string, string>>;
}

declare global {
  var __MC_LINKS__: LinksBoot | undefined;
}

const ITEM = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;
const GITHUB = /^https?:\/\/(www\.)?github\.com(?=[/?#]|$)/i;

/** The forge board's base, without a trailing `/`. */
export function forgeWeb(): string {
  return globalThis.__MC_LINKS__?.forgeWeb ?? DEFAULT_FORGE_WEB;
}

/** The link that opens `url`: a forge item's board page, the board for any other github.com URL, anything else unchanged. */
export function forgeHref(url: string, web = forgeWeb()): string {
  const item = ITEM.exec(url);
  if (item) return `${web}/r/${item[1]}/${item[2]}/${item[3]}/${item[4]}`;
  return GITHUB.test(url) ? `${web}/` : url;
}

/** The forge board listing every item, open and closed. */
export function forgeAllHref(web = forgeWeb()): string {
  return `${web}/?state=all`;
}

/** Where a published pull request's code is on Bitbucket; null when it is unpublished or the factory names no code_web. */
export function bitbucketHref(factory: string, pr: number | null): string | null {
  if (pr === null) return null;
  return globalThis.__MC_LINKS__?.bitbucket?.[factory]?.[String(pr)] ?? null;
}
