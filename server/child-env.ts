/** The part of the dashboard's environment a child CLI may inherit: where to find programs and a home, never a credential. */
export const BASE_ENV_NAMES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
];

/**
 * Where a child keeps its caches and temp files (local-factory port): without them a CLI and
 * a bun it starts write theirs under the home directory (~/.cache, ~/.bun); with them, where
 * bin/context.sh points them, inside this checkout's .tmp/. Paths only, never a credential.
 */
export const CACHE_NAMES = [
  'TMPDIR',
  'XDG_CACHE_HOME',
  'BUN_INSTALL_CACHE_DIR',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
];

export function pick(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
