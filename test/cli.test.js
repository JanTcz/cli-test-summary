import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { USAGE, UsageError, VERSION, exitCode, formatText, main, parseArgs } from '../src/cli.js';
import { PROJECTS, sink, tmp } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/cli-test-summary.js', import.meta.url));

async function cli(args, { cwd = PROJECTS, tty = false, env = process.env, stdin } = {}) {
  const stdout = sink(tty);
  const stderr = sink();
  const code = await main(args, { stdout, stderr, cwd, env, stdin });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

test('parseArgs: flags, values, booleans, -h, and a command after --', () => {
  assert.deepEqual(parseArgs(['run', '--cwd=a', '--filter', 'x y', '--rerun', '-h', '--', 'make', 'test']), {
    flags: { cwd: 'a', filter: 'x y', rerun: true, help: true },
    positional: ['run'],
    command: ['make', 'test'],
  });
  assert.deepEqual(parseArgs([]), { flags: {}, positional: [], command: null });
  assert.throws(() => parseArgs(['--filter']), UsageError);
  assert.throws(() => parseArgs(['--']), /nothing after --/);
});

test('formatText: passing, failing, flaky, odd counts, detect', () => {
  const base = { detected: true, runner: 'vitest', command: 'npm test', duration_ms: 1234, failures: [], note: null };
  assert.equal(formatText({ ...base, ok: true, counts: { passed: 3, failed: 0, skipped: 0, todo: 0, cancelled: 0 } }), '✔ 3 passed   vitest · npm test · 1.2 s');
  const failing = formatText({
    ...base,
    ok: false,
    counts: { passed: 1, failed: 2, skipped: 1, todo: 1, cancelled: 1 },
    failures: [
      { name: 'a › b', file: 'a.test.js', line: 3, message: 'Error: one\n\n2\n3\n4\n5', rerun: 'real' },
      { name: 'c', file: 'c.test.js', line: null, message: '' },
      { name: 'build', file: null, line: null, message: 'x' },
    ],
    note: 'something',
  });
  assert.equal(
    failing,
    [
      '✖ 2 failed · 1 passed · 1 skipped · 1 todo · 1 cancelled   vitest · npm test · 1.2 s',
      '  ✖ a › b  a.test.js:3  [real]',
      '      Error: one',
      '      2',
      '      3',
      '      4',
      '  ✖ c  c.test.js',
      '  ✖ build',
      '      x',
      'note: something',
    ].join('\n'),
  );
  assert.equal(formatText({ ...base, ok: false, verdict: 'flaky', counts: { passed: 1, failed: 1 }, failures: [] }).split('\n')[0], '≈ 1 failed · 1 passed   vitest · npm test · 1.2 s');
  const unknown = formatText({ ...base, ok: false, counts: { passed: null, failed: null }, note: 'n', output_tail: 'tail' });
  assert.equal(unknown, '✖ failed   vitest · npm test · 1.2 s\nnote: n\n\ntail');
  assert.equal(formatText({ ...base, ok: true, counts: { passed: null } }).split('\n')[0], '✔ passed   vitest · npm test · 1.2 s');
  assert.equal(formatText({ detected: false, reason: 'r' }), 'nothing to run: r');
  assert.equal(formatText({ op: 'detect', detected: false, reason: 'r' }), 'nothing to run: r');
  assert.equal(formatText({ op: 'detect', detected: true, runner: 'go', cwd: '.', command: 'go test -json ./...', mode: 'direct' }), 'go in .: go test -json ./...');
  assert.equal(formatText({ op: 'detect', detected: true, runner: 'jest', cwd: 'web', command: 'npm test', mode: 'script' }), "jest in web: npm test (the project's test script)");
});

test('exitCode: 0 passed or only flaky, 1 failed, 2 nothing to run', () => {
  assert.equal(exitCode({ detected: true, ok: true }), 0);
  assert.equal(exitCode({ detected: true, ok: false, verdict: 'flaky' }), 0);
  assert.equal(exitCode({ detected: true, ok: false }), 1);
  assert.equal(exitCode({ detected: false }), 2);
});

test('--help, help, --version', async () => {
  assert.equal((await cli(['--help'])).out, USAGE);
  assert.equal((await cli(['help'])).out, USAGE);
  assert.equal((await cli(['--version'])).out, `${VERSION}\n`);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('run: JSON on a pipe, text on a terminal, --stream', async () => {
  const pipe = await cli(['--cwd', 'node']);
  assert.equal(pipe.code, 1);
  assert.deepEqual(pipe.json().counts, { total: 5, passed: 1, failed: 1, skipped: 1, todo: 1, cancelled: 1 });
  const text = await cli(['run', '--cwd=node', '--stream'], { tty: true });
  assert.match(text.out, /^✖ 1 failed · 1 passed · 1 skipped · 1 todo · 1 cancelled {3}node · npm test/);
  assert.match(text.err, /ℹ tests 5/);
  assert.equal((await cli(['--cwd=node', '--json'], { tty: true })).json().runner, 'node');
  assert.match((await cli(['--cwd=node', '--text'])).out, /^✖ /);
});

test('run: --rerun, --filter, --runner, --timeout, a command after --', async () => {
  const rerun = await cli(['--cwd=node-flaky', '--rerun', '--max-reruns=5', '--timeout=60']);
  assert.deepEqual(rerun.json().rerun, { real: 1, flaky: 1, unresolved: 0, not_rerun: 0 });
  assert.equal(rerun.code, 1);
  // Node 20 reports the tests a filter leaves out as skipped, later versions not at all.
  const filtered = await cli(['--cwd=node-flaky', '--filter=fills the cache']);
  const { command, counts } = filtered.json();
  assert.deepEqual([filtered.code, command, counts.passed, counts.failed], [0, 'node --test "--test-name-pattern=fills the cache"', 1, 0]);
  const own = await cli(['--cwd=node', '--runner=node', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(own.json().ok, true);
});

test('detect: JSON or text, exit 2 when nothing is found', async (t) => {
  assert.deepEqual((await cli(['detect', '--cwd=jest'])).json(), { op: 'detect', detected: true, runner: 'jest', cwd: '.', command: 'npm test', mode: 'script', report: 'jest-json' });
  assert.equal((await cli(['detect', '--cwd=go'], { tty: true })).out, 'go in .: go test -json ./...\n');
  const none = await cli(['detect'], { cwd: tmp(t) });
  assert.deepEqual([none.code, none.json().detected], [2, false]);
  const run = await cli([], { cwd: tmp(t) });
  assert.deepEqual([run.code, run.json().detected], [2, false]);
});

test('errors: bad arguments and setup errors exit 2, others are thrown', async (t) => {
  for (const args of [['frobnicate'], ['run', 'extra'], ['--runner=mocha'], ['--timeout=soon'], ['--max-reruns=-1'], ['--filter']]) {
    const r = await cli(args, { cwd: path.join(PROJECTS, 'node') });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /^cli-test-summary: /);
  }
  const missing = await cli(['--', 'definitely-not-a-command-xyz'], { cwd: tmp(t) });
  assert.deepEqual([missing.code, missing.err], [2, 'cli-test-summary: definitely-not-a-command-xyz is not installed or not on PATH\n']);
  const dir = tmp(t, { 'run.sh': '' });
  await assert.rejects(cli(['--', path.join(dir, 'run.sh')], { cwd: dir }), /EACCES/);
});

test('mcp: serves on stdin and stdout', async () => {
  const stdin = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']);
  const r = await cli(['mcp'], { stdin });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json().result.tools.map((t) => t.name), ['run_tests', 'detect_tests']);
});

test('defaults to the process', async () => {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = (s) => ((out += s), true);
  try {
    assert.equal(await main(['--version']), 0);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(out, `${VERSION}\n`);
});

test('the bin runs the CLI and sets the exit code', () => {
  const r = spawnSync(process.execPath, [BIN, 'detect', '--cwd', path.join(PROJECTS, 'pytest')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).runner, 'pytest');
  assert.equal(spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8' }).status, 2);
});
