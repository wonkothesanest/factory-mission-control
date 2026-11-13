// Local forge ingestion (local-factory port; replaces GitHub's webhook and the backfill).
//
// At start and then every MC_FORGE_POLL_MS (5 s), the server reads the factory's forge
// (function/forge-local.ts: its SQLite file opened read-only) and hands every issue, pull request
// and comment that is new or changed since the last read to the forge seam
// (function/forge-seam.ts) as the GitHub webhook delivery that change would have been: `issues`
// (with `labeled` and the label when an issue gained one), `pull_request` and `issue_comment`. The
// seam stores each with the webhook's own keyed upserts, in its own short transaction, and every
// write to an mc table NOTIFYs mc_live, so open panels update live. What the forge no longer holds
// is removed with the reconcile's own removals (an issue, a comment). The first read after a start
// also removes what the dashboard holds for a followed repository that the forge does not, as
// `bun run reconcile` does.
//
// Pins come from the app checkouts' factory/pack.json (function/local-pins.ts), read again when a
// pack file changes, and are written with the push path's upsert.
//
// A poll that finds the forge unchanged (SQLite's data_version) and no pack file changed reads
// nothing more and writes nothing.

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeDelivery } from '../function/app';
import {
  type ForgeSnapshot,
  forgeDataVersion,
  openForge,
  readForgeSnapshot,
} from '../function/forge-local';
import { createForgeIngestion } from '../function/forge-seam';
import {
  type Comment,
  deleteComment,
  type Factory,
  type Issue,
  removeIssue,
  type VersionCommit,
  writeCommits,
} from '../function/ingest';
import {
  type AuthoredAt,
  gitAuthoredAt,
  type PackFile,
  packFiles,
  packSignature,
  readLocalPins,
} from '../function/local-pins';
import { type Db, openDb } from '../scripts/lib/db';
import type { Env } from './check-env';
import { readFactories } from './factories';

export const DEFAULT_FORGE_POLL_MS = 5000;

export interface ForgePollReport {
  /** Deliveries handed to the seam, by event. */
  delivered: Record<string, number>;
  removed: { issues: number; comments: number };
  pins: number;
  /** True when the forge and the pack files were unchanged and nothing was read. */
  unchanged: boolean;
}

export interface ForgeStatus {
  file: string | null;
  pollMs: number;
  polls: number;
  lastPollAt: string | null;
  lastChangeAt: string | null;
  lastError: string | null;
  /** What the dashboard was last handed, per followed repository. */
  repositories: Record<string, { issues: number; pullRequests: number; comments: number }>;
  pins: string[];
}

export interface ForgePoller {
  pollOnce(): Promise<ForgePollReport>;
  start(): void;
  stop(): Promise<void>;
  status(): ForgeStatus;
}

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url');

interface Seen {
  /** Fingerprint of each delivered issue, PR and comment, by `<factory>:<kind>:<key>`. */
  prints: Map<string, string>;
  /** Labels each issue held when last delivered, by `<factory>:<number>`. */
  labels: Map<string, Set<string>>;
  issues: Map<string, Set<number>>;
  comments: Map<string, Map<number, number>>;
}

export function createForgePoller({
  db,
  factories,
  forgeFile,
  appsDir,
  pollMs = DEFAULT_FORGE_POLL_MS,
  authoredAt = gitAuthoredAt,
  now = () => new Date(),
  log = (line: string) => console.log(line),
}: {
  /** The dashboard's database (writes mc only). */
  db: Db;
  /** The factories this server shows: each one's repository is followed in the forge. */
  factories: Factory[];
  /** The forge's SQLite file; null turns issue ingestion off (pins still load). */
  forgeFile: string | null;
  /** Where the app checkouts live (`<appsDir>/<repo>/factory/pack.json`); null turns pins off. */
  appsDir: string | null;
  pollMs?: number;
  authoredAt?: AuthoredAt;
  now?: () => Date;
  log?: (line: string) => void;
}): ForgePoller {
  const seam = createForgeIngestion({ db, factories });
  const packs: PackFile[] = appsDir ? packFiles(appsDir, factories) : [];
  let forge: Database | undefined;
  let dataVersion: number | undefined;
  let packsSeen: string | undefined;
  let first = true;
  const seen: Seen = {
    prints: new Map(),
    labels: new Map(),
    issues: new Map(),
    comments: new Map(),
  };
  const state: ForgeStatus = {
    file: forgeFile,
    pollMs,
    polls: 0,
    lastPollAt: null,
    lastChangeAt: null,
    lastError: null,
    repositories: {},
    pins: [],
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<unknown> | undefined;
  let lastLogged = '';

  const factoryOf = (repository: string) =>
    factories.find((f) => f.repository.toLowerCase() === repository.toLowerCase());

  /** Opens the forge read-only the first time its file exists; null while it does not. */
  function forgeDb(): Database | null {
    if (forge) return forge;
    if (!forgeFile || !existsSync(forgeFile)) return null;
    forge = openForge(forgeFile);
    return forge;
  }

  async function deliver(report: ForgePollReport, event: string, payload: unknown, id: string) {
    const result = await seam.deliver(event, payload, `forge ${event} ${id}`);
    if (result.written) report.delivered[event] = (report.delivered[event] ?? 0) + 1;
  }

  /** Hands the seam every change in `snapshot` since the last poll; removes what is gone. */
  async function ingest(snapshot: ForgeSnapshot, report: ForgePollReport): Promise<void> {
    const readAt = now().toISOString();
    for (const [key, repo] of snapshot) {
      const factory = factoryOf(repo.repository.full_name);
      if (!factory) continue;
      const name = factory.name;
      const issues = new Set(repo.issues.map((i) => i.number));
      const comments = new Map(
        repo.comments.map(({ issue, comment }) => [comment.id, issue.number]),
      );

      for (const issue of repo.issues) {
        const id = `${name}:issue:${issue.number}`;
        const print = fingerprint(issue);
        if (seen.prints.get(id) === print) continue;
        const labelKey = `${name}:${issue.number}`;
        const before = seen.labels.get(labelKey);
        const held = new Set(issue.labels.map((l) => l.name));
        // A label the issue gained since the last poll is GitHub's `labeled` delivery, which also
        // records when it was labelled. On the first poll after a start nothing says when.
        const gained = before ? [...held].filter((label) => !before.has(label)) : [];
        const payload = { issue, repository: repo.repository };
        if (gained.length === 0) {
          await deliver(
            report,
            'issues',
            { action: before ? 'edited' : 'opened', ...payload },
            `${key}#${issue.number}`,
          );
        }
        for (const label of gained) {
          await deliver(
            report,
            'issues',
            { action: 'labeled', label: { name: label }, ...payload },
            `${key}#${issue.number}`,
          );
        }
        seen.prints.set(id, print);
        seen.labels.set(labelKey, held);
      }

      for (const pr of repo.pullRequests) {
        const id = `${name}:pr:${pr.number}`;
        const print = fingerprint(pr);
        if (seen.prints.get(id) === print) continue;
        await deliver(
          report,
          'pull_request',
          { action: 'synchronize', pull_request: pr, repository: repo.repository },
          `${key}#${pr.number}`,
        );
        seen.prints.set(id, print);
      }

      for (const { issue, comment } of repo.comments) {
        const id = `${name}:comment:${comment.id}`;
        const print = fingerprint({ comment, on: issue.number, pr: Boolean(issue.pull_request) });
        if (seen.prints.get(id) === print) continue;
        await deliver(
          report,
          'issue_comment',
          {
            action: seen.prints.has(id) ? 'edited' : 'created',
            issue,
            comment,
            repository: repo.repository,
          },
          `${key}#${issue.number}/${comment.id}`,
        );
        seen.prints.set(id, print);
      }

      await removeGone(name, issues, comments, readAt, report);
      seen.issues.set(name, issues);
      seen.comments.set(name, comments);
      state.repositories[repo.repository.full_name] = {
        issues: repo.issues.length,
        pullRequests: repo.pullRequests.length,
        comments: repo.comments.length,
      };
    }
  }

  /**
   * Removes each issue and comment of `factory` the forge no longer holds: on the first poll, any
   * row the dashboard holds that the forge does not (the reconcile's rule, for rows created
   * before this read); later, what the previous poll saw and this one does not.
   */
  async function removeGone(
    factory: string,
    issues: Set<number>,
    comments: Map<number, number>,
    readAt: string,
    report: ForgePollReport,
  ): Promise<void> {
    let goneIssues: number[];
    let goneComments: number[];
    if (first) {
      goneIssues = (
        await db.query('SELECT number FROM mc.issues WHERE factory = $1 AND created_at < $2', [
          factory,
          readAt,
        ])
      )
        .map((r) => Number(r.number))
        .filter((n) => !issues.has(n));
      goneComments = (
        await db.query('SELECT id FROM mc.comments WHERE factory = $1 AND created_at < $2', [
          factory,
          readAt,
        ])
      )
        .map((r) => Number(r.id))
        .filter((id) => !comments.has(id));
    } else {
      goneIssues = [...(seen.issues.get(factory) ?? [])].filter((n) => !issues.has(n));
      goneComments = [...(seen.comments.get(factory)?.keys() ?? [])].filter(
        (id) => !comments.has(id),
      );
    }
    for (const id of goneComments) {
      await writeDelivery(
        db,
        (tx) => deleteComment(tx, factory, id),
        `forge comment removed ${id}`,
      );
      seen.prints.delete(`${factory}:comment:${id}`);
      report.removed.comments++;
    }
    for (const number of goneIssues) {
      await writeDelivery(
        db,
        (tx) => removeIssue(tx, factory, number, readAt),
        `forge issue removed ${number}`,
      );
      seen.prints.delete(`${factory}:issue:${number}`);
      seen.labels.delete(`${factory}:${number}`);
      report.removed.issues++;
    }
  }

  /** Writes the pins when the pack files changed since they were last read. */
  async function pins(report: ForgePollReport): Promise<boolean> {
    if (packs.length === 0) return false;
    const signature = packSignature(packs);
    if (signature === packsSeen) return false;
    const read: VersionCommit[] = readLocalPins(packs, authoredAt);
    if (read.length > 0) await writeDelivery(db, (tx) => writeCommits(tx, read), 'local pins');
    packsSeen = signature;
    report.pins = read.length;
    state.pins = read.map((pin) => pin.id);
    return true;
  }

  async function pollOnce(): Promise<ForgePollReport> {
    const report: ForgePollReport = {
      delivered: {},
      removed: { issues: 0, comments: 0 },
      pins: 0,
      unchanged: true,
    };
    state.polls++;
    state.lastPollAt = now().toISOString();
    try {
      if (await pins(report)) report.unchanged = false;
      const file = forgeDb();
      if (file) {
        const version = forgeDataVersion(file);
        if (version !== dataVersion) {
          const snapshot = readForgeSnapshot(
            file,
            factories.map((f) => f.repository),
          );
          await ingest(snapshot, report);
          dataVersion = version;
          first = false;
          report.unchanged = false;
        }
      }
      if (!report.unchanged) state.lastChangeAt = state.lastPollAt;
      state.lastError = null;
      const delivered = Object.values(report.delivered).reduce((a, b) => a + b, 0);
      if (delivered + report.removed.issues + report.removed.comments + report.pins > 0) {
        log(
          `forge: ${JSON.stringify(report.delivered)} delivered, ${report.removed.issues} issue(s) and ${report.removed.comments} comment(s) removed, ${report.pins} pin(s)`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      // Read again from scratch next time: what this poll wrote is upserted again, harmlessly.
      dataVersion = undefined;
      packsSeen = undefined;
      if (message !== lastLogged) console.error(`forge: poll failed: ${message}`);
      lastLogged = message;
    }
    return report;
  }

  return {
    pollOnce,
    start() {
      if (timer || running) return;
      const tick = () => {
        if (running) return;
        running = pollOnce().finally(() => {
          running = undefined;
        });
      };
      tick();
      if (pollMs > 0) timer = setInterval(tick, pollMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
      forge?.close();
      forge = undefined;
    },
    status: () => structuredClone(state),
  };
}

/**
 * The poller the server runs, from its environment: MC_FORGE_DB (the forge's SQLite file),
 * MC_APPS_DIR (the app checkouts, for pins), MC_FORGE_POLL_MS (default 5000; 0 polls only at
 * start). None without MC_DATABASE_URL, or with neither MC_FORGE_DB nor MC_APPS_DIR set.
 */
export function forgePollerFromEnv(env: Env, repoRoot: string): ForgePoller | undefined {
  const url = env.MC_DATABASE_URL;
  const forgeFile = env.MC_FORGE_DB || null;
  const appsDir = env.MC_APPS_DIR || null;
  if (!url || (!forgeFile && !appsDir)) return undefined;
  const raw = env.MC_FORGE_POLL_MS;
  const pollMs = raw === undefined || raw === '' ? DEFAULT_FORGE_POLL_MS : Number(raw);
  if (!Number.isInteger(pollMs) || pollMs < 0) {
    throw new Error('MC_FORGE_POLL_MS must be a whole number of milliseconds (0: only at start)');
  }
  return createForgePoller({
    db: openDb(url),
    factories: readFactories(env, repoRoot).map(({ name, repository }) => ({ name, repository })),
    forgeFile,
    appsDir,
    pollMs,
  });
}

/** Re-exported for the tests: the payload shapes the poller hands the seam. */
export type { Comment, Issue };
