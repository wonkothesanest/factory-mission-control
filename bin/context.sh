#!/bin/bash
# Sourced by start.sh, bin/attach.sh and bin/detach.sh: the paths and database settings the
# dashboard runs with in the local factory. Prints nothing; never prints a secret.
#
#   MC_ROOT        this checkout
#   FACTORY_ROOT   the factory (two levels up)
#   BUN            the project's bun (tools/bun/bin/bun)
#   MC_DATABASE_URL  the factory Postgres, database "archon" (kept when already set), password read
#                  from secrets/postgres.pw
# Caches and temp files stay inside the factory (never $HOME).

MC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FACTORY_ROOT="$(cd "$MC_ROOT/../.." && pwd)"
BUN="$FACTORY_ROOT/tools/bun/bin/bun"
export MC_ROOT FACTORY_ROOT BUN

if [ ! -x "$BUN" ]; then
  echo "mission-control: $BUN is missing" >&2
  exit 1
fi

if [ -z "${MC_DATABASE_URL:-}" ]; then
  pw_file="$FACTORY_ROOT/secrets/postgres.pw"
  if [ ! -r "$pw_file" ]; then
    echo "mission-control: $pw_file is not readable" >&2
    exit 1
  fi
  MC_DATABASE_URL="postgresql://archon:$(tr -d '\n' < "$pw_file")@127.0.0.1:55432/archon"
  unset pw_file
fi
export MC_DATABASE_URL

mkdir -p "$MC_ROOT/.tmp/run" "$MC_ROOT/.tmp/cache"
# Everything the dashboard writes stays in this checkout's .tmp/ (git-ignored): never $HOME, and
# never the factory's own cache/ (other tools own it).
export BUN_INSTALL_CACHE_DIR="$MC_ROOT/.tmp/cache/bun-install"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="$MC_ROOT/.tmp/cache/bun-transpiler"
export DO_NOT_TRACK=1
export TMPDIR="$MC_ROOT/.tmp/run"
# Tools that follow the XDG base directories (biome, the Manager's Claude CLI) cache here, not ~/.cache.
export XDG_CACHE_HOME="$MC_ROOT/.tmp/cache"
