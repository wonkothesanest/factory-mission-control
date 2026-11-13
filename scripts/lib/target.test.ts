import { expect, test } from 'bun:test';
import { databaseNameOf, withDatabase } from './target';

test('databaseNameOf reads the database a postgres URL names', () => {
  expect(databaseNameOf('postgresql://u:p@127.0.0.1:55432/archon')).toBe('archon');
  expect(databaseNameOf('postgres://u:p@localhost/check-0a1b2c3d?sslmode=disable')).toBe(
    'check-0a1b2c3d',
  );
});

test('databaseNameOf refuses anything that names no database', () => {
  expect(() => databaseNameOf('not a url')).toThrow('not a connection string');
  expect(() => databaseNameOf('https://example.com/db')).toThrow('not a postgres');
  expect(() => databaseNameOf('postgresql://u:p@localhost:5432/')).toThrow('names no database');
});

test('withDatabase keeps the server and role and swaps the database', () => {
  expect(withDatabase('postgresql://u:p@127.0.0.1:55432/archon', 'check-abc')).toBe(
    'postgresql://u:p@127.0.0.1:55432/check-abc',
  );
});
