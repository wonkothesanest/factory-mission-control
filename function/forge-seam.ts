// The forge seam (local-factory port).
//
// Upstream, GitHub fed the dashboard's issue, pull request, comment, label and version rows in two
// ways: a webhook that a Neon Function received (`function/app.ts`), and `bun run backfill`, which
// read GitHub's REST API. Both reached the network (GitHub's API and raw-content hosts).
// This install disables that: no webhook is served, the Neon Function is gone, and the scripts'
// default GitHub (`offlineGitHub` in `function/github.ts`) refuses every read.
//
// The factory's local forge keeps GitHub-shaped issues, pull requests and comments in SQLite. It
// plugs in here, in one of two ways, without touching the ingestion rules in `function/ingest.ts`:
//
//   1. Events: for each change, call `deliver(event, payload)` below with the same event name and
//      payload GitHub's webhook would send (`issues`, `issue_comment`, `label`, `pull_request`,
//      `push`). `files` answers the few file reads a `push` needs (DECISIONS.md, a pin's pack).
//   2. History: implement `GitHub` (`fileAt`, `get`, `list` over GitHub's REST paths) on the forge
//      and hand it to `bun run backfill` / `reconcile` as `Deps.github` (scripts/lib/cli.ts).
//
// Either way every write is the same keyed upsert the webhook made, so replaying is harmless.

import type { Db } from '../scripts/lib/db';
import { writeDelivery } from './app';
import { type GitHub, offlineGitHub } from './github';
import { type Factory, prepare } from './ingest';

export interface ForgeDeliveryResult {
  event: string;
  /** False when the delivery names nothing the dashboard keeps (another repository, a branch push). */
  written: boolean;
  /** Set when a push touched DECISIONS.md but `files` could not give it. */
  decisions?: string;
  /** Set when a pin was written without its Archon sha. */
  pins?: string;
}

export interface ForgeIngestion {
  deliver(event: string, payload: unknown, delivery?: string): Promise<ForgeDeliveryResult>;
}

export function createForgeIngestion({
  db,
  factories,
  files = offlineGitHub(),
}: {
  db: Db;
  /** The factories the dashboard shows (factories.json): deliveries for other repositories write nothing. */
  factories: Factory[];
  /** The forge's file reads at a ref; offline (every read refused) until the forge provides one. */
  files?: GitHub;
}): ForgeIngestion {
  return {
    async deliver(event, payload, delivery = event) {
      const prepared = await prepare(event, payload, { factories, github: files });
      if (prepared) await writeDelivery(db, prepared.write, delivery);
      return {
        event,
        written: prepared !== null,
        ...(prepared?.decisionsUnread !== undefined && {
          decisions: `unread: ${prepared.decisionsUnread}`,
        }),
        ...(prepared?.pinsUnread !== undefined && { pins: `unread: ${prepared.pinsUnread}` }),
      };
    },
  };
}
