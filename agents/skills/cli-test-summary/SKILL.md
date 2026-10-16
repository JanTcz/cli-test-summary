---
name: cli-test-summary
description: Run the project's tests and read the result as JSON instead of reading test output. Use whenever you need to know whether tests pass - after a change, before saying work is done, when a test fails, or when you suspect a flaky test. Works for node:test, vitest, jest, pytest, go, cargo and dotnet.
---

# cli-test-summary

Run the tests with the CLI instead of the project's test command:

```bash
npx -y cli-test-summary@0 --json                     # the whole suite
npx -y cli-test-summary@0 --json --cwd=packages/api  # a project below the current folder
npx -y cli-test-summary@0 --json --filter='adds'     # only matching tests, while iterating
npx -y cli-test-summary@0 --json --rerun             # re-run each failure alone
npx -y cli-test-summary@0 detect                     # what would run, without running it
```

It finds the project and runs its own test command (`npm test`, `pytest`,
`go test ./...`, ...), then prints one JSON object:

```json
{ "ok": false, "runner": "vitest", "command": "npm test",
  "counts": { "total": 42, "passed": 40, "failed": 2, "skipped": 0, ... },
  "failures": [ { "name": "math › subtracts", "file": "test/math.test.js", "line": 5,
                  "message": "AssertionError: expected 2 to be 1 ..." } ],
  "note": null }
```

Exit code: 0 passed, 1 failed, 2 nothing to run or the runner is not installed.
Read the whole JSON; don't pipe it through `head` or `tail`.

## Rules

- **`ok` is the verdict.** Say tests pass only when `ok` is `true`. Report the
  counts and failures as the tool gives them, not your reading of the output.
- **Read `note`.** When it is set, the numbers alone mislead: the command
  failed outside the tests (coverage threshold, build, lint), it timed out, or
  no tests ran. `output_tail` has the last lines of output for that case.
- **Go to the failure.** Each failure has `file`, `line` and `message`: open
  that place before you change anything.
- **A filter is for iterating, not for the verdict.** `--filter` runs the
  runner directly (not the project's test script, so no coverage gate). Before
  you say the work is done, run the whole suite without a filter.
- **Flaky needs evidence.** Never call a failure flaky from its look. Run with
  `--rerun`: each failure runs again alone and comes back `real`, `flaky`
  (passed alone) or `unresolved` (could not be run alone). Only `flaky` is
  evidence, and a flaky test is still a bug to report. `unresolved` is never a pass.
- **Nothing to run** (`detected: false`): say so; don't guess a command.
