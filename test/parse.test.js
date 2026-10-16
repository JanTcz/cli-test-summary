import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  emptyCounts,
  parseCargoText,
  parseDotnetText,
  parseGoJson,
  parseGoText,
  parseJestJson,
  parseJestText,
  parseJunit,
  parseNodeEvents,
  parseNodeText,
  parsePytestText,
  parseTrx,
  parseVitestText,
  pytestNodeId,
  relPath,
  stripAnsi,
  summarize,
  trimStack,
} from '../src/parse.js';
import { attributes, decode, elements, first, text } from '../src/xml.js';
import { PROJECTS, output, tmp } from './helpers.js';

const counts = (total, passed, failed, skipped, todo = 0, cancelled = 0) => ({ total, passed, failed, skipped, todo, cancelled });
const brief = ({ failures }) => failures.map((f) => [f.name, f.file, f.line]);

test('xml: entities, attributes, elements, CDATA', () => {
  assert.equal(decode('&lt;a&gt; &amp; &quot;&apos; &#65;&#x42; &nope;'), '<a> & "\' AB &nope;');
  assert.deepEqual(attributes(` a="1" b='2' c = "&lt;" `), { a: '1', b: '2', c: '<' });
  const xml = '<r><t x="1"/><t x="2">in<b>side</b></t><tt/></r>';
  assert.deepEqual(elements(xml, 't'), [{ attrs: { x: '1' }, body: null }, { attrs: { x: '2' }, body: 'in<b>side</b>' }]);
  assert.equal(first(xml, 'u'), null);
  assert.equal(first(null, 't'), null);
  assert.equal(first('<t>x</t>', 't').body, 'x');
  assert.equal(text('a &lt; <![CDATA[<raw> &amp;]]><i>b</i>'), 'a < <raw> &amp;b');
  assert.equal(text(null), '');
});

test('helpers: ansi, paths, stacks', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(relPath(null, '/p'), null);
  assert.equal(relPath('/p/a/b.js', '/p'), 'a/b.js');
  assert.equal(relPath('file:///p/a.js', '/p'), 'a.js');
  assert.equal(relPath('/elsewhere/a.js', '/p'), '/elsewhere/a.js');
  assert.equal(relPath('/p', '/p'), '/p');
  assert.equal(relPath('a/b.js', '/p'), 'a/b.js');
  assert.equal(
    trimStack('Error: x\n    at t (/p/a.js:1:2)\n    at f (/p/node_modules/x.js:1:1)\n    at node:internal/y\n    at new Promise (<anonymous>)\n    at async Promise.all (index 0)\n   at System.Reflection.Invoke()'),
    'Error: x\n    at t (/p/a.js:1:2)',
  );
  assert.deepEqual(emptyCounts(), counts(0, 0, 0, 0));
});

test('node:test events: counts, suites with failing hooks, cancelled tests', () => {
  const r = parseNodeEvents(output('node.jsonl'), '/work/node');
  assert.deepEqual(r.counts, counts(5, 1, 1, 1, 1, 1));
  assert.deepEqual(brief(r), [['db', 'test/hooks.test.js', 3], ['math › subtracts', 'test/math.test.js', 6]]);
  assert.match(r.failures[0].message, /^Error: cannot connect\n {4}at SuiteContext/);
  assert.match(r.failures[1].message, /2 !== 1/);
  assert.deepEqual(r.failures[1].id, { file: 'test/math.test.js', name: 'subtracts' });
  const plain = parseNodeEvents('not json\n{"status":"failed","name":"x","path":[],"file":null,"line":null,"suite":false,"error":{"message":"boom","stack":null}}\n{"status":"failed","name":"s","path":[],"file":null,"line":null,"suite":true,"error":null}\n', '/p');
  assert.deepEqual(plain.failures.map((f) => [f.name, f.message, f.line]), [['x', 'boom', null]]);
  assert.equal(parseNodeEvents('{"status":"failed","name":"x","path":[],"suite":false,"error":null}', '/p').failures[0].message, '');
  // A whole file: not counted; reported only when it failed.
  const whole = (status) => JSON.stringify({ status, name: 'a.test.js', path: [], file: '/p/a.test.js', line: null, suite: false, whole_file: true, error: status === 'failed' ? { message: 'SyntaxError', stack: null } : null });
  assert.deepEqual(parseNodeEvents(whole('passed'), '/p'), { counts: emptyCounts(), failures: [] });
  const broken = parseNodeEvents(whole('failed'), '/p');
  assert.deepEqual([broken.counts.total, broken.failures[0].id], [0, { file: 'a.test.js', name: null }]);
});

test('vitest and jest: the Jest JSON report', () => {
  const v = parseJestJson(output('vitest.json'), '/work/vitest');
  assert.deepEqual(v.counts, counts(3, 1, 1, 1));
  assert.deepEqual(brief(v), [['math › subtracts', 'test/math.test.js', 5]]);
  assert.match(v.failures[0].message, /^AssertionError: expected 2 to be 1/);
  assert.deepEqual(v.failures[0].id, { file: 'test/math.test.js', name: 'math subtracts' });
  const j = parseJestJson(output('jest.json'), '/work/jest');
  assert.deepEqual(j.counts, counts(3, 1, 1, 1));
  assert.deepEqual(brief(j), [['math › subtracts', 'test/math.test.js', 3]]);
  assert.match(j.failures[0].message, /Expected: 1\nReceived: 2/);
});

test('Jest JSON: files that fail to load, locations, todo, odd shapes', () => {
  const report = {
    testResults: [
      { name: '/p/a.test.js', status: 'failed', message: 'SyntaxError: nope', assertionResults: [] },
      { name: '/p/b.test.js', status: 'failed', message: '', assertionResults: [{ title: 't', status: 'failed', location: { line: 7 }, failureMessages: ['x'] }] },
      { name: '/p/c.test.js', status: 'failed', assertionResults: [{ title: 'u', ancestorTitles: ['s'], status: 'failed', failureMessages: ['at y (/elsewhere.js:1:1)'] }] },
      { name: '/p/d.test.js', status: 'passed', assertionResults: [{ title: 'v', status: 'todo' }, { title: 'w', status: 'disabled' }] },
      { name: '/p/e.test.js', status: 'failed' },
    ],
  };
  const r = parseJestJson(JSON.stringify(report), '/p');
  // Files that failed as a whole are failures, not tests: they don't count.
  assert.deepEqual(r.counts, counts(4, 0, 2, 1, 1));
  assert.deepEqual(brief(r), [
    ['a.test.js', 'a.test.js', null],
    ['t', 'b.test.js', 7],
    ['s › u', 'c.test.js', null],
    ['e.test.js', 'e.test.js', null],
  ]);
  assert.equal(r.failures[0].message, 'SyntaxError: nope');
  assert.equal(r.failures[3].message, 'the test file failed');
  assert.deepEqual(parseJestJson('{}', '/p').counts, emptyCounts());
  assert.equal(parseJestJson(JSON.stringify({ testResults: [{ name: '/p/f.js', assertionResults: [{ title: 'z', status: 'failed', failureMessages: ['at q (/p/f.js:x)'] }] }] }), '/p').failures[0].line, null);
  assert.equal(parseJestJson(JSON.stringify({ testResults: [{ name: '/p/g.js', assertionResults: [{ title: 'y', status: 'failed' }] }] }), '/p').failures[0].message, '');
});

test('pytest: JUnit with node ids, collection errors, other JUnit writers', (t) => {
  const cwd = path.join(PROJECTS, 'pytest');
  const r = parseJunit(output('pytest.xml'), cwd);
  assert.deepEqual(r.counts, counts(3, 1, 1, 1));
  assert.deepEqual(brief(r), [['tests/test_math.py::test_subtracts', 'tests/test_math.py', 9]]);
  assert.equal(r.failures[0].id, 'tests/test_math.py::test_subtracts');
  assert.match(r.failures[0].message, /assert \(3 - 1\) == 1/);

  const dir = tmp(t, { 'tests/test_broken.py': '' });
  const c = parseJunit(output('pytest-collect-error.xml'), dir);
  assert.deepEqual(brief(c), [['tests/test_broken.py', 'tests/test_broken.py', 1]]);
  assert.match(c.failures[0].message, /No module named 'nonexistent_module'/);
  assert.deepEqual(parseJunit(output('pytest-collect-error.xml'), '/nowhere').failures[0].name, 'tests.test_broken');

  const java = '<testsuite><testcase classname="com.A" name="b" file="src/A.java" line="3"><error message="NPE"/></testcase><testcase name="c"><failure>boom</failure></testcase></testsuite>';
  assert.deepEqual(brief(parseJunit(java, '/p')), [['com.A.b', 'src/A.java', 3], ['c', null, null]]);
  assert.equal(parseJunit(java, '/p').failures[0].message, 'NPE');
  assert.equal(parseJunit('<testcase name="d"><failure/></testcase>', '/p').failures[0].message, '');
});

test('pytestNodeId: module path, classes, or nothing', (t) => {
  const dir = tmp(t, { 'tests/test_a.py': '', 'pkg/sub/test_b.py': '' });
  assert.equal(pytestNodeId('tests.test_a', 'test_x', dir), 'tests/test_a.py::test_x');
  assert.equal(pytestNodeId('pkg.sub.test_b.TestK', 'test_y', dir), 'pkg/sub/test_b.py::TestK::test_y');
  assert.equal(pytestNodeId('', 'tests.test_a', dir), 'tests/test_a.py');
  assert.equal(pytestNodeId('nope', 'x', dir), null);
});

test('go test -json: tests, subtests, build failures before and after Go 1.24', (t) => {
  const cwd = path.join(PROJECTS, 'go');
  const r = parseGoJson(output('go.jsonl'), cwd);
  assert.deepEqual(r.counts, counts(3, 1, 1, 1));
  assert.deepEqual(brief(r), [['example.com/fixture/mathx TestSubtracts', 'mathx/math_test.go', 13]]);
  assert.equal(r.failures[0].message, 'math_test.go:13: 3 - 1 = 2, want 1');
  assert.deepEqual(r.failures[0].id, { package: 'example.com/fixture/mathx', test: 'TestSubtracts' });

  const old = parseGoJson(output('go-build-fail.jsonl'), cwd, output('go-build-fail.txt'));
  assert.deepEqual(old.failures[1].name, 'example.com/fixture/broken');
  assert.equal(old.failures[1].message, 'broken/x.go:3:23: cannot use "s" (untyped string constant) as int value in return statement');
  const now = parseGoJson(output('go-build-fail-new.jsonl'), cwd);
  assert.match(now.failures[1].message, /^# example.com\/fixture\/broken.*\nbroken\/x.go:3:23: cannot use/);
  // Without the compiler's errors, the package's own output.
  assert.equal(parseGoJson(output('go-build-fail.jsonl'), cwd).failures[1].message, 'FAIL\texample.com/fixture/broken [build failed]');

  const events = [
    { Action: 'run', Package: 'm', Test: 'TestP' },
    { Action: 'run', Package: 'm', Test: 'TestP/sub' },
    { Action: 'output', Package: 'm', Test: 'TestP/sub', Output: '    p_test.go:9: bad\n' },
    { Action: 'fail', Package: 'm', Test: 'TestP/sub' },
    { Action: 'output', Package: 'm', Test: 'TestP', Output: '--- FAIL: TestP (0.00s)\n' },
    { Action: 'fail', Package: 'm', Test: 'TestP' },
    { Action: 'fail', Package: 'm' },
    { Action: 'fail', Package: 'q' },
  ];
  const sub = parseGoJson(events.map((e) => JSON.stringify(e)).join('\n'), tmp(t, { 'go.mod': 'module m\n' }));
  assert.deepEqual(sub.counts, counts(2, 0, 2, 0));
  assert.deepEqual(brief(sub), [['m TestP/sub', 'p_test.go', 9], ['q', null, null]]);
  // Outside a module, or a package outside it: the bare file name.
  const elsewhere = '{"Action":"output","Package":"x/y","Test":"T","Output":"  a_test.go:1: z\\n"}\n{"Action":"fail","Package":"x/y","Test":"T"}';
  assert.equal(parseGoJson(elsewhere, '/nowhere').failures[0].file, 'a_test.go');
  assert.equal(parseGoJson(elsewhere, tmp(t, { 'go.mod': 'module other\n' })).failures[0].file, 'a_test.go');
  assert.equal(parseGoJson(elsewhere.replaceAll('x/y', 'other'), tmp(t, { 'go.mod': 'module other\n' })).failures[0].file, 'a_test.go');
});

test('dotnet: TRX, one file or several', () => {
  const r = parseTrx(output('dotnet.trx'), '/src');
  assert.deepEqual(r.counts, counts(3, 1, 1, 1));
  assert.deepEqual(brief(r), [['MathTests.Subtracts', 'MathTests.cs', 9]]);
  assert.match(r.failures[0].message, /^Assert.Equal\(\) Failure: Values differ\nExpected: 1\nActual: {3}2\n {3}at MathTests.Subtracts\(\)/);
  assert.equal(r.failures[0].id, 'MathTests.Subtracts');
  assert.equal(parseTrx([output('dotnet.trx'), output('dotnet.trx')], '/src').counts.total, 6);
  const odd = '<UnitTestResult testName="A" outcome="Timeout"></UnitTestResult><UnitTestResult testName="B" outcome="Error"/>';
  assert.deepEqual(brief(parseTrx(odd, '/')), [['A', null, null], ['B', null, null]]);
});

test('text: node:test spec reporter', () => {
  const r = parseNodeText(output('node.txt'));
  assert.deepEqual(r.counts, counts(5, 1, 1, 1, 1, 1));
  assert.deepEqual(brief(r), [['db', 'test/hooks.test.js', 3], ['subtracts', 'test/math.test.js', 6]]);
  assert.doesNotMatch(r.failures[1].message, /generatedMessage/);
  assert.deepEqual(parseNodeText('nothing here').failures, []);
  assert.deepEqual(parseNodeText('✖ failing tests:\n\ntest at a.js:1:1\nnot a name line').failures, []);
  assert.deepEqual(parseNodeText('✖ failing tests:\ntest at a.js:1:1').failures, []);
});

test('text: vitest, jest, pytest', () => {
  const v = parseVitestText(output('vitest.txt'));
  assert.deepEqual(v.counts, { total: 3, passed: 1, failed: 1, skipped: 1, todo: null, cancelled: null });
  assert.deepEqual(brief(v), [['math › subtracts', 'test/math.test.js', 5]]);
  assert.match(v.failures[0].message, /^AssertionError: expected 2 to be 1[\s\S]*\+ 2$/);
  assert.equal(parseVitestText(' FAIL  a.test.js > t\nboom').failures[0].line, null);

  const j = parseJestText(output('jest.txt'));
  assert.deepEqual(j.counts, { total: 3, passed: 1, failed: 1, skipped: 1, todo: null, cancelled: null });
  assert.deepEqual(brief(j), [['math › subtracts', 'test/math.test.js', 3]]);
  assert.equal(j.failures[0].message, 'expect(received).toBe(expected) // Object.is equality\n\n    Expected: 1\n    Received: 2');
  assert.equal(parseJestText('  ● x\n    boom').failures[0].file, null);

  const p = parsePytestText(output('pytest.txt'));
  assert.deepEqual(p.counts, { total: 3, passed: 1, failed: 1, skipped: 1, todo: null, cancelled: null });
  assert.deepEqual(brief(p), [['tests/test_math.py::test_subtracts', 'tests/test_math.py', null]]);
  const errors = parsePytestText('ERROR tests/test_b.py\n===== 2 errors, 1 xfailed, 1 xpassed in 0.1s =====');
  assert.deepEqual(errors.counts, { total: 4, passed: 1, failed: 2, skipped: 1, todo: null, cancelled: null });
  assert.equal(errors.failures[0].message, '');
  assert.equal(parsePytestText('nothing').counts.total, null);
});

test('text: go, cargo, dotnet', () => {
  const g = parseGoText(output('go-build-fail.txt'));
  assert.deepEqual(g.counts.failed, 2);
  assert.deepEqual(brief(g), [['example.com/fixture/broken', null, null], ['TestSubtracts', 'math_test.go', 13]]);
  assert.match(g.failures[0].message, /cannot use "s"/);
  assert.equal(parseGoText('--- FAIL: TestX (0.00s)\nFAIL').failures[0].file, null);
  assert.equal(parseGoText('FAIL\tpkg [build failed]').failures[0].message, '');
  assert.equal(parseGoText('ok\tpkg\t0.1s').counts.failed, null);

  const c = parseCargoText(output('cargo.txt'));
  assert.deepEqual(c.counts, counts(3, 1, 1, 1));
  assert.deepEqual(brief(c), [['math::subtracts', 'src/lib.rs', 10]]);
  assert.equal(c.failures[0].message, "thread 'math::subtracts' (64) panicked at src/lib.rs:10:9:\nassertion `left == right` failed\n  left: 2\n right: 1");
  const build = parseCargoText(output('cargo-build-fail.txt'));
  assert.equal(build.counts.total, null);
  assert.deepEqual(brief(build), [['build', null, null]]);
  assert.match(build.failures[0].message, /^error\[E0308\]: mismatched types\n --> src\/lib.rs:4:29/);
  assert.deepEqual(parseCargoText('nothing').failures, []);
  assert.equal(parseCargoText('test a ... FAILED\n---- a stdout ----\nno panic here\n').failures[0].line, null);

  const d = parseDotnetText(output('dotnet.txt'));
  assert.deepEqual(d.counts, { total: 3, passed: 1, failed: 1, skipped: 1, todo: null, cancelled: null });
  assert.deepEqual(brief(d), [['MathTests.Subtracts', '/src/MathTests.cs', 9]]);
  assert.match(d.failures[0].message, /^Assert.Equal\(\) Failure: Values differ\nExpected: 1\nActual: {3}2/);
  const two = 'Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2\nFailed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1\n  Failed X [1 ms]\n  Error Message:\n   boom';
  assert.deepEqual(parseDotnetText(two).counts, { total: 3, passed: 2, failed: 1, skipped: 0, todo: null, cancelled: null });
  assert.equal(parseDotnetText(two).failures[0].file, null);
});

test('summarize: the report first, the text when the report is missing or broken', () => {
  const base = { stdout: output('node.txt'), stderr: '', cwd: '/work/node' };
  assert.equal(summarize({ ...base, runner: 'node', report: { format: 'node-events', content: output('node.jsonl') } }).source, 'node-events');
  assert.equal(summarize({ ...base, runner: 'node', report: null }).source, 'text');
  assert.equal(summarize({ ...base, runner: 'node', report: { format: 'jest-json', content: 'not json' } }).source, 'text');
  assert.equal(summarize({ ...base, runner: 'node', report: { format: 'node-events', content: '' } }).source, 'text');
  // An empty but valid report: nothing in it, so the text decides.
  assert.equal(summarize({ ...base, runner: 'node', report: { format: 'jest-json', content: '{}' } }).source, 'text');
  assert.equal(summarize({ ...base, runner: 'go', report: { format: 'go-json', content: output('go.jsonl') } }).source, 'go-json');
  assert.equal(summarize({ ...base, runner: 'pytest', report: { format: 'junit', content: output('pytest.xml') } }).source, 'junit');
  assert.equal(summarize({ ...base, runner: 'dotnet', report: { format: 'trx', content: [output('dotnet.trx')] } }).source, 'trx');
  assert.deepEqual(summarize({ ...base, runner: 'nope', report: null }), { counts: { total: null, passed: null, failed: null, skipped: null, todo: null, cancelled: null }, failures: [], source: 'none' });
  assert.equal(summarize({ runner: 'cargo', report: null, stdout: 'nothing', stderr: '', cwd: '/' }).source, 'none');
  // Paths inside the project become relative, in messages too.
  const v = summarize({ runner: 'vitest', report: { format: 'jest-json', content: output('vitest.json') }, stdout: '', stderr: '', cwd: '/work/vitest' });
  assert.match(v.failures[0].message, /\n {4}at test\/math.test.js:5:41$/);
  assert.equal(summarize({ runner: 'dotnet', report: null, stdout: output('dotnet.txt'), stderr: '', cwd: '/src' }).failures[0].file, 'MathTests.cs');
});

test('long messages are clipped', () => {
  const long = 'x'.repeat(5000);
  const r = parseNodeEvents(JSON.stringify({ status: 'failed', name: 'n', path: [], file: null, line: null, suite: false, error: { message: long, stack: null } }), '/');
  assert.equal(r.failures[0].message.length, 4002);
  assert.ok(fs.existsSync(path.join(PROJECTS, 'pytest', 'tests', 'test_math.py')));
});
