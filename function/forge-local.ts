// The local forge, read (local-factory port). The factory's forge (forge/, contract in
// forge/CONTRACT.md) keeps GitHub-shaped issues, pull requests, comments and labels in SQLite
// (forge/state/forge.db, WAL), with github.com-style URLs and GitHub's numbering. This module opens
// that file READ-ONLY and maps its rows into the shapes GitHub's webhook payloads carry
// (function/ingest.ts reads exactly those fields), so the forge seam (function/forge-seam.ts)
// stores them with the webhook's own upserts. It never writes the file, and each snapshot is one
// short read transaction.

import { Database } from 'bun:sqlite';
import type { Comment, Issue, PullRequest } from './ingest';

/** The GitHub host the forge's URLs name (forge/src/util.ts WEB); no request is ever made to it. */
const WEB = 'https://github.com';

export interface ForgeRepository {
  /** `owner/name`, as factories.json names the repository. */
  full_name: string;
  default_branch: string;
}

export interface ForgeRepoSnapshot {
  repository: ForgeRepository;
  /** Issues only (kind `issue`); a pull request's own row is in `pullRequests`. */
  issues: Issue[];
  pullRequests: PullRequest[];
  /** Each comment with the issue or pull request it is on, as GitHub's `issue_comment` names it. */
  comments: { issue: Issue; comment: Comment }[];
}

/** Each repository asked for that the forge holds, by its `owner/name` in lower case. */
export type ForgeSnapshot = Map<string, ForgeRepoSnapshot>;

interface ItemRow {
  id: number;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  head_oid: string | null;
}

interface CommentRow {
  id: number;
  item_id: number;
  body: string;
  login: string;
  created_at: string;
  updated_at: string;
}

/**
 * Opens the forge's SQLite file read-only (SQLITE_OPEN_READONLY: no write, no checkpoint, no
 * schema change). A busy forge writer makes a read wait at most `busyMs`.
 */
export function openForge(file: string, busyMs = 2000): Database {
  const db = new Database(file, { readonly: true });
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
  return db;
}

/** Changes whenever another connection commits to the file (SQLite's data_version). */
export function forgeDataVersion(db: Database): number {
  const row = db.query('PRAGMA data_version').get() as { data_version: number } | null;
  return row?.data_version ?? -1;
}

const itemUrl = (repo: string, row: Pick<ItemRow, 'kind' | 'number'>) =>
  `${WEB}/${repo}/${row.kind === 'pr' ? 'pull' : 'issues'}/${row.number}`;

/** A forge item as GitHub's issue payload carries it (a pull request too, with `pull_request`). */
export function issueOf(repo: string, row: ItemRow, labels: string[]): Issue {
  const url = itemUrl(repo, row);
  return {
    number: row.number,
    title: row.title,
    state: row.state === 'open' ? 'open' : 'closed',
    body: row.body,
    html_url: url,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.state === 'open' ? null : (row.closed_at ?? row.merged_at ?? row.updated_at),
    state_reason: row.state_reason,
    labels: labels.map((name) => ({ name })),
    ...(row.kind === 'pr' && { pull_request: { html_url: url, merged_at: row.merged_at } }),
  };
}

/** A forge pull request as GitHub's pull_request payload carries it; merged reads as closed. */
export function pullRequestOf(repo: string, row: ItemRow): PullRequest {
  return {
    number: row.number,
    title: row.title,
    state: row.state === 'open' ? 'open' : 'closed',
    body: row.body,
    merged_at: row.merged_at,
    head: { sha: row.head_oid ?? '' },
    html_url: itemUrl(repo, row),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.state === 'open' ? null : (row.closed_at ?? row.merged_at ?? row.updated_at),
  };
}

/** A forge comment as GitHub's issue_comment payload carries it (forge/src/present.ts's URL). */
export function commentOf(repo: string, item: ItemRow, row: CommentRow): Comment {
  return {
    id: row.id,
    body: row.body,
    user: { login: row.login },
    html_url: `${itemUrl(repo, item)}#issuecomment-${row.id}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Every issue, pull request and comment of each repository in `repositories` that the forge
 * holds, in one read transaction (a consistent snapshot; it holds no lock a forge writer waits
 * on, since WAL readers never block writers). A repository the forge does not hold is absent.
 */
export function readForgeSnapshot(db: Database, repositories: string[]): ForgeSnapshot {
  const wanted = new Set(repositories.map((r) => r.toLowerCase()));
  const snapshot: ForgeSnapshot = new Map();
  db.exec('BEGIN');
  try {
    const repos = db.query('SELECT id, owner, name FROM repos ORDER BY id').all() as {
      id: number;
      owner: string;
      name: string;
    }[];
    for (const repo of repos) {
      const full = `${repo.owner}/${repo.name}`;
      if (!wanted.has(full.toLowerCase())) continue;
      const items = db
        .query(
          `SELECT id, number, kind, title, body, state, state_reason, created_at, updated_at,
             closed_at, merged_at, head_oid
           FROM items WHERE repo_id = ? ORDER BY number`,
        )
        .all(repo.id) as ItemRow[];
      const labelRows = db
        .query(
          `SELECT il.item_id, l.name FROM item_labels il
             JOIN labels l ON l.id = il.label_id
             JOIN items i ON i.id = il.item_id
           WHERE i.repo_id = ? ORDER BY l.name`,
        )
        .all(repo.id) as { item_id: number; name: string }[];
      const commentRows = db
        .query(
          `SELECT c.id, c.item_id, c.body, u.login, c.created_at, c.updated_at
             FROM comments c
             JOIN users u ON u.id = c.author_id
             JOIN items i ON i.id = c.item_id
           WHERE i.repo_id = ? ORDER BY c.id`,
        )
        .all(repo.id) as CommentRow[];
      const labels = new Map<number, string[]>();
      for (const { item_id, name } of labelRows) {
        labels.set(item_id, [...(labels.get(item_id) ?? []), name]);
      }
      const byId = new Map(items.map((item) => [item.id, item]));
      const issueById = new Map(
        items.map((item) => [item.id, issueOf(full, item, labels.get(item.id) ?? [])]),
      );
      snapshot.set(full.toLowerCase(), {
        repository: { full_name: full, default_branch: 'main' },
        issues: items.filter((i) => i.kind === 'issue').map((i) => issueById.get(i.id) as Issue),
        pullRequests: items.filter((i) => i.kind === 'pr').map((i) => pullRequestOf(full, i)),
        comments: commentRows.flatMap((row) => {
          const item = byId.get(row.item_id);
          const issue = issueById.get(row.item_id);
          return item && issue ? [{ issue, comment: commentOf(full, item, row) }] : [];
        }),
      });
    }
  } finally {
    db.exec('COMMIT');
  }
  return snapshot;
}
