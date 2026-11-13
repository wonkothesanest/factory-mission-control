/** How many parameters `sql` takes: its highest `$n`. */
export function parameterCount(sql: string): number {
  return Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
}

/**
 * The parameters for a live query: the factory, then `args` (absent means none), which must be
 * strings and exactly the query's parameters after `$1`. Undefined when `args` do not fit.
 */
export function liveParams(sql: string, factory: string, args: unknown = []): string[] | undefined {
  if (
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string') ||
    args.length !== parameterCount(sql) - 1
  ) {
    return undefined;
  }
  return [factory, ...args];
}
