import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SetupError, childEnv, exec, explain, plainOutput, readReport, runTests, tail } from '../src/run.js';
import { PROJECTS, fakeRunner, output, sink, tmp } from './helpers.js';

test('exec: output, exit code, tee', async (t) => {
  const dir = tmp(t);
  const tee = sink();
  const r = await exec(fakeRunner(dir, { stdout: 'out', stderr: 'err', code: 3 }), { cwd: dir, env: process.env, tee });
  assert.deepEqual([r.code, r.stdout, r.stderr, r.timedOut], [3, 'out', 'err', false]);
  assert.equal(tee.text, 'outerr');
  assert.ok(r.durationMs >= 0);
  assert.equal((await exec(fakeRunner(dir, { stdout: 'x' }), { cwd: dir, env: process.env })).stdout, 'x');
});

test('exec: a timeout stops the run', async (t) => {
  const dir = tmp(t);
  const r = await exec(fakeRunner(dir, { sleep: 5000 }), { cwd: dir, env: process.env, timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.equal(r.signal, 'SIGTERM');
});

test('exec: a run that ignores SIGTERM gets SIGKILL', async (t) => {
  const dir = tmp(t);
  const script = path.join(dir, 'stubborn.mjs');
  fs.writeFileSync(script, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000);");
  const r = await exec([process.execPath, script], { cwd: dir, env: process.env, timeoutMs: 100, killAfterMs: 100 });
  assert.deepEqual([r.timedOut, r.signal], [true, 'SIGKILL']);
});

test('exec: a missing command is a setup error, other spawn errors are not', async (t) => {
  const dir = tmp(t, { 'not-executable': '' });
  await assert.rejects(exec(['definitely-not-a-command-xyz'], { cwd: dir, env: process.env }), (e) => e instanceof SetupError && /not installed or not on PATH/.test(e.message));
  await assert.rejects(exec([path.join(dir, 'not-executable')], { cwd: dir, env: process.env }), (e) => !(e instanceof SetupError) && e.code === 'EACCES');
});

test('readReport: none, go stdout, a file, a folder of TRX files, missing', (t) => {
  const dir = tmp(t, { 'r.json': '{"a":1}', 'trx/b.trx': 'B', 'trx/a.trx': 'A', 'trx/notes.txt': 'x' });
  assert.equal(readReport(null, 'x'), null);
  assert.deepEqual(readReport({ format: 'go-json', path: null }, 'events'), { format: 'go-json', content: 'events' });
  assert.deepEqual(readReport({ format: 'jest-json', path: path.join(dir, 'r.json') }, ''), { format: 'jest-json', content: '{"a":1}' });
  assert.deepEqual(readReport({ format: 'trx', path: path.join(dir, 'trx') }, ''), { format: 'trx', content: ['A', 'B'] });
  assert.equal(readReport({ format: 'junit', path: path.join(dir, 'missing.xml') }, ''), null);
});

test('childEnv: ours on top, colors off, no NODE_TEST_CONTEXT', () => {
  assert.deepEqual(childEnv({ A: '1', B: '1', NODE_TEST_CONTEXT: 'child-v8' }, { B: '2' }), { A: '1', B: '2', NO_COLOR: '1', FORCE_COLOR: '0' });
  assert.deepEqual(childEnv({}), { NO_COLOR: '1', FORCE_COLOR: '0' });
});

test('plainOutput and tail', () => {
  assert.equal(plainOutput('go-json', '{"Output":"a\\n"}\n{"Action":"pass"}\nnot json\n\n', 'err'), 'a\nnot json\n\nerr');
  assert.equal(plainOutput(null, '\x1b[1mx\x1b[0m', ''), 'x');
  assert.equal(tail('1\n2\n3\n\n', 2), '2\n3');
  assert.equal(tail(Array.from({ length: 100 }, (_, i) => i).join('\n')).split('\n').length, 60);
});

test('explain: what the numbers alone would hide', () => {
  const c = (total) => ({ total });
  assert.match(explain({ exitCode: 1, timedOut: true, timeoutMs: 3000, counts: c(1), failures: [] }), /^timed out after 3 s/);
  assert.match(explain({ exitCode: 1, timedOut: false, counts: c(5), failures: [] }), /^the command failed \(exit 1\) but no test failed/);
  assert.match(explain({ exitCode: 0, timedOut: false, counts: c(5), failures: [{}] }), /succeeded but reported failing tests/);
  assert.equal(explain({ exitCode: 0, timedOut: false, counts: c(0), failures: [] }), 'no tests ran');
  assert.match(explain({ exitCode: 0, timedOut: false, counts: c(null), failures: [], source: 'none' }), /could not be read/);
  assert.equal(explain({ exitCode: 0, timedOut: false, counts: c(3), failures: [], source: 'text' }), null);
});

test('runTests: a real node:test project, through npm test', async () => {
  const r = await runTests({ cwd: path.join(PROJECTS, 'node') });
  assert.equal(r.detected, true);
  assert.equal(r.ok, false);
  assert.deepEqual([r.runner, r.command, r.cwd, r.exit_code, r.source], ['node', 'npm test', '.', 1, 'node-events']);
  assert.deepEqual(r.counts, { total: 5, passed: 1, failed: 1, skipped: 1, todo: 1, cancelled: 1 });
  assert.deepEqual(r.failures.map((f) => f.name), ['db', 'math › subtracts']);
  assert.match(r.failures[1].message, /at TestContext.<anonymous> \(test\/math.test.js:6:34\)/);
  assert.equal(JSON.parse(JSON.stringify(r)).failures[0].id, undefined, 'id stays out of the output');
  assert.deepEqual(r.failures[0].id, { file: 'test/hooks.test.js', name: 'db' });
  assert.equal(r.note, null);
  assert.match(r.output_tail, /ℹ fail 1/);
  assert.equal(r.plan.runner, 'node');
});

test('runTests: nothing to run', async (t) => {
  const r = await runTests({ cwd: tmp(t) });
  assert.equal(r.detected, false);
  assert.equal(r.ok, null);
  assert.match(r.reason, /^no test runner found/);
});

test('runTests: a command of your own, where no project is recognized', async (t) => {
  const dir = tmp(t);
  const r = await runTests({ cwd: dir, command: fakeRunner(dir, { stdout: 'all good' }) });
  assert.equal(r.ok, true);
  assert.equal(r.runner, null);
  assert.equal(r.source, 'none');
  assert.match(r.note, /could not be read/);
  assert.equal(r.output_tail, undefined);
  assert.match(r.command, /^node .+fake-.+\.mjs$/);
});

test('runTests: a failing command with no failing test says why', async (t) => {
  const dir = tmp(t, { 'Cargo.toml': '' });
  const r = await runTests({ cwd: dir, command: fakeRunner(dir, { stdout: output('cargo.txt').replace(/test math::subtracts \.\.\. FAILED/, 'test math::subtracts ... ok').replace(/---- math::subtracts stdout ----[\s\S]*/, 'error: coverage below 80%'), code: 1 }) });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 0);
  assert.deepEqual(r.counts, { total: 3, passed: 2, failed: 0, skipped: 1, todo: 0, cancelled: 0 });
  assert.match(r.note, /no test failed/);
  assert.match(r.output_tail, /coverage below 80%/);
});

test('runTests: exit code 0 with failures is a failure; a timeout too; quoting in the shown command', async (t) => {
  const dir = tmp(t, { 'Cargo.toml': '' });
  const masked = await runTests({ cwd: dir, command: fakeRunner(dir, { stdout: output('cargo.txt'), code: 0 }) });
  assert.equal(masked.ok, false);
  assert.match(masked.note, /succeeded but reported failing tests/);
  const slow = await runTests({ cwd: dir, command: fakeRunner(dir, { sleep: 5000 }), timeoutMs: 50 });
  assert.deepEqual([slow.ok, slow.exit_code], [false, null]);
  assert.match(slow.note, /^timed out after 0 s/);
  const quoted = await runTests({ cwd: dir, runner: 'cargo', command: [process.execPath, '-e', 'console.log("test a ... ok")'] });
  assert.equal(quoted.command, 'node -e "console.log(\\"test a ... ok\\")"');
  assert.deepEqual(quoted.counts.passed, 1);
});

test('runTests: an unknown runner, a given project', async (t) => {
  const dir = tmp(t);
  await assert.rejects(runTests({ cwd: dir, runner: 'nope', project: { dir, runner: 'nope' } }), /unknown runner "nope"/);
  const r = await runTests({ cwd: dir, project: { dir, runner: 'cargo' }, command: fakeRunner(dir, { stdout: 'test a ... ok\n' }) });
  assert.equal(r.counts.passed, 1);
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('cli-test-summary-')));
});
