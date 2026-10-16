// Re-runs each failing test on its own to tell a real failure from a flaky one.
//   real        it fails again alone
//   flaky       it ran alone and passed: something in the full run (order, shared state,
//               parallelism, timing) made it fail
//   unresolved  it could not be run alone, or the run alone didn't show it: never a flake
// The same agent that wants the suite green runs the rerun, so "unresolved" is not a pass.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NODE_REPORTER, pythonCommand } from './detect.js';
import { summarize } from './parse.js';
import { childEnv, exec, readReport } from './run.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The command that runs only this failure, or null when the runner can't single it out. */
export function isolate(runner, id, { cwd, manifest, reportDir }) {
  if (!id) return null;
  const out = (name) => path.join(reportDir, name);
  switch (runner) {
    case 'node': {
      if (!id.file) return null;
      const file = out('node-events.jsonl');
      const reporters = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${JSON.stringify(NODE_REPORTER)} --test-reporter-destination=stderr`;
      return {
        command: [process.execPath, '--test', ...(id.name ? [`--test-name-pattern=${escape(id.name)}`] : []), id.file],
        env: { NODE_OPTIONS: reporters, CLI_TEST_SUMMARY_NODE_OUT: file },
        report: { format: 'node-events', path: file },
      };
    }
    case 'vitest': {
      const file = out('vitest.json');
      return {
        command: ['npx', '--no-install', 'vitest', 'run', id.file, ...(id.name ? ['-t', `^${escape(id.name)}$`] : []), '--reporter=json', `--outputFile.json=${file}`],
        report: { format: 'jest-json', path: file },
      };
    }
    case 'jest': {
      const file = out('jest.json');
      return {
        command: ['npx', '--no-install', 'jest', '--ci', id.file, ...(id.name ? ['-t', `^${escape(id.name)}$`] : []), '--json', `--outputFile=${file}`],
        report: { format: 'jest-json', path: file },
      };
    }
    case 'pytest': {
      const file = out('junit.xml');
      return { command: [...pythonCommand(cwd), id], env: { PYTEST_ADDOPTS: `--junitxml=${JSON.stringify(file)}` }, report: { format: 'junit', path: file } };
    }
    case 'go':
      if (!id.test || !id.package) return null;
      return {
        command: ['go', 'test', '-json', '-count=1', '-run', id.test.split('/').map((p) => `^${escape(p)}$`).join('/'), id.package],
        report: { format: 'go-json', path: null },
      };
    case 'cargo':
      return { command: ['cargo', 'test', id, '--', '--exact'], report: null };
    case 'dotnet': {
      const dir = out('trx');
      return {
        command: ['dotnet', 'test', ...(manifest ? [manifest] : []), '--filter', `FullyQualifiedName=${id}`, '--logger', 'trx', '--results-directory', dir],
        report: { format: 'trx', path: dir },
      };
    }
    default:
      return null;
  }
}

/** real / flaky / unresolved, from the run alone. */
export function classify(failure, alone) {
  if (!alone) return { verdict: 'unresolved', reason: 'the runner cannot run this one alone' };
  if (alone.failures.some((f) => f.name === failure.name)) return { verdict: 'real', reason: null };
  if (alone.exitCode === 0 && alone.counts.passed > 0 && !alone.failures.length) return { verdict: 'flaky', reason: null };
  return { verdict: 'unresolved', reason: alone.failures.length ? 'the run alone failed differently' : 'the run alone did not run it' };
}

/**
 * Adds `rerun` to each failure of a result from runTests(), and a `verdict` to the result:
 * pass, fail, or flaky (every failure passed alone and explains the failed run).
 */
export async function rerunFailures(result, { maxReruns = 10, timeoutMs = 0, env = process.env } = {}) {
  if (!result.detected || result.ok) return { ...result, verdict: result.ok ? 'pass' : 'fail' };
  const { plan } = result;
  const summary = { real: 0, flaky: 0, unresolved: 0, not_rerun: 0 };
  const failures = [];
  for (const [i, f] of result.failures.entries()) {
    if (i >= maxReruns) {
      summary.not_rerun++;
      failures.push({ ...f, rerun: null });
      continue;
    }
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-summary-rerun-'));
    try {
      const cmd = isolate(plan.runner, f.id, { cwd: plan.cwd, manifest: plan.manifest, reportDir });
      let alone = null;
      if (cmd) {
        const run = await exec(cmd.command, { cwd: plan.cwd, env: childEnv(env, cmd.env), timeoutMs });
        const parsed = summarize({ runner: plan.runner, report: readReport(cmd.report, run.stdout), stdout: run.stdout, stderr: run.stderr, cwd: plan.cwd });
        alone = { ...parsed, exitCode: run.code };
      }
      const { verdict, reason } = classify(f, alone);
      summary[verdict]++;
      failures.push({ ...f, rerun: verdict, ...(reason ? { rerun_reason: reason } : {}) });
    } finally {
      fs.rmSync(reportDir, { recursive: true, force: true });
    }
  }
  // Flaky only when nothing else failed the run: every failure flaky, none left unchecked.
  const allFlaky = failures.length > 0 && summary.flaky === failures.length && !result.note;
  return { ...result, failures, rerun: summary, verdict: allFlaky ? 'flaky' : 'fail' };
}
