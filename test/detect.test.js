import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  NODE_REPORTER,
  RUNNERS,
  detect,
  findProject,
  isSingleCommand,
  nodeRunner,
  packageManager,
  plan,
  projectAt,
  pythonCommand,
} from '../src/detect.js';
import { PROJECTS, tmp } from './helpers.js';

const pkg = (scripts, extra = {}) => ({ name: 'x', scripts, ...extra });

test('packageManager: packageManager field, then the lockfile, else npm', (t) => {
  assert.equal(packageManager(tmp(t), { packageManager: 'pnpm@9.0.0' }), 'pnpm');
  assert.equal(packageManager(tmp(t), { packageManager: 'deno@2' }), 'npm');
  assert.equal(packageManager(tmp(t, { 'pnpm-lock.yaml': '' }), {}), 'pnpm');
  assert.equal(packageManager(tmp(t, { 'yarn.lock': '' }), {}), 'yarn');
  assert.equal(packageManager(tmp(t, { 'bun.lock': '' }), {}), 'bun');
  assert.equal(packageManager(tmp(t, { 'bun.lockb': '' }), {}), 'bun');
  assert.equal(packageManager(tmp(t), {}), 'npm');
});

test('nodeRunner: the test script first, then the dependencies', () => {
  assert.equal(nodeRunner(pkg({ test: 'vitest run' })), 'vitest');
  assert.equal(nodeRunner(pkg({ test: 'jest --coverage' })), 'jest');
  assert.equal(nodeRunner(pkg({ test: 'node --test test/' }, { devDependencies: { vitest: '1' } })), 'node');
  assert.equal(nodeRunner(pkg({ test: 'make test' }, { devDependencies: { vitest: '1' } })), 'vitest');
  assert.equal(nodeRunner(pkg(undefined, { dependencies: { jest: '1' } })), 'jest');
  assert.equal(nodeRunner({}), 'node');
});

test('projectAt: every kind of project, or null', (t) => {
  const node = tmp(t, { 'package.json': pkg({ test: 'vitest run' }), 'pnpm-lock.yaml': '' });
  assert.deepEqual(projectAt(node), { dir: node, runner: 'vitest', manifest: 'package.json', script: 'vitest run', packageManager: 'pnpm' });
  assert.equal(projectAt(tmp(t, { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) })).script, null);
  assert.equal(projectAt(tmp(t, { 'package.json': '{ broken' })).runner, 'node');
  for (const [file, runner] of [['pyproject.toml', 'pytest'], ['pytest.ini', 'pytest'], ['setup.py', 'pytest'], ['setup.cfg', 'pytest'], ['go.mod', 'go'], ['Cargo.toml', 'cargo']]) {
    assert.equal(projectAt(tmp(t, { [file]: '' })).runner, runner, file);
  }
  assert.deepEqual(projectAt(tmp(t, { 'App.sln': '', 'a/A.csproj': '' })).manifest, 'App.sln');
  assert.deepEqual(projectAt(tmp(t, { 'A.Tests.fsproj': '' })).manifest, 'A.Tests.fsproj');
  assert.equal(projectAt(tmp(t, { 'README.md': '' })), null);
  assert.equal(projectAt('/does/not/exist'), null);
});

test('findProject: up to the nearest project, not past the repository', (t) => {
  const dir = tmp(t, { 'go.mod': 'module m', 'pkg/deep/x.go': '' });
  assert.equal(findProject(path.join(dir, 'pkg', 'deep')).dir, dir);
  const repo = tmp(t, { '.git/HEAD': '', 'src/a.txt': '' });
  // The repository root stops the walk up; nothing below either.
  assert.equal(findProject(path.join(repo, 'src')), null);
});

test('findProject: down into a folder that only holds projects', (t) => {
  const mono = tmp(t, { '.git/HEAD': '', 'services/api/go.mod': '', 'web/package.json': pkg({ test: 'jest' }), 'node_modules/x/package.json': '{}', '.hidden/Cargo.toml': '' });
  assert.equal(findProject(mono).dir, path.join(mono, 'web'));
  const deep = tmp(t, { '.git/HEAD': '', 'a/b/c/d/go.mod': '' });
  assert.equal(findProject(deep), null);
  assert.equal(findProject(deep, { maxDepth: 4 }).runner, 'go');
  // Up to the filesystem root with nothing found.
  assert.equal(findProject(tmp(t)), null);
});

test('isSingleCommand and pythonCommand', (t) => {
  assert.equal(isSingleCommand('vitest run --coverage'), true);
  for (const s of ['a && b', 'a || b', 'a; b', 'a | b', 'a & b', 'a > f', 'a `b`', 'a $(b)']) assert.equal(isSingleCommand(s), false, s);
  assert.deepEqual(pythonCommand(tmp(t, { 'uv.lock': '' })), ['uv', 'run', 'pytest']);
  assert.deepEqual(pythonCommand(tmp(t, { 'poetry.lock': '' })), ['poetry', 'run', 'pytest']);
  const venv = tmp(t, { '.venv/bin/python': '' });
  assert.deepEqual(pythonCommand(venv), [path.join(venv, '.venv', 'bin', 'python'), '-m', 'pytest']);
  assert.deepEqual(pythonCommand(tmp(t), 'linux'), ['python3', '-m', 'pytest']);
  assert.deepEqual(pythonCommand(tmp(t), 'win32'), ['python', '-m', 'pytest']);
  assert.ok(fs.existsSync(NODE_REPORTER));
  assert.deepEqual(RUNNERS, ['node', 'vitest', 'jest', 'pytest', 'go', 'cargo', 'dotnet']);
});

const R = '/r';
const project = (runner, extra = {}) => ({ dir: '/p', runner, manifest: 'package.json', script: null, packageManager: 'npm', ...extra });

test('plan: the project\'s test script, with report flags only when it is one command', () => {
  const v = plan(project('vitest', { script: 'vitest run' }), { reportDir: R });
  assert.deepEqual(v.command, ['npm', 'test', '--', '--reporter=default', '--reporter=json', '--outputFile.json=/r/vitest.json']);
  assert.deepEqual(v.shown, ['npm', 'test']);
  assert.deepEqual([v.mode, v.report.format, v.cwd, v.manifest], ['script', 'jest-json', '/p', 'package.json']);
  const j = plan(project('jest', { script: 'jest', packageManager: 'yarn' }), { reportDir: R });
  assert.deepEqual(j.command, ['yarn', 'test', '--json', '--outputFile=/r/jest.json']);
  assert.deepEqual(plan(project('jest', { script: 'jest', packageManager: 'bun' }), { reportDir: R }).shown, ['bun', 'run', 'test']);
  for (const runner of ['vitest', 'jest']) {
    const complex = plan(project(runner, { script: `tsc && ${runner}` }), { reportDir: R });
    assert.deepEqual([complex.command, complex.report], [['npm', 'test'], null], runner);
  }
});

test('plan: node:test reports through NODE_OPTIONS, whatever the script does', () => {
  const n = plan(project('node', { script: 'npm run build && node --test' }), { reportDir: R, env: { NODE_OPTIONS: '--max-old-space-size=4096' } });
  assert.deepEqual(n.command, ['npm', 'test']);
  assert.equal(n.report.path, '/r/node-events.jsonl');
  assert.match(n.env.NODE_OPTIONS, /^--max-old-space-size=4096 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=".+node\.mjs" --test-reporter-destination=stderr$/);
  assert.equal(n.env.CLI_TEST_SUMMARY_NODE_OUT, '/r/node-events.jsonl');
  assert.equal(plan(project('node', { script: 'node --test' }), { reportDir: R }).env.NODE_OPTIONS.startsWith('--test-reporter=spec'), true);
  const own = plan(project('node', { script: 'node --test --test-reporter=dot' }), { reportDir: R });
  assert.deepEqual([own.report, own.env], [null, {}]);
});

test('plan: the runner directly, without a script or with a filter', () => {
  const v = plan(project('vitest'), { reportDir: R, filter: 'adds' });
  assert.deepEqual(v.shown, ['npx', 'vitest', 'run', '-t', 'adds']);
  assert.equal(v.command.includes('--outputFile.json=/r/vitest.json'), true);
  assert.deepEqual(plan(project('vitest', { script: 'vitest' }), { reportDir: R, filter: 'x' }).mode, 'direct');
  assert.deepEqual(plan(project('vitest'), { reportDir: R }).shown, ['npx', 'vitest', 'run']);
  assert.deepEqual(plan(project('jest'), { reportDir: R, filter: 'a' }).shown, ['npx', 'jest', '--ci', '-t', 'a']);
  assert.deepEqual(plan(project('jest'), { reportDir: R }).shown, ['npx', 'jest', '--ci']);
  assert.deepEqual(plan(project('node'), { reportDir: R, filter: 'x' }).command, [process.execPath, '--test', '--test-name-pattern=x']);
  assert.deepEqual(plan(project('node'), { reportDir: R }).command, [process.execPath, '--test']);
});

test('plan: pytest, go, cargo, dotnet', (t) => {
  const py = plan({ dir: tmp(t, { 'uv.lock': '' }), runner: 'pytest', manifest: 'pyproject.toml' }, { reportDir: R, filter: 'adds', env: { PYTEST_ADDOPTS: '-x' } });
  assert.deepEqual(py.command, ['uv', 'run', 'pytest', '-k', 'adds']);
  assert.equal(py.env.PYTEST_ADDOPTS, '-x --junitxml="/r/junit.xml"');
  assert.deepEqual(plan({ dir: tmp(t), runner: 'pytest' }, { reportDir: R }).env.PYTEST_ADDOPTS, '--junitxml="/r/junit.xml"');
  const go = plan({ dir: '/p', runner: 'go' }, { reportDir: R, filter: 'TestA' });
  assert.deepEqual([go.command, go.report, go.manifest], [['go', 'test', '-json', './...', '-run', 'TestA'], { format: 'go-json', path: null }, null]);
  assert.deepEqual(plan({ dir: '/p', runner: 'go' }, { reportDir: R }).command, ['go', 'test', '-json', './...']);
  assert.deepEqual(plan({ dir: '/p', runner: 'cargo' }, { reportDir: R, filter: 'adds' }).command, ['cargo', 'test', 'adds']);
  assert.deepEqual(plan({ dir: '/p', runner: 'cargo' }, { reportDir: R }).report, null);
  const dn = plan({ dir: '/p', runner: 'dotnet', manifest: 'App.sln' }, { reportDir: R, filter: 'Name~Math' });
  assert.deepEqual(dn.command, ['dotnet', 'test', 'App.sln', '--logger', 'trx', '--results-directory', '/r/trx', '--filter', 'Name~Math']);
  assert.deepEqual(dn.shown, ['dotnet', 'test', 'App.sln', '--filter', 'Name~Math']);
  assert.deepEqual(plan({ dir: '/p', runner: 'dotnet' }, { reportDir: R }).shown, ['dotnet', 'test']);
  assert.equal(plan({ dir: '/p', runner: null }, { reportDir: R }), null);
});

test('plan: a command of your own runs as is, with the reports that need no flags', () => {
  const node = plan(project('node'), { reportDir: R, command: ['make', 'test'] });
  assert.deepEqual([node.command, node.mode, node.report.format], [['make', 'test'], 'command', 'node-events']);
  assert.equal(plan({ dir: '/p', runner: 'pytest' }, { reportDir: R, command: ['tox'] }).report.format, 'junit');
  const other = plan({ dir: '/p', runner: null }, { reportDir: R, command: ['./test.sh'] });
  assert.deepEqual([other.report, other.env, other.runner], [null, {}, null]);
  assert.equal(plan(project('node'), { reportDir: R, runner: 'go', command: ['x'] }).runner, 'go');
});

test('detect: what would run', (t) => {
  assert.deepEqual(detect(path.join(PROJECTS, 'vitest', 'test')), { op: 'detect', detected: true, runner: 'vitest', cwd: '..', command: 'npm test', mode: 'script', report: 'jest-json' });
  assert.equal(detect(path.join(PROJECTS, 'cargo')).report, 'text');
  const nodeOnly = tmp(t, { 'package.json': pkg(undefined) });
  assert.equal(detect(nodeOnly).command, 'node --test');
  const none = detect(tmp(t));
  assert.equal(none.detected, false);
  assert.match(none.reason, /^no test runner found in or around /);
});
