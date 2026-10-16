// The `cli-test-summary` command. JSON on a pipe (or with --json), a short summary on a terminal.

import fs from 'node:fs';
import path from 'node:path';
import { RUNNERS, detect } from './detect.js';
import { serve } from './mcp.js';
import { rerunFailures } from './rerun.js';
import { SetupError, runTests } from './run.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const BOOLEAN = new Set(['json', 'text', 'help', 'version', 'rerun', 'stream']);

export const USAGE = `cli-test-summary ${VERSION}: run a project's tests, get one JSON answer

Usage: cli-test-summary [run] [--flags] [-- command ...]
       cli-test-summary detect [--cwd=dir]
       cli-test-summary mcp

  run (default)       detect the project, run its tests, summarize them
    --cwd=dir         where to look for the project (default: here)
    --filter=pattern  only tests matching it (runs the runner directly, not the test script)
    --runner=name     skip detection: ${RUNNERS.join(', ')}
    --rerun           re-run every failure alone: real, flaky or unresolved
    --max-reruns=10   rerun at most this many failures
    --timeout=secs    stop the run after this long (default: none)
    --stream          also print the runner's output to stderr as it runs
    -- command ...    run this command instead of the detected one (e.g. -- make test)
  detect              what would run, without running it
  mcp                 MCP server on stdin/stdout

Output: JSON when stdout is not a terminal or with --json; a summary with --text or on a terminal.
Exit: 0 passed (or, with --rerun, only flaky failures), 1 failed, 2 nothing to run or bad arguments.
`;

export class UsageError extends Error {}

export function parseArgs(args) {
  const flags = {};
  const positional = [];
  let command = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      command = args.slice(i + 1);
      break;
    }
    if (a === '-h') flags.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      else if (BOOLEAN.has(name)) flags[name] = true;
      else if (i + 1 < args.length) flags[name] = args[++i];
      else throw new UsageError(`--${name} needs a value`);
    } else positional.push(a);
  }
  if (command && !command.length) throw new UsageError('nothing after --');
  return { flags, positional, command };
}

function number(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a number`);
  return n;
}

const plural = (n, word) => `${n} ${word}`;

export function formatText(r) {
  if (r.op === 'detect') {
    if (!r.detected) return `nothing to run: ${r.reason}`;
    return `${r.runner} in ${r.cwd}: ${r.command}${r.mode === 'script' ? ' (the project\'s test script)' : ''}`;
  }
  if (!r.detected) return `nothing to run: ${r.reason}`;
  const c = r.counts;
  const parts = [
    c.failed ? plural(c.failed, 'failed') : null,
    c.passed !== null ? plural(c.passed, 'passed') : null,
    c.skipped ? plural(c.skipped, 'skipped') : null,
    c.todo ? plural(c.todo, 'todo') : null,
    c.cancelled ? plural(c.cancelled, 'cancelled') : null,
  ].filter(Boolean);
  const mark = r.ok ? '✔' : r.verdict === 'flaky' ? '≈' : '✖';
  const lines = [`${mark} ${parts.join(' · ') || (r.ok ? 'passed' : 'failed')}   ${r.runner} · ${r.command} · ${(r.duration_ms / 1000).toFixed(1)} s`];
  for (const f of r.failures) {
    const where = f.file ? `  ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    lines.push(`  ✖ ${f.name}${where}${f.rerun ? `  [${f.rerun}]` : ''}`);
    const msg = f.message.split('\n').filter((l) => l.trim()).slice(0, 4);
    for (const l of msg) lines.push(`      ${l}`);
  }
  if (r.note) lines.push(`note: ${r.note}`);
  if (r.output_tail && !r.failures.length) lines.push('', r.output_tail);
  return lines.join('\n');
}

export function exitCode(r) {
  if (!r.detected) return 2;
  if (r.ok || r.verdict === 'flaky') return 0;
  return 1;
}

/**
 * @param {string[]} args  the arguments after the command name
 * @returns {Promise<number>} the exit code
 */
export async function main(args, io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, cwd: here = process.cwd(), env = process.env } = io;
  const isTTY = io.isTTY ?? Boolean(stdout.isTTY);
  try {
    const { flags, positional, command } = parseArgs(args);
    if (flags.version) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (flags.help || positional[0] === 'help') {
      stdout.write(USAGE);
      return 0;
    }
    const sub = positional[0] ?? 'run';
    if (positional.length > 1 || !['run', 'detect', 'mcp'].includes(sub)) throw new UsageError(`unknown command "${positional.join(' ')}"; cli-test-summary --help lists them`);
    const cwd = path.resolve(here, flags.cwd ?? '.');
    if (flags.runner && !RUNNERS.includes(flags.runner)) throw new UsageError(`--runner must be one of ${RUNNERS.join(', ')}`);
    if (sub === 'mcp') {
      await serve({ input: stdin, output: stdout, root: cwd, env, version: VERSION });
      return 0;
    }
    let result;
    if (sub === 'detect') result = detect(cwd);
    else {
      const timeoutMs = number(flags.timeout, 'timeout', 0) * 1000;
      const maxReruns = number(flags['max-reruns'], 'max-reruns', 10);
      result = await runTests({ cwd, filter: flags.filter, runner: flags.runner, command, timeoutMs, env, tee: flags.stream ? stderr : null });
      if (flags.rerun) result = await rerunFailures(result, { maxReruns, timeoutMs, env });
    }
    const json = flags.json || (!isTTY && !flags.text);
    stdout.write(`${json ? JSON.stringify(result, null, 2) : formatText(result)}\n`);
    return result.op === 'detect' ? (result.detected ? 0 : 2) : exitCode(result);
  } catch (err) {
    if (!(err instanceof UsageError || err instanceof SetupError)) throw err;
    stderr.write(`cli-test-summary: ${err.message}\n`);
    return 2;
  }
}
