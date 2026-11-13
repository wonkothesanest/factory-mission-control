# Engineering

How this repository is built. The product is `docs/mission-control.prd.md`; this file is how.

## Layout

| Path | What lives there |
|---|---|
| `app/` | The browser app: React 19, Vite 6, Tailwind v4, react-router 7. One file per screen under `app/routes/`, registered from the directory; a file's name encodes its path (`.` separates segments, `$name` is a parameter: `f.$factory.versions.tsx` serves `/f/:factory/versions`, #73). |
| `server/` | Bun + Hono: serves the built app, `/api/health`, `/api/build-id`, and the live queries (a WebSocket at `/api/live/socket` and a first-paint `POST /api/live/:name`, fed by Postgres LISTEN/NOTIFY; see `db/queries/REALTIME.md`). `/api/actions` is the dashboard's two writes (PRD invariant 2: answer a paused run's question, resume a run) through the factory's own Archon CLI, recorded in `mc.actions`; no other code writes to a factory, which `server/write-paths.test.ts` proves. `/api/manager/*` is the Manager: a streaming chat and a daily briefing from a Claude agent with read-only tools. `start.sh` loads the factories file it serves into `mc.factories` before the server starts (`migrate:main -- --configured-factories`). |
| `db/migrations/` | SQL files, applied in full-filename order by `bun run migrate`; each idempotent. A new migration is named `<UTC timestamp>_<name>.sql`, the timestamp as `YYYYMMDDTHHMMZ` (`20261109T1430Z_stop_line.sql`) and the name lowercase `a-z0-9_`, so parallel PRs cannot pick the same name; `bun run check` rejects any other new name and any shared prefix. The `00NN_` files predate this and keep their names (the runner records applied migrations by filename). A merged migration is never edited (main has applied it and never re-runs it): change it with a new migration. |
| `db/queries/` | Every live query, one file each, named for the panel that reads it. |
| `function/` | The GitHub-shaped ingestion (`ingest.ts`) behind the forge seam (`forge-seam.ts`). Network ingestion from GitHub is disabled in this install: no webhook is served and the default reads are offline. |
| `parsers/` | Pure functions: comment formats, pin trailers, DECISIONS.md, the architecture parser. |
| `scripts/` | `fixture:branch`, `fixture:drop` (a check's own scratch database), `fixture:write`, `migrate`, `backfill`, `reconcile:laps`, `archon-guard.ts` (`guard:attach`, `guard:detach`, `guard:status`), `safety-test.ts`. |
| `fixtures/` | `seed.sql`, `expected-scorecard.json`, `webhooks/` sample payloads, `pack/` (a snapshot of the pinned workflow pack), `factory-template/` (the fence files). |
| `harness/` | `design-probe.js` and the factory harness configuration. |
| `docs/design/archon-console/` | The Archon console's tokens and components, copied from Archon. The design source of truth. |
| `factories.json` | The factories the dashboard shows (PRD 11.6). |

## Rules

- TypeScript strict everywhere. Bun 1.4 for running, testing (`bun test`) and scripts. Biome for
  lint and format; `bun run check` runs type-check, lint and unit tests with no network.
- Every live query is a single read-only SELECT with no `now()`, no `random()` and no volatile
  function. Return timestamps; the browser computes elapsed times. Every table a live query reads
  has a primary key.
- Live queries read the dashboard's own tables, never Archon's `provider_event` rows.
- A live panel's speed is judged on the app's own work (owner decision, #13/#14, revised on #137):
  its query's `EXPLAIN ANALYZE` execution under 100 ms on the seed, and its rows on screen within
  500 ms of the first snapshot arriving (decode and render). A panel reads `ready` only once rows
  the server ran for it arrived (no `initialData`).
- Nothing writes to Archon's tables, and nothing the dashboard installs may make an Archon write
  fail or slow materially. The only triggers on Archon's tables are the guards
  (`scripts/lib/archon-guard.ts`): each copies the row into a shadow table in `mc_guard` inside an
  exception block, where the projection's own triggers run, and catches everything. `bun run
  migrate` moves any trigger a migration puts on an Archon table onto its shadow; apply migrations
  only through it. `bin/detach.sh` removes every dashboard trigger from Archon's tables;
  `bin/attach.sh` puts the guards back. `bun scripts/safety-test.ts` proves it on a scratch database.
- Background repairs of the dashboard's own tables run as `reconcile:laps` / `reconcile` on the
  owner's schedule (every 10 minutes on the reference install), never by the app server or the
  webhook.
- Never write the live dashboard database from a check, a test or a lap. Use a `check-*` database
  (`bun run fixture:branch` creates one on the same server and writes `.mc-check.env`;
  `bun run fixture:drop` drops it). `scripts/` refuses any other database name for check writes.
- Configuration by environment only: `MC_DATABASE_URL`, optionally `MC_LIVE_POLL_MS` (the live
  layer's fallback poll, default 15000, 0 for none), `MC_OWNER_CONFIRM` (the live database's name,
  confirming a `:main` command without a terminal; `start.sh` sets it), and `MC_FACTORIES_FILE`
  (a factories file served instead of `factories.json`; this install's is `factories.local.json`)
  and `MC_OPERATORS_FILE` (the operator file, default `.mc-local/operators.json`, gitignored and
  written by the owner: `{"operators": {"<factory>": {...}}}`, keyed by factory name, each with `who`,
  its Archon CLI `command` as an argv array naming a real executable, an absolute `cwd` and optional
  `env`; the CLI inherits only PATH and the home and temp variables from the server, the rest comes
  from `env`. A factory without an entry keeps console links. The server refuses to start on a
  malformed file or an entry that is not a factory.)
  The Manager adds `MC_MANAGER_MODEL`, `MC_MANAGER_EFFORT`, `MC_MANAGER_MESSAGE_USD` and
  `MC_MANAGER_DAY_USD` (all optional, with defaults) and runs on the owner's Claude subscription:
  `CLAUDE_CODE_OAUTH_TOKEN`, or the machine's Claude login, set on the server. `ANTHROPIC_API_KEY`
  is optional and used only when set. With none of them the endpoint says which credential is missing.
  Never `DATABASE_URL`. Never commit a secret; `.mc-check.env` is gitignored.
- Serve on `127.0.0.1:<port>`, open as `http://localhost:<port>`, ports 3092-3099 only (3092 is
  the factory's own dashboard, `start.sh`).
- Holdout scenario text from Archon's old rows never enters the dashboard's tables or screens. The factory no longer uses holdouts.
- Design: dark only, Geist for text and Geist Mono for data. Copy the components from
  `docs/design/archon-console/`. Colors live in one place: the tokens in `index.css` and
  `theme.css` there, copied identically into `app/styles.css` (`styles.test.ts` holds the copy,
  and the design probe fails any rendered color outside them). Change a color by changing its
  token, never inline. The surfaces are the near-black neutral console (cool charcoal, hue 265:
  page `--background`, then `--surface`, `--surface-elevated` and `--surface-hover` for the header,
  cards, panels and graph nodes), with no gradient and no blue tint on any surface. Dynamous Blue
  `#3B82F6` is the one accent (owner decisions #240 and 2026-10-28, "just some blue"): the active
  tab, the selection ring and focus; Dynamous Dark `#2563EB` for hover, Dynamous Light `#60A5FA`
  for link text. Text meets WCAG AA (4.5:1) on every surface. Status colors stay distinct from
  the accent: running is Dynamous Light and always pulses or glows; teal success, red failed
  (the brand's `#047857` and `#B91C1C` are the `--*-strong` tokens).
  Magenta is not used. Data in Geist Mono with tabular
  numbers; section labels mono, uppercase, tracked. Empty states are one sentence and at most one
  button.
- v2 design (owner decision 2026-11-03): `docs/design/v2/` is the design for every v2 screen (its
  README says what is binding). The role tokens in `docs/design/v2/tokens.css` are copied
  identically into `app/styles.css` beside the console tokens, and the design probe accepts them:
  `--role-source` sky (where work comes from, scripts), `--role-agent` blue (agents),
  `--role-test` teal (testing and shipping), `--role-person` violet (the manager and the owner).
  Waiting on a person is `--role-person`, never amber; amber is not used anywhere, and the existing
  amber usages move to violet (waiting) or teal/red (status) as each screen is redone. A map card's
  border and fill are its role color mixed into the panel surface (`--card-border-tint`,
  `--card-tint`), which is the one place a tint on a surface is allowed. Copy the mockup's wording
  exactly; plain words a newcomer understands, never pack jargon on a card.
- Use a table only for a list of records a person scans row by row (recent laps, scorecard
  comparison, decisions ledger). Counts, distributions, status across many items and progress are
  drawn: bars, grids, tiles, graphs (owner decision, #241). A drawn section keeps every number and
  link the table had, as text beside the drawing, and its live updates.
- Tests sit next to the code they test (`*.test.ts`). Parsers are tested on the literal examples in
  the PRD's appendix and on `fixtures/pack/`.
- Stop every process you start by its process id; never kill by name.

## GitHub ingestion and the forge seam (local-factory port)

Upstream received GitHub webhooks in a Neon Function and backfilled from GitHub's REST API. Both
are gone here: nothing reaches api.github.com or raw.githubusercontent.com. `function/ingest.ts`
keeps the ingestion rules; `function/forge-seam.ts` is where the factory's local forge plugs in,
by delivering GitHub-shaped events (`createForgeIngestion(...).deliver(event, payload)`) or by
answering GitHub's REST paths as `Deps.github` for `bun run backfill`.

See [factory workflow policy](factory/WORKFLOW_POLICY.md) for factory-specific shared-workflow requirements.
