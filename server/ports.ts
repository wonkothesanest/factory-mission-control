/**
 * Every app instance serves on one of these ports, no other (local-factory port: Neon
 * Realtime's origin list no longer constrains them). The factory's own instance is 3092; checks
 * and app-check instances take a free one above it.
 */
export const SERVE_PORTS = { min: 3092, max: 3099 };

/** The factory dashboard's port, `start.sh`'s default. */
export const DEFAULT_PORT = 3092;
