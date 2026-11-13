import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { actionsFromEnv } from './actions';
import { createApp } from './app';
import { resolveBuildId } from './build-id';
import { loadCheckEnv } from './check-env';
import { forgePollerFromEnv } from './forge-poller';
import { linksFromEnv } from './links';
import { liveFromEnv } from './live';
import { managerFromEnv } from './manager';
import { DEFAULT_PORT, SERVE_PORTS } from './ports';
import { serve } from './serve';

const USAGE = `usage: bun run serve -- [--port <${SERVE_PORTS.min}-${SERVE_PORTS.max}>] (default ${DEFAULT_PORT})`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < SERVE_PORTS.min || port > SERVE_PORTS.max) {
  console.error(USAGE);
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, '..');
loadCheckEnv(repoRoot, Bun.env);
const distDir = join(repoRoot, 'dist');
if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html is missing: run `bun run setup` first');
  process.exit(1);
}

let manager: ReturnType<typeof managerFromEnv>;
try {
  manager = managerFromEnv(Bun.env, repoRoot);
} catch (error) {
  console.error(`manager settings: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

let actions: ReturnType<typeof actionsFromEnv>;
try {
  actions = actionsFromEnv(Bun.env, repoRoot);
} catch (error) {
  console.error(`operators: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

let live: ReturnType<typeof liveFromEnv>;
try {
  live = liveFromEnv(Bun.env, repoRoot);
} catch (error) {
  console.error(`live queries: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if (!live) console.warn('MC_DATABASE_URL is not set: every live panel will show an error');

let forge: ReturnType<typeof forgePollerFromEnv>;
try {
  forge = forgePollerFromEnv(Bun.env, repoRoot);
} catch (error) {
  console.error(`forge ingestion: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if (forge) {
  const { file, pollMs } = forge.status();
  console.log(
    `forge ingestion: ${file ?? 'no forge file (MC_FORGE_DB unset)'}, every ${pollMs} ms; pins from ${Bun.env.MC_APPS_DIR || 'nowhere (MC_APPS_DIR unset)'}`,
  );
  forge.start();
} else {
  console.warn('forge ingestion is off: set MC_FORGE_DB (and MC_APPS_DIR for pins)');
}

let links: ReturnType<typeof linksFromEnv>;
try {
  links = linksFromEnv(Bun.env, repoRoot);
} catch (error) {
  console.error(`links: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const app = createApp({
  buildId: resolveBuildId(Bun.env, repoRoot),
  distDir,
  live,
  manager,
  actions,
  forge,
  links,
});
const server = serve({ app, live, hostname: '127.0.0.1', port });
console.log(`serving http://localhost:${server.port}`);

const shutdown = async (signal: string) => {
  console.log(`${signal}: stopping`);
  server.stop(true);
  await forge?.stop().catch(() => {});
  await live?.close().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
