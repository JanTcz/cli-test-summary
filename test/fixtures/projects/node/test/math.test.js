import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('math', () => {
  test('adds', () => assert.equal(1 + 1, 2));
  test('subtracts', () => assert.equal(3 - 1, 1));
  test('divides', { skip: 'not yet' }, () => {});
});
