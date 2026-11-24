import { describe, expect, test } from 'bun:test';
import { localRequestRefusal } from './serve';

const req = (host: string, init: { method?: string; origin?: string } = {}) =>
  new Request(`http://${host}/api/manager/briefing`, {
    method: init.method ?? 'GET',
    headers: { host, ...(init.origin ? { origin: init.origin } : {}) },
  });

describe('localRequestRefusal (local-only request gate)', () => {
  test('loopback hosts on the own port are served', () => {
    expect(localRequestRefusal(req('127.0.0.1:3092'), 3092)).toBeNull();
    expect(localRequestRefusal(req('localhost:3092'), 3092)).toBeNull();
    expect(localRequestRefusal(req('[::1]:3092'), 3092)).toBeNull();
  });
  test('a rebinding host or another port is refused', () => {
    expect(localRequestRefusal(req('evil.example:3092'), 3092)).toBe('host not allowed');
    expect(localRequestRefusal(req('127.0.0.1:3090'), 3092)).toBe('host not allowed');
  });
  test('cross-origin state changes are refused; same-origin and origin-less ones pass', () => {
    expect(
      localRequestRefusal(
        req('127.0.0.1:3092', { method: 'POST', origin: 'http://evil.example' }),
        3092,
      ),
    ).toBe('origin not allowed');
    expect(
      localRequestRefusal(req('127.0.0.1:3092', { method: 'POST', origin: 'null' }), 3092),
    ).toBe('origin not allowed');
    expect(
      localRequestRefusal(
        req('127.0.0.1:3092', { method: 'POST', origin: 'http://127.0.0.1:3092' }),
        3092,
      ),
    ).toBeNull();
    expect(localRequestRefusal(req('127.0.0.1:3092', { method: 'POST' }), 3092)).toBeNull();
  });
});
