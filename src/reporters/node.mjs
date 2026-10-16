// A node:test reporter, loaded through NODE_OPTIONS: it appends one JSON line per
// finished test to the file in CLI_TEST_SUMMARY_NODE_OUT and prints nothing, so
// the project's own reporter keeps the terminal. Appending (not truncating) keeps
// the events of every `node --test` a test script runs.

import fs from 'node:fs';
import path from 'node:path';

/** The assertion behind node's ERR_TEST_FAILURE wrapper, as plain data. */
export function serialize(error) {
  if (!error) return null;
  const cause = error.code === 'ERR_TEST_FAILURE' && error.cause ? error.cause : error;
  if (typeof cause !== 'object') return { message: String(cause), stack: null };
  return { message: String(cause.message ?? ''), stack: typeof cause.stack === 'string' ? cause.stack : null };
}

/** A reporter that appends to `out`; node passes its own second argument, so `out` is bound here. */
export function createReporter(out) {
  return async function* reporter(source) {
  // test:start comes in declaration order, so it tells which suites a test is in.
  const ancestors = new Map();
  for await (const { type, data } of source) {
    if (!out) continue;
    const key = data?.file ?? '';
    if (type === 'test:start') {
      const stack = ancestors.get(key) ?? [];
      stack.length = data.nesting;
      stack.push(data.name);
      ancestors.set(key, stack);
      continue;
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const { name, nesting, file, line, skip, todo, details = {} } = data;
    const passed = type === 'test:pass';
    const record = {
      status: !passed ? (details.error?.failureType === 'cancelledByParent' ? 'cancelled' : 'failed') : skip !== undefined ? 'skipped' : todo !== undefined ? 'todo' : 'passed',
      name,
      path: (ancestors.get(key) ?? []).slice(0, nesting),
      file: file ?? null,
      line: line ?? null,
      suite: details.type === 'suite',
      // With process isolation a whole file is reported as a test named after it.
      whole_file: nesting === 0 && Boolean(file) && path.resolve(name) === file,
      error: passed ? null : serialize(details.error),
    };
    fs.appendFileSync(out, JSON.stringify(record) + '\n');
  }
  };
}

export default createReporter(process.env.CLI_TEST_SUMMARY_NODE_OUT);
