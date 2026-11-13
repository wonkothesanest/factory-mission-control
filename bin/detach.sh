#!/bin/bash
# detach.sh: drop every dashboard trigger from Archon's tables (idempotent). Run it before an
# Archon upgrade or whenever the dashboard is suspected of touching Archon's writes. It leaves the
# dashboard's own schemas (mc, mc_guard, mc_meta) in place; start.sh will not re-attach while the
# .detached marker this writes exists. Re-attach with bin/attach.sh.
#
# It needs nothing the dashboard installed: if bun or the dashboard is broken, the same effect from
# psql is `DROP SCHEMA mc_guard CASCADE;` (drops every guard and with it every trigger on Archon).
set -euo pipefail
# shellcheck source=bin/context.sh
source "$(dirname "${BASH_SOURCE[0]}")/context.sh"
cd "$MC_ROOT"
touch "$MC_ROOT/.detached"
timeout 120 "$BUN" scripts/archon-guard.ts detach
