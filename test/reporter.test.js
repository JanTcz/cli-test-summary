import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import reporter, { createReporter, serialize } from '../src/reporters/node.mjs';
import { tmp } from './helpers.js';

async function drain(gen) {
  for await (const _ of gen);
}

async function* events(list) {
  yield* list;
}

test('serialize: the assertion behind ERR_TEST_FAILURE, or whatever was thrown', () => {
  assert.equal(serialize(null), null);
  const cause = new Error('inner');
  assert.deepEqual(serialize(Object.assign(new Error('wrap'), { code: 'ERR_TEST_FAILURE', cause })), { message: 'inner', stack: cause.stack });
  assert.deepEqual(serialize(Object.assign(new Error('wrap'), { code: 'ERR_TEST_FAILURE', cause: 'a string' })), { message: 'a string', stack: null });
  assert.deepEqual(serialize({ code: 'ERR_TEST_FAILURE' }), { message: '', stack: null });
  assert.deepEqual(serialize({ message: 'm', stack: 42 }), { message: 'm', stack: null });
});

test('the reporter: one line per finished test, with the suites it is in', async (t) => {
  const out = path.join(tmp(t), 'events.jsonl');
  const fail = Object.assign(new Error('wrap'), { code: 'ERR_TEST_FAILURE', cause: new Error('boom') });
  const cancelled = Object.assign(new Error('x'), { code: 'ERR_TEST_FAILURE', failureType: 'cancelledByParent', cause: 'cancelled' });
  await drain(
    createReporter(out)(
      events([
        { type: 'test:start', data: { name: 'suite', nesting: 0, file: '/p/a.js' } },
        { type: 'test:start', data: { name: 'inner', nesting: 1, file: '/p/a.js' } },
        { type: 'test:pass', data: { name: 'inner', nesting: 1, file: '/p/a.js', line: 2 } },
        { type: 'test:fail', data: { name: 'bad', nesting: 1, file: '/p/a.js', line: 3, details: { error: fail } } },
        { type: 'test:fail', data: { name: 'gone', nesting: 1, file: '/p/a.js', line: 4, details: { error: cancelled } } },
        { type: 'test:pass', data: { name: 'skipped', nesting: 1, file: '/p/a.js', skip: true } },
        { type: 'test:pass', data: { name: 'later', nesting: 1, file: '/p/a.js', todo: 'soon' } },
        { type: 'test:pass', data: { name: 'suite', nesting: 0, file: '/p/a.js', details: { type: 'suite' } } },
        { type: 'test:pass', data: { name: 'stdin', nesting: 0 } },
        { type: 'test:pass', data: { name: '/p/b.js', nesting: 0, file: '/p/b.js' } },
        { type: 'test:diagnostic', data: { message: 'tests 1' } },
      ]),
    ),
  );
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.status, [...l.path, l.name].join(' › '), l.suite, l.line]),
    [
      ['passed', 'suite › inner', false, 2],
      ['failed', 'suite › bad', false, 3],
      ['cancelled', 'suite › gone', false, 4],
      ['skipped', 'suite › skipped', false, null],
      ['todo', 'suite › later', false, null],
      ['passed', 'suite', true, null],
      ['passed', 'stdin', false, null],
      ['passed', '/p/b.js', false, null],
    ],
  );
  assert.equal(lines[1].error.message, 'boom');
  assert.equal(lines[0].error, null);
  assert.equal(lines[6].file, null);
  assert.deepEqual(lines.map((l) => l.whole_file), [false, false, false, false, false, false, false, true]);
});

test('without an output file the reporter writes nothing', async () => {
  await drain(createReporter(undefined)(events([{ type: 'test:pass', data: { name: 'x', nesting: 0 } }])));
  assert.equal(typeof reporter, 'function');
});
