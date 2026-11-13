import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { archonDb, snapshot } from '../db/test-db';
import factories from '../factories.json';
import type { Db } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createForgeIngestion } from './forge-seam';
import { ForgeOffline, offlineFetch, offlineGitHub } from './github';

const repoRoot = resolve(import.meta.dir, '..');
const fixtures = join(repoRoot, 'fixtures', 'webhooks');
const deliveries: { file: string; event: string }[] = JSON.parse(
  readFileSync(join(fixtures, 'deliveries.json'), 'utf-8'),
);
const payload = (file: string) => JSON.parse(readFileSync(join(fixtures, file), 'utf-8'));

let db: Db;
beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db });
});
afterEach(() => db.close());

test('the offline defaults refuse every read and never reach the network', async () => {
  await expect(
    offlineFetch('https://api.github.com/x', { method: 'GET', headers: {} }),
  ).rejects.toThrow(ForgeOffline);
  const github = offlineGitHub();
  await expect(github.fileAt('o/r', 'DECISIONS.md', 'main')).rejects.toThrow(ForgeOffline);
  await expect(github.get('/repos/o/r')).rejects.toThrow(ForgeOffline);
  await expect(github.list('/repos/o/r/issues')).rejects.toThrow(ForgeOffline);
});

test('a GitHub-shaped issue delivery from the forge writes its rows, and twice changes nothing', async () => {
  const forge = createForgeIngestion({ db, factories: factories.factories });
  const issue = deliveries.find((d) => d.event === 'issues');
  if (!issue) throw new Error('no issues fixture');
  expect(await forge.deliver(issue.event, payload(issue.file))).toEqual({
    event: 'issues',
    written: true,
  });
  const once = await snapshot(db);
  expect(once.issues?.length).toBeGreaterThan(0);
  await forge.deliver(issue.event, payload(issue.file));
  expect(await snapshot(db)).toEqual(once);
});

test('every non-push fixture is ingested offline; a push with no file source records what it could not read', async () => {
  const forge = createForgeIngestion({ db, factories: factories.factories });
  for (const d of deliveries) {
    const result = await forge.deliver(d.event, payload(d.file));
    expect(result.written).toBe(true);
    if (d.event === 'push') {
      // DECISIONS.md and the pin's pack come from the forge's files; offline, they stay unread.
      expect(result.decisions ?? result.pins ?? '').toContain('unread');
    }
  }
});

test('a delivery for a repository the dashboard does not follow writes nothing', async () => {
  const forge = createForgeIngestion({ db, factories: factories.factories });
  const before = await snapshot(db);
  const issue = deliveries.find((d) => d.event === 'issues');
  if (!issue) throw new Error('no issues fixture');
  const changed = payload(issue.file);
  changed.repository.full_name = 'someone/else';
  expect(await forge.deliver('issues', changed)).toEqual({ event: 'issues', written: false });
  expect(await snapshot(db)).toEqual(before);
});
