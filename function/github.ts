// GitHub-shaped reads for the ingestion and the scripts. Requests are GETs by type, never anything
// else (invariant 2: read-only toward the factories).
//
// local-factory port: network ingestion from GitHub is disabled. Nothing here has a network
// default any more: `createGitHub` needs a fetch handed to it, and the dashboard's own defaults are
// `offlineGitHub` / `offlineFetch`, which refuse every read. The local forge (GitHub-shaped issues,
// pull requests and comments in SQLite) plugs in through `function/forge-seam.ts`.

export type GetFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<Response>;

export interface GitHub {
  /** The file's text at `ref`, or null when the file does not exist there. */
  fileAt(repository: string, path: string, ref: string): Promise<string | null>;
  /** The JSON GitHub returns for `path` under the API root. */
  get<T>(path: string): Promise<T>;
  /** Every item of the list at `path`, following each page's `Link: rel="next"`. */
  list<T>(path: string): Promise<T[]>;
}

/** GitHub answered a GET with a status other than success (or, for `fileAt`, 404). */
export class GitHubError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} failed: ${status}`);
  }
}

const NEXT_PAGE = /<([^>]+)>;\s*rel="next"/;

/**
 * GitHub's REST shape over `fetch`, rooted at `apiRoot`, which has no default (nothing here names
 * a network host): for a forge that serves the same shape locally, or a test's recorded answers.
 * `token`, when given, goes as a bearer token.
 */
export function createGitHub(fetch: GetFetch, apiRoot: string, token?: string): GitHub {
  async function request(url: string, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      'user-agent': 'factory-mission-control',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(url, { method: 'GET', headers });
  }

  async function json(url: string): Promise<Response> {
    const response = await request(url, 'application/vnd.github+json');
    if (!response.ok) throw new GitHubError(url, response.status);
    return response;
  }

  return {
    async fileAt(repository, path, ref) {
      const url = `${apiRoot}/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`;
      const response = await request(url, 'application/vnd.github.raw+json');
      if (response.status === 404) return null;
      if (!response.ok) throw new GitHubError(url, response.status);
      return response.text();
    },
    async get<T>(path: string) {
      return (await (await json(`${apiRoot}${path}`)).json()) as T;
    },
    async list<T>(path: string) {
      const items: T[] = [];
      let url: string | undefined = `${apiRoot}${path}`;
      while (url) {
        const response = await json(url);
        items.push(...((await response.json()) as T[]));
        url = NEXT_PAGE.exec(response.headers.get('link') ?? '')?.[1];
      }
      return items;
    },
  };
}

/** Thrown by every offline read: GitHub ingestion is disabled until the local forge is plugged in. */
export class ForgeOffline extends Error {
  constructor(what: string) {
    super(
      `${what}: GitHub network ingestion is disabled in this install; plug the local forge in at function/forge-seam.ts`,
    );
    this.name = 'ForgeOffline';
  }
}

/** A fetch that never reaches the network. */
export const offlineFetch: GetFetch = async (url) => {
  throw new ForgeOffline(`GET ${url}`);
};

/** The dashboard's default GitHub: every read refuses, nothing reaches github.com. */
export function offlineGitHub(): GitHub {
  return {
    fileAt: async (repository, path, ref) => {
      throw new ForgeOffline(`reading ${repository}/${path} at ${ref}`);
    },
    get: async (path) => {
      throw new ForgeOffline(`GET ${path}`);
    },
    list: async (path) => {
      throw new ForgeOffline(`GET ${path}`);
    },
  };
}
