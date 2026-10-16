// Which project, which runner, which command. The project's own test command wins
// (`npm test` runs whatever the project calls its tests, coverage gates included);
// the runner is only invoked directly when there is no such command or a filter needs it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNERS = ['node', 'vitest', 'jest', 'pytest', 'go', 'cargo', 'dotnet'];

/** The script `npm init` writes: not a test command. */
const NPM_PLACEHOLDER = /no test specified/;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.tox',
  'dist', 'build', 'target', 'bin', 'obj', 'vendor', 'coverage', 'TestResults', '.idea', '.vs',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const exists = (dir, name) => fs.existsSync(path.join(dir, name));

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function packageManager(dir, pkg) {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager ?? '')?.[1];
  if (declared) return declared;
  if (exists(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(dir, 'yarn.lock')) return 'yarn';
  if (exists(dir, 'bun.lock') || exists(dir, 'bun.lockb')) return 'bun';
  return 'npm';
}

export function nodeRunner(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.test ?? '';
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bnode\b.*--test\b/.test(script)) return 'node';
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  return 'node';
}

/** What makes `dir` a project of one of the runners, or null. */
export function projectAt(dir) {
  if (exists(dir, 'package.json')) {
    const pkg = readJson(path.join(dir, 'package.json')) ?? {};
    const script = pkg.scripts?.test;
    return {
      dir,
      runner: nodeRunner(pkg),
      manifest: 'package.json',
      script: script && !NPM_PLACEHOLDER.test(script) ? script : null,
      packageManager: packageManager(dir, pkg),
    };
  }
  for (const [manifest, runner] of [['pyproject.toml', 'pytest'], ['pytest.ini', 'pytest'], ['setup.py', 'pytest'], ['setup.cfg', 'pytest'], ['go.mod', 'go'], ['Cargo.toml', 'cargo']]) {
    if (exists(dir, manifest)) return { dir, runner, manifest };
  }
  const entries = listDir(dir).filter((e) => e.isFile()).map((e) => e.name);
  const dotnet = entries.find((n) => /\.(sln|slnx)$/.test(n)) ?? entries.find((n) => /\.(cs|fs|vb)proj$/.test(n));
  return dotnet ? { dir, runner: 'dotnet', manifest: dotnet } : null;
}

/**
 * The project for `cwd`: the nearest one at or above it; else, for a folder that only
 * holds projects (a monorepo without a root manifest), the shallowest one below it.
 */
export function findProject(cwd, { maxDepth = 3 } = {}) {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    const found = projectAt(dir);
    if (found) return found;
    if (exists(dir, '.git') || path.dirname(dir) === dir) break;
  }
  const queue = [{ dir: start, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 0) {
      const found = projectAt(dir);
      if (found) return found;
    }
    if (depth === maxDepth) continue;
    for (const e of listDir(dir)) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

export const NODE_REPORTER = fileURLToPath(new URL('./reporters/node.mjs', import.meta.url));

/** A test script that runs one command and nothing else, so flags can be appended to it. */
export function isSingleCommand(script) {
  return !/&&|\|\||[;|&<>`]|\$\(/.test(script);
}

export function pythonCommand(dir, platform = process.platform) {
  if (exists(dir, 'uv.lock')) return ['uv', 'run', 'pytest'];
  if (exists(dir, 'poetry.lock')) return ['poetry', 'run', 'pytest'];
  if (exists(path.join(dir, '.venv', 'bin'), 'python')) return [path.join(dir, '.venv', 'bin', 'python'), '-m', 'pytest'];
  return [platform === 'win32' ? 'python' : 'python3', '-m', 'pytest'];
}

function runScript(pm, extra) {
  const base = pm === 'bun' ? ['bun', 'run', 'test'] : [pm, 'test'];
  return extra.length ? [...base, ...(pm === 'yarn' ? [] : ['--']), ...extra] : base;
}

/**
 * How to run the tests and where the structured report will be.
 *
 * @param {object} project   from findProject()
 * @param {{ filter?: string, runner?: string, command?: string[], reportDir: string, env?: object }} opts
 * @returns {{ runner: string, command: string[], shown: string[], cwd: string, env: object, report: { format: string, path: string|null } | null, mode: string }}
 *   `shown` is the command without the report flags we add: what the project runs.
 */
export function plan(project, { filter, runner: forced, command, reportDir, env = {} }) {
  const runner = forced ?? project.runner;
  const cwd = project.dir;
  const out = (name) => path.join(reportDir, name);
  const manifest = project.manifest ?? null;
  const result = (cmd, report, mode, extraEnv = {}, shown = cmd) => ({ runner, command: cmd, shown, cwd, manifest, env: { ...env, ...extraEnv }, report, mode });

  // node:test reports through NODE_OPTIONS whoever starts it, so it works inside any script.
  const nodeEnv = () => {
    const file = out('node-events.jsonl');
    const reporters = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${JSON.stringify(NODE_REPORTER)} --test-reporter-destination=stderr`;
    return {
      report: { format: 'node-events', path: file },
      env: { NODE_OPTIONS: [env.NODE_OPTIONS, reporters].filter(Boolean).join(' '), CLI_TEST_SUMMARY_NODE_OUT: file },
    };
  };
  const pytestEnv = () => {
    const file = out('junit.xml');
    return { report: { format: 'junit', path: file }, env: { PYTEST_ADDOPTS: [env.PYTEST_ADDOPTS, `--junitxml=${JSON.stringify(file)}`].filter(Boolean).join(' ') } };
  };

  // A command of your own: run it as is, with the reports that need no flags.
  if (command?.length) {
    const side = runner === 'node' ? nodeEnv() : runner === 'pytest' ? pytestEnv() : { report: null, env: {} };
    return result(command, side.report, 'command', side.env);
  }

  switch (runner) {
    case 'node':
    case 'vitest':
    case 'jest': {
      const { script, packageManager: pm } = project;
      // A script that picks its own node:test reporter keeps it; we read its text then.
      const node = runner === 'node' && !/--test-reporter/.test(script ?? '') ? nodeEnv() : { report: null, env: {} };
      if (script && !filter) {
        // Report flags only on a script that is one runner command; otherwise run it untouched.
        if (runner === 'vitest' && isSingleCommand(script)) {
          const file = out('vitest.json');
          return result(runScript(pm, ['--reporter=default', '--reporter=json', `--outputFile.json=${file}`]), { format: 'jest-json', path: file }, 'script', {}, runScript(pm, []));
        }
        if (runner === 'jest' && isSingleCommand(script)) {
          const file = out('jest.json');
          return result(runScript(pm, ['--json', `--outputFile=${file}`]), { format: 'jest-json', path: file }, 'script', {}, runScript(pm, []));
        }
        return result(runScript(pm, []), node.report, 'script', node.env);
      }
      if (runner === 'vitest') {
        const file = out('vitest.json');
        const t = filter ? ['-t', filter] : [];
        return result(['npx', '--no-install', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${file}`, ...t], { format: 'jest-json', path: file }, 'direct', {}, ['npx', 'vitest', 'run', ...t]);
      }
      if (runner === 'jest') {
        const file = out('jest.json');
        const t = filter ? ['-t', filter] : [];
        return result(['npx', '--no-install', 'jest', '--ci', '--json', `--outputFile=${file}`, ...t], { format: 'jest-json', path: file }, 'direct', {}, ['npx', 'jest', '--ci', ...t]);
      }
      return result([process.execPath, '--test', ...(filter ? [`--test-name-pattern=${filter}`] : [])], node.report, 'direct', node.env);
    }
    case 'pytest': {
      const py = pytestEnv();
      return result([...pythonCommand(cwd), ...(filter ? ['-k', filter] : [])], py.report, 'direct', py.env);
    }
    case 'go':
      // The report is stdout itself.
      return result(['go', 'test', '-json', './...', ...(filter ? ['-run', filter] : [])], { format: 'go-json', path: null }, 'direct');
    case 'cargo':
      return result(['cargo', 'test', ...(filter ? [filter] : [])], null, 'direct');
    case 'dotnet': {
      const dir = out('trx');
      const base = ['dotnet', 'test', ...(project.manifest ? [project.manifest] : [])];
      const f = filter ? ['--filter', filter] : [];
      return result([...base, '--logger', 'trx', '--results-directory', dir, ...f], { format: 'trx', path: dir }, 'direct', {}, [...base, ...f]);
    }
    default:
      return null;
  }
}

/** `detect`: the project and the command, without running anything. */
export function detect(cwd) {
  const project = findProject(cwd);
  if (!project) return { op: 'detect', detected: false, reason: `no test runner found in or around ${path.resolve(cwd)}` };
  const p = plan(project, { reportDir: '<report>' });
  return {
    op: 'detect',
    detected: true,
    runner: p.runner,
    cwd: path.relative(cwd, p.cwd).split(path.sep).join('/') || '.',
    command: p.shown.map((a) => (a === process.execPath ? 'node' : a)).join(' '),
    mode: p.mode,
    report: p.report?.format ?? 'text',
  };
}
