# Mission Control, local port (local factory)

This checkout is factory-mission-control (upstream `f301af0d`, the first commit here) ported to run
entirely on this machine for the local factory: no Neon, no GitHub, the factory's own
Postgres and local forge, served on `127.0.0.1:3092`. In the private history each later commit was one part of the port; this public snapshot squashes them into one commit.

> **Public snapshot note.** This port was built inside a private project. Paths this document names outside this repository (`bin/factory-up`, `forge/`, `secrets/`, `proof/*.png`), the verification evidence under `docs/evidence/local-port/`, the factory list `factories.local.json`, and the commit IDs it cites belong to that project and are not included here.

## Run it

```bash
dashboards/mission-control/start.sh          # foreground; bin/factory-up runs it with setsid nohup
```

`start.sh` runs these steps, each idempotent, then execs the server with the project bun
(`tools/bun/bin/bun`). Stop it with `bin/factory-down` or by its PID (the server keeps start.sh's PID).

1. Builds `dist/` when the app sources changed.
2. Applies the migrations to the factory Postgres (`127.0.0.1:55432`, database `archon`, password
   from `secrets/postgres.pw`) and loads `factories.local.json`. With nothing new it issues no DDL.
3. Stores the architecture of each Archon sha the app checkouts pin (`apps/<repo>/factory/pack.json`)
   from local paths, unless it is stored already (`scripts/local-arch.ts`).
4. Attaches the guard to Archon's tables (skipped while `.detached` exists). With the guard already in
   place it issues no DDL and takes no lock on Archon's tables. Then it replays the laps the projection
   missed (`reconcile:laps:main`).
5. Serves UI, API and live socket on `127.0.0.1:${MC_PORT:-3092}`. The server reads the local forge
   every 5 s (below).

| What | Where |
|---|---|
| UI, API, live socket | `http://localhost:3092`, `/api/health`, `/api/live`, `/api/forge`, `ws://localhost:3092/api/live/socket` |
| Factories shown | `factories.local.json`: `widgets`, `gadgets` (Archon codebases `example/<repo>`) and `sandbox` (the `authcheck` smoke-test codebase). |
| Schemas FMC writes | `mc` (the dashboard), `mc_guard` (guards and shadow tables), `mc_meta` (migration ledger, NOTIFY function). Nothing in `public`. |
| Files FMC reads, never writes | `forge/state/forge.db` (opened read-only), `apps/<repo>/factory/pack.json` and `git log` there, `cache/factory/archon/<sha>/.archon/workflows`, `upstream/ai-software-factory/template` |
| Temp files and caches | This checkout's `.tmp/` only (`TMPDIR`, `XDG_CACHE_HOME`, bun's install and transpiler caches, from `bin/context.sh`), for everything FMC spawns. Not `$HOME`, and not the factory's `cache/`. The one exception is the Manager's Claude CLI when a person asks it something ("The Manager", below). |

Settings start.sh passes (override by exporting them first): `MC_PORT`, `MC_DATABASE_URL`,
`MC_OWNER_CONFIRM` (the database name the `:main` scripts may write; `archon` by default),
`MC_FACTORIES_FILE`, `MC_FORGE_DB`, `MC_APPS_DIR`. The server also reads `MC_FORGE_POLL_MS` (5000),
`MC_MANAGER_AUTO_BRIEFING` (off) and `MC_MANAGER_LOGIN`.

## The safety rule: Archon's writes never fail or slow because of this

Upstream put the projection's triggers on Archon's tables. Their bodies catch errors, but some
failures escape a PL/pgSQL exception block (an error inside the handler, a body that no longer
compiles), and those fail Archon's write. `bun scripts/safety-test.ts` shows exactly that as its
control case.

Here the only triggers on Archon's tables are guards (`scripts/lib/archon-guard.ts`):

- `mc_guard.guard_<table>()` copies the row into a shadow table `mc_guard.<table>` inside
  `BEGIN ... EXCEPTION WHEN OTHERS`; on any error it raises a `WARNING`, counts it in
  `mc_guard.guard_errors`, and returns `NULL`. It sets `lock_timeout = 100ms` for everything it
  runs. The upstream projection triggers run, unchanged, on the shadow tables.
- `bun run migrate` moves any trigger a migration puts on an Archon table onto its shadow, inside
  that migration's transaction. Apply migrations only through it (`psql -f` of a migration file
  would put the trigger straight on Archon's table; `bin/detach.sh` removes such a trigger too).
- `bin/detach.sh` drops every dashboard trigger from Archon's tables (idempotent, needs nothing the
  dashboard installed) and writes `.detached`, so `start.sh` will not re-attach. `bin/attach.sh`
  re-attaches and projects the runs written meanwhile. From psql, with nothing else working:
  `DROP SCHEMA mc_guard CASCADE;`. Detach before an Archon upgrade that changes its tables.
- Archon and the dashboard both use the `archon` role here. If Archon ever writes as another role,
  grant it `USAGE` on `mc_guard` and `ALL` on its tables, or the guards will (safely) skip.

### A restart issues no DDL

Trigger DDL on an Archon table waits for a lock that Archon's writes hold, and every later Archon
write queues behind it. So a start never runs DDL it does not need:

- `attach` compares the catalog with what it would install (each trigger's `pg_trigger` row: events,
  timing, enabled, no WHEN, arguments or column list, the same function; each guard function's body,
  settings, language and return type) and writes only what differs. The migration ledger, the guard
  error table and the live NOTIFY function are created only when missing or different.
- `start.sh` runs `migrate --no-attach`, so a start attaches at most once.
- A DDL that is needed runs one Archon table per transaction, in table order, waiting at most 50 ms
  per try for its lock (20 tries), so Archon waits at most 50 ms per try and FMC never holds one Archon
  table's lock while waiting for another's.

Proof, on a scratch database the test creates and drops (Archon's schema at pin `1cfb8fc5`):

```bash
source bin/context.sh && MC_FORGE_DB=<a forge.db or a copy> $BUN scripts/restart-test.ts \
  "$FACTORY_ROOT/cache/factory/archon/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb/migrations/000_combined.sql" \
  [--control <a checkout of an earlier start>]
```

It runs the real `start.sh` twice. An event trigger counts every DDL command and every dropped object
by schema, in sequences, so DDL in a rolled-back transaction counts too. The second start runs while
an Archon-shaped transaction holds `remote_agent_workflow_events` open, a second session inserts an
event every 20 ms and updates its run every 100 ms, and a third samples `pg_locks` every 5 ms. Result
(`docs/evidence/local-port/restart-no-ddl.json`, 2026-11-13):

| | DDL on Archon's tables | DDL on mc, mc_guard, mc_meta | strong locks or lock waits on Archon's tables | Archon inserts, max |
|---|---|---|---|---|
| restart (this checkout) | 0 | 0 (8 commands, all on reconcile:laps's session temp tables) | none | 2.0 ms (4.7 ms in the 2 s before) |
| control: the previous start (`0426725`) | its CREATE OR REPLACE TRIGGER waited (ShareRowExclusiveLock), then timed out | 19 | the trigger DDL waiting, and the Archon writer queued behind it | 5001 ms |

The guard triggers and functions keep the same catalog rows (`xmin`) across the restart. The first
start's guard install shows up as trigger DDL on Archon's tables, so the audit sees that kind of DDL.

The live start of 2026-11-13 printed `no trigger DDL: every guard was already in place` and
`applied 0 migration(s)`. A read-only session sampled `pg_locks` 456 times during it and saw no strong
lock or lock wait on Archon's tables. The guard catalog rows did not change.

`bun scripts/safety-test.ts <000_combined.sql>` covers the guard itself on a scratch database: only
guards on Archon's tables; the projection follows Archon; a locked dashboard table delays Archon by at
most the guard's 100 ms; with the projection's functions and tables dropped every Archon write still
succeeds and the guard counts what it caught; detach is clean; restart scenarios with and without the
guard in place; and the control (the upstream arrangement fails the same insert). `db/guard.test.ts`
runs the same cases offline on PGlite, plus "a second attach or migrate run issues no DDL statement and
changes no catalog row".

## Live updates (Neon Realtime replaced)

Every `mc` table has a statement trigger that `NOTIFY mc_live`. The server `LISTEN`s, re-runs every
subscribed query file 100 ms after a burst, and pushes rows that changed over one WebSocket per tab;
a page's first rows also come over `POST /api/live/:name`. A 15 s server-side poll covers a dropped
LISTEN connection (`MC_LIVE_POLL_MS`, 0 turns it off). `LivePanel`/`LiveProvider` keep their
interface. Details: `db/queries/REALTIME.md`.

## Local forge ingestion (GitHub replaced)

Nothing reaches GitHub, and no code names its API or raw-content host (`server/write-paths.test.ts`
checks this). The factory's local forge (`forge/`, contract in `forge/CONTRACT.md`) keeps
GitHub-shaped issues, pull requests, comments and labels in SQLite, with github.com-style URLs and
GitHub's numbering. The server ingests them through the forge seam (`function/forge-seam.ts`):

- `function/forge-local.ts` opens `MC_FORGE_DB` (start.sh: `forge/state/forge.db`) **read-only**
  (`SQLITE_OPEN_READONLY`, 2 s busy wait). It reads one consistent snapshot per poll in a single read
  transaction and maps the rows into the webhook payload shapes `function/ingest.ts` reads.
- `server/forge-poller.ts`, at start and every `MC_FORGE_POLL_MS` (5000 ms): it hands each issue, pull
  request and comment that is new or changed to the seam as the delivery GitHub would have sent:
  `issues` (or `labeled` with the label when an issue gained one, which records when it was
  labelled), `pull_request`, `issue_comment`. The seam stores each with the webhook's keyed upserts in
  its own short transaction, and every `mc` write NOTIFYs `mc_live`, so open pages update without a
  reload. What the forge no longer holds is removed with the reconcile's own removals. The first poll
  after a start also removes rows of a followed repository that the forge does not hold. A poll that
  finds the forge unchanged (SQLite's `data_version`) and no pack file changed reads and writes
  nothing.
- `GET /api/forge` shows the file, polls, last poll and change, last error, and what each followed
  repository holds.
- Owner questions come from the forge too. An open issue labelled `needs-owner` is on Attention
  ("Decide") and the Board, and the manager's `Owner decisions needed` issue body becomes question
  rows, as upstream.

Proof that a new forge issue and comment appear live. It used a scratch Postgres database, a scratch
copy of `forge.db` made through a read-only connection, the forge's own store code writing that copy,
and start.sh on port 3093. Result: `docs/evidence/local-port/forge-live.json`, screenshots
`proof/mission-control-forge-live-{board,work}-{before,after}.png`. The open Board page showed the new
`needs-owner` issue 303 ms after the forge write. On the open work-item page, the new
`Loop claim: run <id>` comment turned into "Round 1: running / Open the run" 707 ms after the write.
Neither page reloaded. The next 5 s poll picked up each write.

### Pins and the current version

No versions repository exists here. Each app checkout's `factory/pack.json` names the Archon sha its
factory runs (`integration_revision_required`). `function/local-pins.ts` writes one pin per distinct
sha through the push path's upsert (`writeCommits`). The pin is keyed by the sha itself and dated by
the earliest author date of the commits that last changed those pack files (`git log`, read-only; an
author date survives the forge's rebase of the overlay). The map, the step pages and the version strip
then have a current version without `?at=`. Decisions and verdicts stay empty: they came from the
versions repository.

### Architecture

`scripts/arch-parse.ts` reads local paths only (`--archon-path` plus `--factory-path` or
`--package-path`; its GitHub branch is removed). `start.sh` runs `scripts/local-arch.ts`. That script
parses each pinned sha from `cache/factory/archon/<sha>/.archon/workflows` and the factory template
in `upstream/ai-software-factory/template` (at its checked-out commit), with `--if-missing`, so a
version already stored is left untouched.

## The Manager

The Manager answers questions and writes a daily briefing by running a Claude Agent SDK CLI.

- **Nothing starts it on page load.** `MC_MANAGER_AUTO_BRIEFING` is off unless set to `1`. The panel
  asks `GET /api/manager/settings` and, with automatic briefings off, offers a
  **Write today's briefing** button. The briefing route refuses a briefing without
  `requested: true` (409, no CLI started). Opening any page makes no Manager request but that GET.
  The live check of 22 pages at 1600 px saw no child process of the server.
- **What starts it:** a person pressing *Write today's briefing*, sending a question, or pressing a
  suggested question. With `MC_MANAGER_AUTO_BRIEFING=1`, also opening the panel (once per factory
  per server start, cached for the day).
- **Login and where it writes** (`MC_MANAGER_LOGIN`):
  - `home` (the default when the server's environment holds no credential): the operator's own Claude
    login under `$HOME`. Every CLI run then writes under the operator's home. The round-1 verifier
    observed `~/.claude.json` and its backups (`~/.claude/backups/`), plus `~/.claude/sessions/`,
    `~/.claude/plugins/`, `~/.claude/policy-limits*`, `~/.claude/remote-settings*` and
    `~/.claude/skills/synced/`. This is the one sanctioned write under `$HOME`, and it happens only
    when a person asks. The runs use `persistSession: false`, so no conversation transcript is kept.
    The list was not re-measured in round 2, because measuring it means a real briefing on the
    operator's subscription.
  - `isolated` (the default when `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set on the
    server; start.sh unsets `ANTHROPIC_API_KEY`): `HOME` and `CLAUDE_CONFIG_DIR` are
    `.tmp/manager-home` in this checkout, so nothing goes under `$HOME`. A token from
    `claude setup-token` uses the operator's subscription this way.
  - `off`: no CLI ever starts. The Manager routes answer 503, and the panel says why.
- In every mode the CLI gets `TMPDIR`, `XDG_CACHE_HOME` and bun's cache paths from `.tmp/`. Day and
  per-message spend caps: `MC_MANAGER_DAY_USD` (5) and `MC_MANAGER_MESSAGE_USD` (0.5).

## Checks and parallel instances

Neon branches are gone. `bun run fixture:branch` (with the factory's `MC_DATABASE_URL`) creates a
`check-<id>` database on the same server with Archon's schema snapshot, the migrations and the seed,
and writes `.mc-check.env`. A server started without `MC_DATABASE_URL` serves it on any port in
3093-3099. `bun run fixture:drop` drops it (`--all` drops every `check-*` database). Check scripts
refuse any database not named `check-*`, and `:main` scripts refuse a `check-*` one. The restart and
forge proofs make their own `scratch-*` databases and drop them.

Tests: `bun run check` (typecheck, lint, map check, the whole offline suite on PGlite and headless
Chrome). On 2026-11-13: typecheck and map check clean; 2067 pass, 1 skip, 0 fail across 138 files.

Headless Chrome (the browser tests, `scripts/lib/cdp.ts`) gets `CHROME_CONFIG_HOME` and
`XDG_CONFIG_HOME` set to its throwaway profile. Without them Chrome's crash reporter updates
`~/.config/google-chrome/Crash Reports/settings.dat` whatever `--user-data-dir` says. A screenshot
taken with the contract's `google-chrome --headless=new ... --screenshot` command needs the same two
settings to leave `$HOME` alone.

## Pages with the live factories (2026-11-13, Archon pin 1cfb8fc5)

Every page loads with every live panel `ready` (none `error`, none stuck `loading`), checked over CDP
at 1600 px on 22 addresses. Screenshots are in `proof/mission-control-*.png`.

| Page | Shows now |
|---|---|
| Attention | widgets #1 and #3, gadgets #1 and #2 (all `needs-owner`) under Decide |
| Factory map | the map, `VERSION 1cfb8fc5 2026-11-13 current`, Manager card "2 waiting"; Scorecard empty (it reads `archon-metrics-prs` records, which the pinned pack does not write) |
| Board | pipeline: the `needs-owner` items under Blocked and parked; table: "Your decision" with route, round, app check, PR #2 / PR #4 |
| Work item | widgets #1 (PR #2), #3 (PR #4), gadgets #1 (PR #3), #2 (PR #4): filed, round, app check PASS, review approved |
| Runs, run page | the factories' archon-loop laps with their item and PR, cost, steps; the failed lap's error and Manager's read |
| Step page | full step detail of the current version without `?at=` |
| sandbox | the authcheck run |

## Known gaps and choices

- Links the dashboard shows for issues and pull requests ("Answer on GitHub", Issue, PR #n) are the
  forge's github.com-style URLs. They do not resolve. The forge's own board is
  `http://127.0.0.1:3091`.
- Updates from the forge reach the dashboard on the next poll: up to 5 s (`MC_FORGE_POLL_MS`).
- A label that an issue already had when the server started has no recorded time (the forge keeps
  none), so the owner queue counts its wait from the issue's last update, marked approximate. A label
  gained while the server runs is timed.
- Labels on pull requests (the forge has `needs-owner` on widgets PR #2) do not reach the owner
  queue: upstream reads labels from issues only. Forge reviews, review threads and checks are not
  ingested, as upstream did not ingest them.
- The pinned pack's loop writes `Loop review: approved (route: ...)`. Upstream's comment parser knows
  `merged`, `not merged` and `sent back`, so `mc.reviews` stays empty for approvals. The work item and
  the run show the review from the lap's own step output instead.
- `reconcile:laps` replays every finished run at each start through session temp tables. That is DDL
  only on `pg_temp`, with AccessShare locks on Archon's tables, which never conflict with Archon's
  writes.
- Decisions and verdicts are empty (they came from the versions repository).
- `test:live` (Neon Realtime timing and probe checks on a check branch) is removed, not ported.
- Actions (answer or resume a paused run through Archon's CLI) need `.mc-local/operators.json`.
  Without it the dashboard shows console links only. When configured, the action CLI gets `.tmp/`
  temp and cache paths, but its home is whatever `operators.json` gives it.
- `mc.rewind_branches` is dropped by a migration. The `0008_rewind_branches.sql` file stays, because
  the ledger records migrations by name.
- `biome check` reports an internal error on `app/components/ui/ui.test.tsx` (an upstream file saved
  as Latin-1). It is unchanged from upstream.
