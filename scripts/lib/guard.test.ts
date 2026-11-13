import { expect, test } from 'bun:test';
import { isCheckDatabase, RefusedDatabase, requireCheckDatabase } from './guard';

test.each(['check-abc', 'check-old', 'check-0a1b2c3d'])('accepts %s', (name) => {
  expect(isCheckDatabase(name)).toBe(true);
  expect(() => requireCheckDatabase(name)).not.toThrow();
});

test.each(['main', 'archon', 'fixture', 'rewind-x', 'check-', 'Check-abc', 'xcheck-a', 'check_a'])(
  'refuses %s',
  (name) => {
    expect(isCheckDatabase(name)).toBe(false);
    expect(() => requireCheckDatabase(name)).toThrow(RefusedDatabase);
  },
);
