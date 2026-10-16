// Runs the plan, reads the report, and says what happened: the verdict is the exit code
// of the project's own command; the counts and failures explain it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProject, plan as makePlan } from './detect.js';
import { stripAnsi, summarize } from './parse.js';

const TAIL_LINES = 60;

/** Something that stops the run before any test does: exit code 2. */
export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

/**
 * The environment for a test run: ours on top of the caller's, colors off, and without
 * NODE_TEST_CONTEXT, which a surrounding `node --test` sets and which makes a nested one
 * report to it instead of running on its own.
 */
export function childEnv(env, extra = {}) {
  const out = { ...env, ...extra, NO_COLOR: '1', FORCE_COLOR: '0' };
  delete out.NODE_TEST_CONTEXT;
  return out;
}

/**
 * Runs a command and collects its output.
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, durationMs: number }>}
 */
export function exec(command, { cwd, env, timeoutMs = 0, tee = null, killAfterMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d;
      tee?.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      tee?.write(d);
    });
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), killAfterMs).unref();
        }, timeoutMs)
      : null;
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new SetupError(`${command[0]} is not installed or not on PATH`) : err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

/** The report the runner wrote, or (for `go test -json`) its stdout. */
export function readReport(report, stdout) {
  if (!report) return null;
  if (report.format === 'go-json') return { format: report.format, content: stdout };
  try {
    if (fs.statSync(report.path).isDirectory()) {
      const files = fs.readdirSync(report.path).filter((f) => f.endsWith('.trx')).sort();
      return { format: report.format, content: files.map((f) => fs.readFileSync(path.join(report.path, f), 'utf8')) };
    }
    return { format: report.format, content: fs.readFileSync(report.path, 'utf8') };
  } catch {
    return null;
  }
}

/** What the run printed, for a human: go's JSON events turned back into text. */
export function plainOutput(format, stdout, stderr) {
  let out = stdout;
  if (format === 'go-json') {
    out = stdout
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l).Output ?? '';
        } catch {
          return l ? `${l}\n` : '';
        }
      })
      .join('');
  }
  return stripAnsi(`${out}${stderr ? `\n${stderr}` : ''}`);
}

export function tail(text, lines = TAIL_LINES) {
  const all = text.replace(/\s+$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

/** Why the result is what it is, when the numbers alone could mislead. */
export function explain({ exitCode, timedOut, timeoutMs, counts, failures, source }) {
  if (timedOut) return `timed out after ${Math.round(timeoutMs / 1000)} s; the counts are what had finished by then`;
  if (exitCode !== 0 && !failures.length) {
    return `the command failed (exit ${exitCode}) but no test failed: something around the tests did, such as a coverage threshold, a build or type error, a lint step or a crash. See output_tail`;
  }
  if (exitCode === 0 && failures.length) return 'the command succeeded but reported failing tests (is its exit code ignored, e.g. `|| true`?); treated as a failure';
  if (exitCode === 0 && counts.total === 0) return 'no tests ran';
  if (source === 'none') return 'the runner\'s output could not be read, so there are no counts; the verdict is the exit code';
  return null;
}

const display = (command) => command.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ');

/**
 * Detects the project, runs its tests and summarizes them.
 *
 * @param {{ cwd?: string, filter?: string, runner?: string, command?: string[], timeoutMs?: number,
 *           tee?: { write(chunk): void } | null, env?: object, project?: object|null }} opts
 */
export async function runTests(opts = {}) {
  const { cwd = process.cwd(), filter, runner, command, timeoutMs = 0, tee = null, env = process.env } = opts;
  const project = opts.project !== undefined ? opts.project : findProject(cwd);
  if (!project && !command?.length) {
    return { detected: false, ok: null, reason: `no test runner found in or around ${path.resolve(cwd)} (looked for package.json, pyproject.toml, go.mod, Cargo.toml and .NET projects)` };
  }
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-summary-'));
  try {
    // A command of your own may run where no project is recognized: then cwd is the project.
    const p = makePlan(project ?? { dir: path.resolve(cwd), runner: null }, { filter, runner, command, reportDir, env });
    if (!p) throw new SetupError(`unknown runner "${runner}"`);
    const run = await exec(p.command, { cwd: p.cwd, env: childEnv(env, p.env), timeoutMs, tee });
    const report = readReport(p.report, run.stdout);
    const { counts, failures, source } = summarize({ runner: p.runner, report, stdout: run.stdout, stderr: run.stderr, cwd: p.cwd });
    // `id` is how rerun finds a test again; it is runner-specific, so it stays out of the output.
    for (const f of failures) Object.defineProperty(f, 'id', { value: f.id, enumerable: false });
    const exitCode = run.code ?? 1;
    const ok = exitCode === 0 && !run.timedOut && failures.length === 0;
    const result = {
      detected: true,
      ok,
      runner: p.runner,
      command: display(p.shown.map((a) => (a === process.execPath ? 'node' : a))),
      cwd: path.relative(cwd, p.cwd).split(path.sep).join('/') || '.',
      exit_code: run.code,
      duration_ms: run.durationMs,
      counts,
      failures,
      source,
      note: explain({ exitCode, timedOut: run.timedOut, timeoutMs, counts, failures, source }),
    };
    if (!ok) result.output_tail = tail(plainOutput(p.report?.format, run.stdout, run.stderr));
    Object.defineProperty(result, 'plan', { value: p, enumerable: false });
    return result;
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}
