import { expect, test } from 'bun:test';
import { panelState } from './LivePanel';

const ASKED = 'status-strip f []';

test('a panel is loading until rows for what it asked arrive', () => {
  expect(panelState('loading', undefined, ASKED)).toBe('loading');
  expect(panelState('ready', undefined, ASKED)).toBe('loading');
  expect(panelState('ready', { asked: ASKED }, ASKED)).toBe('loading');
  expect(panelState('ready', { asked: ASKED, rows: [] }, ASKED)).toBe('ready');
});

test("rows for something else the panel asked before are not this panel's", () => {
  expect(panelState('ready', { asked: 'status-strip g []', rows: [{}] }, ASKED)).toBe('loading');
});

test('a failed query, or a live layer that failed, is an error, rows or not', () => {
  expect(panelState('ready', { asked: ASKED, rows: [{}], failed: true }, ASKED)).toBe('error');
  expect(panelState('error', undefined, ASKED)).toBe('error');
});
