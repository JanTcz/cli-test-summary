// The real runners on the fixture projects: what the parsers were written against, run
// end to end. A runner that isn't installed is skipped, unless CLI_TEST_SUMMARY_REQUIRE
// names it (CI requires all of them).
//
//   npm run test:integration
//   CLI_TEST_SUMMARY_REQUIRE=vitest,jest,pytest,go,cargo,dotnet npm run test:integration

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pythonCommand } from '../../src/detect.js';
import { rerunFailures } from '../../src/rerun.js';
import { runTests } from '../../src/run.js';
import { PROJECTS } from '../helpers.js';

const required = new Set((process.env.CLI_TEST_SUMMARY_REQUIRE ?? '').split(',').filter(Boolean));

const available = {
  vitest: () => fs.existsSync(path.join(PROJECTS, 'vitest', 'node_modules', '.bin', 'vitest')),
  jest: () => fs.existsSync(path.join(PROJECTS, 'jest', 'node_modules', '.bin', 'jest')),
  pytest: () => spawnSync(pythonCommand(PROJECTS)[0], ['-m', 'pytest', '--version']).status === 0,
  go: () => spawnSync('go', ['version']).status === 0,
  cargo: () => spawnSync('cargo', ['--version']).status === 0,
  dotnet: () => spawnSync('dotnet', ['--version']).status === 0,
};

const CASES = [
  ['vitest', 'math › subtracts', 'test/math.test.js', 5, /expected 2 to be 1/],
  ['jest', 'math › subtracts', 'test/math.test.js', 3, /Expected: 1\s+Received: 2/],
  ['pytest', 'tests/test_math.py::test_subtracts', 'tests/test_math.py', 9, /assert \(3 - 1\) == 1/],
  ['go', 'example.com/fixture/mathx TestSubtracts', 'mathx/math_test.go', 13, /3 - 1 = 2, want 1/],
  ['cargo', 'math::subtracts', 'src/lib.rs', 10, /left: 2\n right: 1/],
  ['dotnet', 'MathTests.Subtracts', 'MathTests.cs', 9, /Expected: 1\nActual: {3}2/],
];

for (const [runner, name, file, line, message] of CASES) {
  test(`${runner}: counts, the failure, and a rerun that calls it real`, { timeout: 600_000 }, async (t) => {
    if (!available[runner]()) {
      assert.ok(!required.has(runner), `${runner} is required but not installed`);
      t.skip(`${runner} is not installed`);
      return;
    }
    const result = await rerunFailures(await runTests({ cwd: path.join(PROJECTS, runner) }));
    assert.equal(result.runner, runner);
    assert.equal(result.ok, false);
    assert.deepEqual(result.counts, { total: 3, passed: 1, failed: 1, skipped: 1, todo: 0, cancelled: 0 }, JSON.stringify(result, null, 2));
    assert.equal(result.failures.length, 1);
    const [f] = result.failures;
    assert.deepEqual([f.name, f.file, f.line], [name, file, line]);
    assert.match(f.message, message);
    assert.equal(f.rerun, 'real', JSON.stringify(f));
    assert.equal(result.verdict, 'fail');
    assert.notEqual(result.source, 'none');
  });
}
