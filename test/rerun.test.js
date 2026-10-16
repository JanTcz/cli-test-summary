import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { classify, isolate, rerunFailures } from '../src/rerun.js';
import { runTests } from '../src/run.js';
import { PROJECTS, tmp } from './helpers.js';

const ctx = { cwd: '/p', manifest: 'App.sln', reportDir: '/r' };

test('isolate: one test, for every runner', (t) => {
  const node = isolate('node', { file: 'test/a.test.js', name: 'adds (x)' }, ctx);
  assert.deepEqual(node.command, [process.execPath, '--test', '--test-name-pattern=adds \\(x\\)', 'test/a.test.js']);
  assert.equal(node.report.path, '/r/node-events.jsonl');
  assert.match(node.env.NODE_OPTIONS, /--test-reporter=".+node\.mjs"/);
  assert.deepEqual(isolate('node', { file: 'test/a.test.js', name: null }, ctx).command.slice(1), ['--test', 'test/a.test.js']);
  assert.equal(isolate('node', { file: null, name: 'x' }, ctx), null);
  assert.deepEqual(isolate('vitest', { file: 'a.test.js', name: 'math adds' }, ctx).command.slice(0, 7), ['npx', '--no-install', 'vitest', 'run', 'a.test.js', '-t', '^math adds$']);
  assert.deepEqual(isolate('vitest', { file: 'a.test.js', name: null }, ctx).command.slice(4, 6), ['a.test.js', '--reporter=json']);
  assert.deepEqual(isolate('jest', { file: 'a.test.js', name: 'm a' }, ctx).command.slice(0, 7), ['npx', '--no-install', 'jest', '--ci', 'a.test.js', '-t', '^m a$']);
  assert.deepEqual(isolate('jest', { file: 'a.test.js', name: null }, ctx).command.slice(4, 6), ['a.test.js', '--json']);
  const py = isolate('pytest', 'tests/test_a.py::test_x', { ...ctx, cwd: tmp(t) });
  assert.deepEqual(py.command.slice(-1), ['tests/test_a.py::test_x']);
  assert.equal(py.env.PYTEST_ADDOPTS, '--junitxml="/r/junit.xml"');
  assert.deepEqual(isolate('go', { package: 'm/p', test: 'TestA/sub.case' }, ctx).command, ['go', 'test', '-json', '-count=1', '-run', '^TestA$/^sub\\.case$', 'm/p']);
  assert.equal(isolate('go', { package: 'm/p', test: null }, ctx), null);
  assert.equal(isolate('go', { package: null, test: 'TestA' }, ctx), null);
  assert.deepEqual(isolate('cargo', 'math::adds', ctx).command, ['cargo', 'test', 'math::adds', '--', '--exact']);
  assert.deepEqual(isolate('dotnet', 'MathTests.Adds', ctx).command.slice(0, 5), ['dotnet', 'test', 'App.sln', '--filter', 'FullyQualifiedName=MathTests.Adds']);
  assert.deepEqual(isolate('dotnet', 'M.A', { ...ctx, manifest: null }).command.slice(0, 3), ['dotnet', 'test', '--filter']);
  assert.equal(isolate('cargo', null, ctx), null);
  assert.equal(isolate('nope', 'x', ctx), null);
});

test('classify: real, flaky, unresolved', () => {
  const f = { name: 'a' };
  const alone = (exitCode, passed, failures = []) => ({ exitCode, counts: { passed }, failures });
  assert.deepEqual(classify(f, null), { verdict: 'unresolved', reason: 'the runner cannot run this one alone' });
  assert.deepEqual(classify(f, alone(1, 0, [{ name: 'a' }])), { verdict: 'real', reason: null });
  assert.deepEqual(classify(f, alone(0, 1)), { verdict: 'flaky', reason: null });
  assert.deepEqual(classify(f, alone(1, 0, [{ name: 'b' }])), { verdict: 'unresolved', reason: 'the run alone failed differently' });
  assert.deepEqual(classify(f, alone(0, 0)), { verdict: 'unresolved', reason: 'the run alone did not run it' });
  assert.deepEqual(classify(f, alone(1, 1)), { verdict: 'unresolved', reason: 'the run alone did not run it' });
});

test('rerunFailures: a test that fails only after another one is flaky, a broken one real', async () => {
  const r = await rerunFailures(await runTests({ cwd: path.join(PROJECTS, 'node-flaky') }));
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.rerun, { real: 1, flaky: 1, unresolved: 0, not_rerun: 0 });
  assert.deepEqual(r.failures.map((f) => [f.name, f.rerun]), [['reads a clean cache', 'flaky'], ['really broken', 'real']]);
});

test('rerunFailures: only flaky failures make the verdict flaky', async () => {
  const run = await runTests({ cwd: path.join(PROJECTS, 'node-flaky') });
  // `plan` (how it ran) is not enumerable, so a copy of the result passes it on by hand.
  const r = await rerunFailures({ ...run, plan: run.plan, failures: run.failures.slice(0, 1) });
  assert.equal(r.verdict, 'flaky');
  // A note (here: a timeout) means something else failed the run too.
  assert.equal((await rerunFailures({ ...run, plan: run.plan, failures: run.failures.slice(0, 1), note: 'timed out' })).verdict, 'fail');
});

test('rerunFailures: the limit, failures that cannot be singled out, passing and undetected runs', async () => {
  const run = await runTests({ cwd: path.join(PROJECTS, 'node-flaky') });
  const limited = await rerunFailures(run, { maxReruns: 0 });
  assert.deepEqual(limited.rerun, { real: 0, flaky: 0, unresolved: 0, not_rerun: 2 });
  assert.deepEqual(limited.failures.map((f) => f.rerun), [null, null]);
  const noId = await rerunFailures({ ...run, plan: run.plan, failures: [{ name: 'x', id: null }] });
  assert.deepEqual(noId.failures[0], { name: 'x', id: null, rerun: 'unresolved', rerun_reason: 'the runner cannot run this one alone' });
  assert.equal((await rerunFailures({ detected: true, ok: true })).verdict, 'pass');
  assert.equal((await rerunFailures({ detected: false, ok: null })).verdict, 'fail');
});
