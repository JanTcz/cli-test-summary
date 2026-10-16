// From what a test runner wrote to counts and failures, the same shape for every runner.
// Structured reports first (node events, Jest JSON, JUnit, `go test -json`, TRX); the text
// parsers are the fallback when a report can't be had, and the only way for cargo.

import fs from 'node:fs';
import path from 'node:path';
import { elements, first, text } from './xml.js';

const MAX_MESSAGE = 4000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const stripAnsi = (s) => s.replace(ANSI, '');

export function emptyCounts() {
  return { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
}

function tally(counts, status) {
  counts[status]++;
  counts.total++;
}

function clip(s) {
  const t = s.trim();
  return t.length > MAX_MESSAGE ? `${t.slice(0, MAX_MESSAGE)}\n…` : t;
}

/** A path from a report, relative to the project when it is inside it. */
export function relPath(file, cwd) {
  if (!file) return null;
  let f = file.replace(/^file:\/\//, '');
  if (path.isAbsolute(f)) {
    const r = path.relative(cwd, f);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) f = r;
  }
  return f.split(path.sep).join('/');
}

/** Drops stack frames of the runner and the platform; what is left points at the test. */
export function trimStack(s) {
  return s
    .split('\n')
    .filter((l) => !/^\s*at .*(node_modules|node:internal|\(node:|\(<anonymous>\)|\(index \d+\)|System\.(Runtime|Reflection))/.test(l))
    .join('\n');
}

function failure(name, file, line, message, id = null) {
  return { name, file, line: line == null ? null : Number(line), message: clip(trimStack(stripAnsi(message))), id };
}

// ─── node:test, events from src/reporters/node.mjs ─────────────────────────────

const SUBTESTS_FAILED = /^\d+ subtests? failed$/;

export function parseNodeEvents(content, cwd) {
  const counts = emptyCounts();
  const failures = [];
  for (const line of content.split('\n')) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const name = [...r.path, r.name].join(' › ');
    const file = relPath(r.file, cwd);
    // The stack starts with the message, so it is the whole story when there is one.
    const message = r.error?.stack ?? r.error?.message ?? '';
    // A suite fails on its own only through a hook; "1 subtest failed" is already counted.
    if (r.suite) {
      if (r.status === 'failed' && r.error && !SUBTESTS_FAILED.test(r.error.message)) {
        failures.push(failure(name, file, r.line, message, { file, name: r.name }));
      }
      continue;
    }
    // A whole file is not a test; it only matters when it failed (e.g. didn't load).
    if (!r.whole_file) tally(counts, r.status);
    if (r.status === 'failed') failures.push(failure(name, file, r.line, message, r.whole_file ? { file, name: null } : { file, name: r.name }));
  }
  return { counts, failures };
}

// ─── vitest and jest: the Jest JSON report ─────────────────────────────────────

const JEST_STATUS = { passed: 'passed', failed: 'failed', todo: 'todo' };

function lineIn(message, file) {
  const at = message.indexOf(`${file}:`);
  if (at === -1) return null;
  return Number(/^:(\d+)/.exec(message.slice(at + file.length))?.[1] ?? NaN) || null;
}

export function parseJestJson(content, cwd) {
  const data = JSON.parse(content);
  const counts = emptyCounts();
  const failures = [];
  for (const suite of data.testResults ?? []) {
    const file = relPath(suite.name, cwd);
    const tests = suite.assertionResults ?? [];
    for (const t of tests) {
      const status = JEST_STATUS[t.status] ?? 'skipped';
      tally(counts, status);
      if (status !== 'failed') continue;
      const message = (t.failureMessages ?? []).join('\n\n');
      const name = [...(t.ancestorTitles ?? []), t.title].join(' › ');
      failures.push(failure(name, file, t.location?.line ?? lineIn(message, suite.name), message, { file, name: t.fullName ?? name }));
    }
    // A file that failed to load, or a failing hook outside any test.
    if (suite.status === 'failed' && !tests.some((t) => t.status === 'failed')) {
      failures.push(failure(file, file, null, suite.message || 'the test file failed', { file, name: null }));
    }
  }
  return { counts, failures };
}

// ─── pytest and anything else that writes JUnit XML ────────────────────────────

/** pytest's classname is a dotted module path, maybe with classes: find the file it names. */
export function pytestNodeId(classname, name, cwd) {
  // A collection error has no classname; its name is the module.
  const parts = (classname || name).split('.');
  const rest = classname ? [name] : [];
  for (let i = parts.length; i > 0; i--) {
    const file = `${parts.slice(0, i).join('/')}.py`;
    if (fs.existsSync(path.join(cwd, file))) return [file, ...parts.slice(i), ...rest].join('::');
  }
  return null;
}

export function parseJunit(content, cwd) {
  const counts = emptyCounts();
  const failures = [];
  for (const tc of elements(content, 'testcase')) {
    const { classname, name, file, line } = tc.attrs;
    const bad = first(tc.body, 'failure') ?? first(tc.body, 'error');
    if (first(tc.body, 'skipped')) {
      tally(counts, 'skipped');
      continue;
    }
    if (!bad) {
      tally(counts, 'passed');
      continue;
    }
    tally(counts, 'failed');
    const message = text(bad.body) || bad.attrs.message || '';
    const loc = [...message.matchAll(/^(\S+\.\w+):(\d+): /gm)].pop();
    // pytest's own id when the module is found ("tests/test_x.py::test_y"), else JUnit's class.name.
    const id = pytestNodeId(classname, name, cwd);
    const full = id ?? (classname ? `${classname}.${name}` : name);
    failures.push(failure(full, relPath(file ?? loc?.[1] ?? null, cwd), line ?? loc?.[2] ?? null, message, id));
  }
  return { counts, failures };
}

// ─── go test -json ─────────────────────────────────────────────────────────────

/** The directory of a package inside the module in `cwd`, for file paths. */
function packageDir(pkg, cwd) {
  let mod = null;
  try {
    mod = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(cwd, 'go.mod'), 'utf8'))?.[1];
  } catch {
    return null;
  }
  if (pkg === mod) return '';
  return mod && pkg.startsWith(`${mod}/`) ? pkg.slice(mod.length + 1) : null;
}

const GO_NOISE = /^(=== (RUN|PAUSE|CONT|NAME)|\s*--- (FAIL|PASS|SKIP):)/;

function goFailure(pkg, test, lines, cwd, id) {
  const message = lines.filter((l) => !GO_NOISE.test(l)).join('\n');
  const loc = /^\s+(\S+\.go):(\d+):/m.exec(message);
  const dir = loc ? packageDir(pkg, cwd) : null;
  const file = loc ? (dir == null ? loc[1] : path.posix.join(dir, loc[1])) : null;
  return failure(`${pkg} ${test}`, file, loc?.[2] ?? null, message, id);
}

/** stderr of `go test` (before Go 1.24): "# pkg" followed by the compiler's errors. */
function buildErrorsFromStderr(stderr) {
  const out = new Map();
  let current = null;
  for (const line of stderr.split('\n')) {
    const header = /^# (\S+)/.exec(line);
    if (header) out.set((current = header[1]), []);
    else if (/^(FAIL|ok|---|PASS|===)\b/.test(line)) current = null;
    else if (current && line.trim()) out.get(current).push(line);
  }
  return out;
}

export function parseGoJson(content, cwd, stderr = '') {
  const counts = emptyCounts();
  const tests = new Map();
  const packageOutput = new Map();
  const builds = new Map();
  const failedPackages = [];
  for (const line of content.split('\n')) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.Action === 'build-output') {
      builds.set(r.ImportPath, [...(builds.get(r.ImportPath) ?? []), r.Output.replace(/\n$/, '')]);
    } else if (r.Test) {
      const key = `${r.Package}\0${r.Test}`;
      const t = tests.get(key) ?? { pkg: r.Package, test: r.Test, status: null, output: [] };
      tests.set(key, t);
      if (r.Action === 'output') t.output.push(r.Output.replace(/\n$/, ''));
      else if (r.Action === 'pass' || r.Action === 'fail' || r.Action === 'skip') t.status = r.Action;
    } else if (r.Action === 'output') {
      packageOutput.set(r.Package, [...(packageOutput.get(r.Package) ?? []), r.Output.replace(/\n$/, '')]);
    } else if (r.Action === 'fail') {
      failedPackages.push(r);
    }
  }
  const failures = [];
  const all = [...tests.values()].filter((t) => t.status);
  for (const t of all) {
    tally(counts, t.status === 'pass' ? 'passed' : t.status === 'fail' ? 'failed' : 'skipped');
    if (t.status !== 'fail') continue;
    const f = goFailure(t.pkg, t.test, t.output, cwd, { package: t.pkg, test: t.test });
    // A parent that failed only because a subtest did adds nothing.
    const hasFailingChild = all.some((o) => o.status === 'fail' && o.pkg === t.pkg && o.test.startsWith(`${t.test}/`));
    if (!(hasFailingChild && !f.message)) failures.push(f);
  }
  const fromStderr = buildErrorsFromStderr(stderr);
  for (const p of failedPackages) {
    if (all.some((t) => t.status === 'fail' && t.pkg === p.Package)) continue;
    const build = builds.get(p.FailedBuild) ?? fromStderr.get(p.Package);
    const lines = build ?? packageOutput.get(p.Package) ?? [];
    failures.push(failure(p.Package, null, null, lines.join('\n'), { package: p.Package, test: null }));
  }
  return { counts, failures };
}

// ─── dotnet test --logger trx ──────────────────────────────────────────────────

const TRX_STATUS = { Passed: 'passed', NotExecuted: 'skipped', Inconclusive: 'skipped', Pending: 'skipped' };

export function parseTrx(contents, cwd) {
  const counts = emptyCounts();
  const failures = [];
  for (const content of [contents].flat()) {
    for (const r of elements(content, 'UnitTestResult')) {
      const status = TRX_STATUS[r.attrs.outcome] ?? 'failed';
      tally(counts, status);
      if (status !== 'failed') continue;
      const message = text(first(r.body, 'Message')?.body);
      const stack = text(first(r.body, 'StackTrace')?.body);
      const loc = / in (.+?):line (\d+)/.exec(stack);
      failures.push(failure(r.attrs.testName, relPath(loc?.[1] ?? null, cwd), loc?.[2] ?? null, [message, stack].filter(Boolean).join('\n'), r.attrs.testName));
    }
  }
  return { counts, failures };
}

// ─── text, when there is no report ─────────────────────────────────────────────

const nullCounts = () => ({ total: null, passed: null, failed: null, skipped: null, todo: null, cancelled: null });

/** "1 failed, 2 passed" or "1 failed | 2 passed" into counts; words map to our names. */
function countWords(s, words) {
  const counts = nullCounts();
  for (const [, n, word] of s.matchAll(/(\d+) (\w+)/g)) {
    const key = words[word.toLowerCase()];
    if (key) counts[key] = (counts[key] ?? 0) + Number(n);
  }
  if (counts.total === null) {
    const known = ['passed', 'failed', 'skipped', 'todo', 'cancelled'].map((k) => counts[k]).filter((v) => v !== null);
    if (known.length) counts.total = known.reduce((a, b) => a + b, 0);
  }
  return counts;
}

/** Lines after `start` up to the first line `stop` matches. */
function block(lines, start, stop) {
  const out = [];
  for (let i = start; i < lines.length && !stop(lines[i]); i++) out.push(lines[i]);
  return out.join('\n');
}

export function parseNodeText(output) {
  const lines = stripAnsi(output).split('\n');
  const counts = nullCounts();
  const keys = { tests: 'total', pass: 'passed', fail: 'failed', skipped: 'skipped', todo: 'todo', cancelled: 'cancelled' };
  for (const l of lines) {
    const m = /^ℹ (\w+) (\d+)$/.exec(l.trim());
    if (m && keys[m[1]]) counts[keys[m[1]]] = Number(m[2]);
  }
  const failures = [];
  const section = lines.findIndex((l) => l.startsWith('✖ failing tests:'));
  for (let i = section + 1; section !== -1 && i < lines.length; i++) {
    const at = /^test at (.+):(\d+):\d+$/.exec(lines[i]);
    const name = at && /^✖ (.+?) \([\d.]+m?s\)/.exec(lines[i + 1] ?? '');
    if (!name) continue;
    // Node prints the error's own properties after the stack; they repeat the message.
    const message = block(lines, i + 2, (l) => l.startsWith('test at ') || /^\s*(generatedMessage|code): /.test(l)).replace(/^ {2}/gm, '');
    failures.push(failure(name[1], at[1], at[2], message));
  }
  return { counts, failures };
}

export function parseVitestText(output) {
  const lines = stripAnsi(output).split('\n');
  const summary = lines.find((l) => /^\s+Tests\s+\d/.test(l)) ?? '';
  const counts = countWords(summary.replace(/\((\d+)\)/, '$1 total'), { failed: 'failed', passed: 'passed', skipped: 'skipped', todo: 'todo', total: 'total' });
  const failures = [];
  lines.forEach((l, i) => {
    const m = /^ FAIL {2}(\S+) > (.+)$/.exec(l);
    if (!m) return;
    const message = block(lines, i + 1, (x) => /^ FAIL {2}|^⎯/.test(x));
    const loc = /❯ (\S+):(\d+):\d+/.exec(message);
    failures.push(failure(m[2].split(' > ').join(' › '), m[1], loc?.[2] ?? null, message.replace(/\n ❯[\s\S]*/, '')));
  });
  return { counts, failures };
}

export function parseJestText(output) {
  const lines = stripAnsi(output).split('\n');
  const summary = lines.find((l) => l.startsWith('Tests:')) ?? '';
  const counts = countWords(summary, { failed: 'failed', passed: 'passed', skipped: 'skipped', todo: 'todo', total: 'total' });
  const failures = [];
  lines.forEach((l, i) => {
    const m = /^ {2}● (.+)$/.exec(l);
    if (!m) return;
    const message = block(lines, i + 1, (x) => /^ {2}● |^Test Suites:|^(PASS|FAIL) /.test(x));
    const loc = /at .*\((.+?):(\d+):\d+\)/.exec(message);
    failures.push(failure(m[1], loc?.[1] ?? null, loc?.[2] ?? null, message.replace(/\n\s+\d+ \|[\s\S]*/, '')));
  });
  return { counts, failures };
}

export function parsePytestText(output) {
  const lines = stripAnsi(output).split('\n');
  const summary = [...lines].reverse().find((l) => /^=+ .*\d+ \w+.* in [\d.]+s/.test(l)) ?? '';
  const counts = countWords(summary, { failed: 'failed', passed: 'passed', skipped: 'skipped', error: 'failed', errors: 'failed', xfailed: 'skipped', xpassed: 'passed' });
  const failures = [];
  for (const l of lines) {
    const m = /^(FAILED|ERROR) (\S+?)(?: - (.*))?$/.exec(l);
    if (!m) continue;
    const [file] = m[2].split('::');
    failures.push(failure(m[2], file, null, m[3] ?? '', m[2]));
  }
  return { counts, failures };
}

export function parseGoText(output) {
  const lines = stripAnsi(output).split('\n');
  const counts = nullCounts();
  const failures = [];
  lines.forEach((l, i) => {
    const t = /^\s*--- FAIL: (\S+) /.exec(l);
    const build = /^FAIL\t(\S+) \[build failed\]/.exec(l);
    if (t) {
      const message = block(lines, i + 1, (x) => !/^\s{4}/.test(x));
      const loc = /^\s+(\S+\.go):(\d+):/m.exec(message);
      failures.push(failure(t[1], loc?.[1] ?? null, loc?.[2] ?? null, message, { package: null, test: t[1] }));
    } else if (build) {
      failures.push(failure(build[1], null, null, buildErrorsFromStderr(output).get(build[1])?.join('\n') ?? '', { package: build[1], test: null }));
    }
  });
  if (failures.length) counts.failed = failures.length;
  return { counts, failures };
}

export function parseCargoText(output) {
  const lines = stripAnsi(output).split('\n');
  const counts = emptyCounts();
  let seen = false;
  for (const l of lines) {
    const m = /^test (.+?) \.\.\. (ok|FAILED|ignored)/.exec(l);
    if (!m) continue;
    seen = true;
    tally(counts, m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped');
  }
  const failures = [];
  lines.forEach((l, i) => {
    const m = /^---- (.+?) stdout ----$/.exec(l);
    if (!m) return;
    const message = block(lines, i + 1, (x) => /^---- |^failures:$/.test(x)).replace(/^note: run with `RUST_BACKTRACE.*$/m, '');
    const loc = /panicked at (.+?):(\d+):\d+/.exec(message);
    failures.push(failure(m[1], loc?.[1] ?? null, loc?.[2] ?? null, message, m[1]));
  });
  // Nothing ran: a compile error is the failure.
  if (!seen) {
    const start = lines.findIndex((l) => /^error(\[E\d+\])?: /.test(l));
    if (start !== -1) failures.push(failure('build', null, null, block(lines, start, (l) => /^error: could not compile/.test(l)), null));
  }
  return { counts: seen ? counts : nullCounts(), failures };
}

export function parseDotnetText(output) {
  const lines = stripAnsi(output).split('\n');
  const counts = nullCounts();
  for (const l of lines) {
    const m = /^(?:Failed|Passed)!\s+- (.*)$/.exec(l.trim());
    if (!m) continue;
    const c = countWords(m[1].replace(/:\s+/g, ' ').replace(/(\w+) (\d+)/g, '$2 $1'), { failed: 'failed', passed: 'passed', skipped: 'skipped', total: 'total' });
    for (const k of Object.keys(c)) if (c[k] !== null) counts[k] = (counts[k] ?? 0) + c[k];
  }
  const failures = [];
  lines.forEach((l, i) => {
    const m = /^ {2}Failed (\S+) \[/.exec(l);
    if (!m) return;
    const message = block(lines, i + 1, (x) => /^ {2}(Failed|Passed|Skipped) \S+ \[|^Results File:|^(Failed|Passed)!/.test(x))
      .replace(/^ {2}(Error Message|Stack Trace):$/gm, '')
      .replace(/^ {3}/gm, '');
    const loc = / in (.+?):line (\d+)/.exec(message);
    failures.push(failure(m[1], loc?.[1] ?? null, loc?.[2] ?? null, message, m[1]));
  });
  return { counts, failures };
}

export const TEXT_PARSERS = {
  node: parseNodeText,
  vitest: parseVitestText,
  jest: parseJestText,
  pytest: parsePytestText,
  go: parseGoText,
  cargo: parseCargoText,
  dotnet: parseDotnetText,
};

/**
 * Counts and failures from a run: the report when there is one and it parses,
 * otherwise the runner's text output.
 *
 * @param {{ runner: string, report?: { format: string, content: string|string[] } | null,
 *           stdout: string, stderr: string, cwd: string }} run
 */
export function summarize(run) {
  const parsed = summarizeRaw(run);
  // Paths inside the project, relative in messages too: shorter, and what an editor opens.
  const prefixes = [`file://${run.cwd}/`, `${run.cwd}/`];
  for (const f of parsed.failures) f.message = prefixes.reduce((m, p) => m.split(p).join(''), f.message);
  return parsed;
}

function summarizeRaw({ runner, report, stdout, stderr, cwd }) {
  if (report?.content?.length) {
    try {
      const parsed = {
        'node-events': () => parseNodeEvents(report.content, cwd),
        'jest-json': () => parseJestJson(report.content, cwd),
        junit: () => parseJunit(report.content, cwd),
        'go-json': () => parseGoJson(report.content, cwd, stderr),
        trx: () => parseTrx(report.content, cwd),
      }[report.format]();
      if (parsed.counts.total > 0 || parsed.failures.length) return { ...parsed, source: report.format };
    } catch {
      // a truncated or foreign report: fall back to the text
    }
  }
  const parse = TEXT_PARSERS[runner];
  if (!parse) return { counts: nullCounts(), failures: [], source: 'none' };
  const { counts, failures } = parse(`${stdout}\n${stderr}`);
  for (const f of failures) f.file = relPath(f.file, cwd);
  return { counts, failures, source: counts.total === null && !failures.length ? 'none' : 'text' };
}
