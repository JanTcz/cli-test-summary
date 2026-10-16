// "reads a clean cache" fails only after "fills the cache": a flaky test, by order.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const cache = new Map();

test('fills the cache', () => {
  cache.set('user', 'jan');
});

test('reads a clean cache', () => {
  assert.equal(cache.size, 0);
});

test('really broken', () => {
  assert.equal(1, 2);
});
