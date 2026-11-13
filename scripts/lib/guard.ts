// local-factory port: Neon branches are gone. A check runs against its own scratch database
// on the factory's Postgres, named `check-<id>` (`bun run fixture:branch`), and never against the
// live dashboard database. Every write path checks the database's name first.

const CHECK_DATABASE = /^check-[a-z0-9-]+$/;

export function isCheckDatabase(name: string): boolean {
  return CHECK_DATABASE.test(name);
}

export class RefusedDatabase extends Error {
  constructor(name: string, reason = 'only check-* databases') {
    super(`refusing database '${name}': ${reason}`);
    this.name = 'RefusedDatabase';
  }
}

/** Every check write path calls this before its first mutating SQL statement. */
export function requireCheckDatabase(name: string): void {
  if (!isCheckDatabase(name)) throw new RefusedDatabase(name);
}
