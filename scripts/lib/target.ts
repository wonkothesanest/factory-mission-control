/**
 * The database a connection string names (local-factory port: a local Postgres database
 * stands where a Neon branch stood). Throws when the string is not a postgres URL naming one.
 */
export function databaseNameOf(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('MC_DATABASE_URL is not a connection string');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('MC_DATABASE_URL is not a postgres connection string');
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (name === '' || name.includes('/')) throw new Error('MC_DATABASE_URL names no database');
  return name;
}

/** The connection string for database `name` on the same server, as the same role. */
export function withDatabase(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}
