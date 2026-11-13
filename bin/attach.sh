#!/bin/bash
# attach.sh: install the dashboard's exception-safe guard triggers on Archon's tables (idempotent),
# then bring the run mirror up to Archon's rows. Needs the migrations applied (start.sh does both).
# What the guard is: scripts/lib/archon-guard.ts. Undo with bin/detach.sh.
set -euo pipefail
# shellcheck source=bin/context.sh
source "$(dirname "${BASH_SOURCE[0]}")/context.sh"
cd "$MC_ROOT"
timeout 120 "$BUN" scripts/archon-guard.ts attach "$@"
rm -f "$MC_ROOT/.detached"
