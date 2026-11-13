// Pins from the factory's own checkouts (local-factory port). Upstream a pin is a
// `Pin Archon <sha>: <reason>` commit on coleam00/ai-software-factory's default branch, whose
// template/factory/pack.json names the full Archon sha. Here each app checkout carries its own
// copy, `<apps>/<repo>/factory/pack.json`, whose `integration_revision_required` is the Archon sha
// the factory runs. Each distinct sha is one pin, keyed by that sha (there is no versions
// repository to name a commit of), dated by the earliest author date among the commits that last
// changed a pack.json pinning it (an author date survives the forge's rebase of the overlay), and
// written through the push path's own upsert (function/ingest.ts writeCommits).
//
// Reads files and `git log` only; writes nothing in the checkouts.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_NAMES, pick } from '../server/child-env';
import type { Factory, VersionCommit } from './ingest';

export const PACK_FILE = 'factory/pack.json';
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface PackFile {
  /** The factory whose repository's checkout holds it. */
  factory: string;
  /** `<apps>/<repo>`, the checkout. */
  checkout: string;
  path: string;
}

/** The pack file each factory's checkout would hold: `<appsDir>/<repository name>/factory/pack.json`. */
export function packFiles(appsDir: string, factories: Factory[]): PackFile[] {
  return factories.flatMap(({ name, repository }) => {
    const repo = repository.split('/').pop();
    if (!repo) return [];
    const checkout = join(appsDir, repo);
    return [{ factory: name, checkout, path: join(checkout, PACK_FILE) }];
  });
}

/** Size and modification time of each pack file that exists: what tells a poll to read them again. */
export function packSignature(files: PackFile[]): string {
  return files
    .map((file) => {
      try {
        const stat = statSync(file.path);
        return `${file.path}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${file.path}:-`;
      }
    })
    .join('|');
}

/** The full Archon sha a pack file pins, or null when it pins none (or is missing or not JSON). */
export function pinnedSha(text: string | null): string | null {
  if (text === null) return null;
  try {
    const value = (JSON.parse(text) as { integration_revision_required?: unknown })
      ?.integration_revision_required;
    return typeof value === 'string' && FULL_SHA.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** When the checkout's last commit touching the pack file was authored, ISO 8601, or null. */
export type AuthoredAt = (checkout: string) => string | null;

/** `git log -1 --format=%aI -- factory/pack.json` in the checkout: a read, never a write. */
export const gitAuthoredAt: AuthoredAt = (checkout) => {
  try {
    const result = Bun.spawnSync(
      ['git', '-C', checkout, 'log', '-1', '--format=%aI', '--', PACK_FILE],
      {
        env: { ...pick(process.env, ['PATH', 'HOME', ...CACHE_NAMES]), GIT_OPTIONAL_LOCKS: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      },
    );
    const out = result.stdout.toString().trim();
    return result.exitCode === 0 && out !== '' ? new Date(out).toISOString() : null;
  } catch {
    return null;
  }
};

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * One pin per distinct Archon sha the factories' pack files pin, as the push path writes a pin
 * commit: `id` and `archonSha` are the sha, `message` is `Pin Archon <sha>: <reason>` naming the
 * factories that pin it, `timestamp` the earliest authored-at (else the pack file's mtime).
 */
export function readLocalPins(
  files: PackFile[],
  authoredAt: AuthoredAt = gitAuthoredAt,
): VersionCommit[] {
  const pins = new Map<string, { factories: string[]; at: string }>();
  for (const file of files) {
    const sha = pinnedSha(readText(file.path));
    if (sha === null) continue;
    let at = authoredAt(file.checkout);
    if (at === null) {
      try {
        at = new Date(statSync(file.path).mtimeMs).toISOString();
      } catch {
        continue;
      }
    }
    const pin = pins.get(sha);
    if (!pin) pins.set(sha, { factories: [file.factory], at });
    else {
      pin.factories.push(file.factory);
      if (at < pin.at) pin.at = at;
    }
  }
  return [...pins]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sha, { factories, at }]) => ({
      id: sha,
      archonSha: sha,
      message: `Pin Archon ${sha}: pinned by ${factories.sort().join(', ')} (${PACK_FILE})`,
      timestamp: at,
    }));
}
