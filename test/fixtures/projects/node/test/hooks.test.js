import { before, describe, test } from 'node:test';

describe('db', () => {
  before(() => { throw new Error('cannot connect'); });
  test('reads', () => {});
});

test('later', { todo: true }, () => {});
