import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './check-env';

export type FactoryEntry = {
  name: string;
  repository: string;
  codebase: string;
  console: string;
  /** Where the factory's published code is browsed (a Bitbucket repository's web address). */
  codeWeb?: string;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntries(env: Env, repoRoot: string): Record<string, unknown>[] {
  const file = env.MC_FACTORIES_FILE || join(repoRoot, 'factories.json');
  const config: unknown = JSON.parse(readFileSync(file, 'utf-8'));
  if (!isObject(config) || !Array.isArray(config.factories)) {
    throw new Error('Invalid factories configuration: expected an object with a factories array');
  }
  return config.factories.map((entry: unknown, index) => {
    if (!isObject(entry)) {
      throw new Error(`Invalid factories configuration: factories[${index}] must be an object`);
    }
    return entry;
  });
}

function stringField(
  entry: Record<string, unknown>,
  field: keyof FactoryEntry,
  index: number,
): string {
  const value = entry[field];
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid factories configuration: factories[${index}].${field} must be a string`,
    );
  }
  return value;
}

export function readFactoryNames(env: Env, repoRoot: string): string[] {
  return readEntries(env, repoRoot).map((entry, index) => stringField(entry, 'name', index));
}

export function readFactories(env: Env, repoRoot: string): FactoryEntry[] {
  return readEntries(env, repoRoot).map((entry, index) => {
    const codeWeb = codeWebField(entry, index);
    return {
      name: stringField(entry, 'name', index),
      repository: stringField(entry, 'repository', index),
      codebase: stringField(entry, 'codebase', index),
      console: stringField(entry, 'console', index),
      ...(codeWeb === undefined ? {} : { codeWeb }),
    };
  });
}

/** The optional `code_web`: an http(s) URL, kept without a trailing `/`. */
function codeWebField(entry: Record<string, unknown>, index: number): string | undefined {
  const value = entry.code_web;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isHttpUrl(value)) {
    throw new Error(
      `Invalid factories configuration: factories[${index}].code_web must be an http(s) URL`,
    );
  }
  return value.replace(/\/+$/, '');
}

export function isHttpUrl(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:');
}
