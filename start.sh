#!/bin/bash
# start.sh: run Mission Control for the local factory, in the foreground.
#   bin/factory-up launches it with setsid nohup and records its PID; it execs into the server, so
#   that PID is the server's. Stop it with bin/factory-down (or kill that PID).
#
# Steps, each idempotent:
#   1. build the browser app (dist/) when it is missing or older than the checkout's HEAD;
#   2. apply the migrations to the factory Postgres (schemas mc, mc_guard, mc_meta only) and load
#      factories.local.json into mc.factories; no DDL at all when nothing is new;
#   3. store the architecture of each Archon sha the app checkouts pin (apps/<repo>/factory/pack.json)
#      from local paths, unless it is stored already (scripts/local-arch.ts);
#   4. attach the exception-safe guard triggers to Archon's tables (skipped while .detached exists,
#      i.e. after bin/detach.sh, until bin/attach.sh); no DDL, and no lock on Archon's tables, when
#      the guard is already in place;
#   5. serve UI + API + live socket on 127.0.0.1:${MC_PORT:-3092}; the server reads the local forge
#      (MC_FORGE_DB, read-only) and the app checkouts' pins (MC_APPS_DIR) every 5 s.
#
# Another database (a scratch one for a test) is MC_DATABASE_URL plus MC_OWNER_CONFIRM naming it.
set -euo pipefail
# shellcheck source=bin/context.sh
source "$(dirname "${BASH_SOURCE[0]}")/bin/context.sh"
cd "$MC_ROOT"

PORT="${MC_PORT:-3092}"
export MC_FACTORIES_FILE="${MC_FACTORIES_FILE:-$MC_ROOT/factories.local.json}"
# The factories this install shows are the operator's own list, not part of the dashboard's code.
# factories.local.example.json is the template: one entry per factory, its forge repository
# (owner/name), its Archon codebase name, the Archon console, and optionally code_web, the web
# address of the repository where published branches live.
if [ ! -f "$MC_FACTORIES_FILE" ]; then
  echo "start.sh: no factory list at $MC_FACTORIES_FILE." >&2
  echo "  Copy factories.local.example.json to factories.local.json and list your factories in it." >&2
  exit 1
fi
# The local forge's SQLite file (opened read-only) and the app checkouts (factory/pack.json pins).
export MC_FORGE_DB="${MC_FORGE_DB:-$FACTORY_ROOT/forge/state/forge.db}"
export MC_APPS_DIR="${MC_APPS_DIR:-$FACTORY_ROOT/apps}"
# The Manager runs on the operator's Claude subscription login, never an API key from the shell, and
# only when a person asks it something (MC_MANAGER_AUTO_BRIEFING is off unless set to 1).
unset ANTHROPIC_API_KEY CLAUDE_API_KEY
# The :main scripts ask the operator to confirm the live database by name; this start is the
# operator's. A start against another database names that one instead.
export MC_OWNER_CONFIRM="${MC_OWNER_CONFIRM:-archon}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start.sh: $*"; }

if [ ! -d node_modules ]; then
  log "installing dependencies"
  timeout 600 "$BUN" install --frozen-lockfile
fi

if [ ! -f dist/index.html ] ||
  [ -n "$(find app vite.config.ts package.json bun.lock -newer dist/index.html -print -quit)" ]; then
  log "building the browser app"
  timeout 300 "$BUN" x vite build --logLevel warn
fi

# The migration never touches the guard (--no-attach): attaching is step 4's job alone, so a start
# issues trigger DDL on Archon's tables at most once, and only when the guard differs.
log "migrating"
timeout 300 "$BUN" scripts/migrate.ts --main --configured-factories --no-attach

# Writes only mc.arch_*, and nothing for a version already stored; a failure leaves the step pages
# on whatever architecture is stored and does not stop the start.
log "storing the architecture of the pinned Archon versions (local paths)"
timeout 180 "$BUN" scripts/local-arch.ts --main || log "local-arch failed; the dashboard starts anyway"

if [ -e .detached ]; then
  log ".detached exists: not attaching to Archon's tables (bin/attach.sh re-attaches)"
else
  # Compares the guard with the catalog and issues no DDL when it is already in place; a DDL that
  # is needed waits at most 50 ms per try for its lock on an Archon table (scripts/lib/archon-guard.ts).
  log "attaching the guard and bringing the run mirror up to date"
  timeout 120 "$BUN" scripts/archon-guard.ts attach
  # Replays the step events of runs the projection missed (written before the first attach or
  # while detached). Reads Archon's tables, writes only mc; a failure here does not stop the start.
  log "repairing laps the projection missed"
  timeout 180 "$BUN" scripts/reconcile-laps.ts --main || log "reconcile:laps failed; the dashboard starts anyway"
fi

log "serving on http://127.0.0.1:$PORT"
exec "$BUN" server/main.ts --port "$PORT"
