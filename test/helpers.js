import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const PROJECTS = path.join(FIXTURES, 'projects');

/** A captured runner output from test/fixtures/output. */
export const output = (name) => fs.readFileSync(path.join(FIXTURES, 'output', name), 'utf8');

/** A fresh folder with the given files, removed after the test. */
export function tmp(t, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-summary-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** A writable stream stand-in that keeps what was written. */
export function sink(isTTY = false) {
  const chunks = [];
  return {
    isTTY,
    write: (s) => chunks.push(String(s)),
    get text() {
      return chunks.join('');
    },
  };
}

/** A node script that plays a test runner: prints `out`, writes `files`, exits with `code`. */
export function fakeRunner(dir, { stdout = '', stderr = '', code = 0, files = {}, sleep = 0 }) {
  const script = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
for (const [f, c] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync(f.replace('$REPORT', process.env.REPORT ?? ''), c);
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
setTimeout(() => process.exit(${code}), ${sleep});
`,
  );
  return [process.execPath, script];
}
