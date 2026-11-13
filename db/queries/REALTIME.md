# What a live query may use

Every file in this directory except this one is a live query: one read-only `SELECT`, keyed by the
factory as `$1`, named by the browser and run by the server. The step screen's panels below
`step-detail` also take the step's workflow and path as `$2` and `$3`, and every step query takes,
as its last parameter, the pin of the version the step's address names (`''` for the current
version); `home-map` takes the map's pin as `$2`.

## How a query is live (local-factory port)

Upstream sealed each query and subscribed to it through Neon Realtime. This install runs on the
factory's own Postgres and has no Neon:

- The browser opens one WebSocket per tab at `/api/live/socket` and subscribes to a query file by
  name, factory and arguments (`app/live/client.ts`). It never sends SQL. Its first rows also come
  over plain HTTP (`POST /api/live/:name`), so a page paints while its socket opens.
- The server runs the file on a read-only pool (`default_transaction_read_only`, a statement
  timeout) and pushes the rows (`server/live-hub.ts`). Values arrive as Neon Realtime delivered
  them: `int8` and `numeric` as strings, timestamps and dates as `Date`, json as values.
- Every table in `mc` has a statement trigger that `NOTIFY`s `mc_live` with its name
  (`mc_meta.notify_live`, installed by `bun run migrate`). The server `LISTEN`s
  (`server/live-listen.ts`), and on a notification runs every subscribed query again, after a
  100 ms debounce, and pushes the rows that changed. A poll every `MC_LIVE_POLL_MS` (default
  15 s) covers a dropped LISTEN connection.

## The rules the queries keep

The rules below came from what Neon Realtime accepted. They are kept: they hold every query to one
plain read, and a query whose answer does not depend on the clock only changes when its rows do,
so a refresh pushes nothing when nothing changed.

- No volatile or clock function (`now()`, `random()`): a query returns timestamps and the browser
  computes elapsed times. `db/queries.test.ts` refuses one.
- No set-returning function as a source (`generate_series`, `unnest` ...): a query that returns whole
  files splits each into parts of 4000 characters by joining a `VALUES` list of part numbers, and
  the browser joins the parts. `db/queries.test.ts` lists the banned functions in `SET_RETURNING`.
- No function of the `mc` schema: a query reads tables, so what it shows is what the rows say.
- Every table a live query reads has a primary key, and live queries read the dashboard's own
  tables, never Archon's.
