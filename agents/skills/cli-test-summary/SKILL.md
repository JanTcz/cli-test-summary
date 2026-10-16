---
name: cli-test-summary
description: Run the project's tests and read the result as data instead of reading test output. Use whenever you need to know whether tests pass - after a change, before saying work is done, when a test fails, or when you suspect a flaky test. Works for node:test, vitest, jest, pytest, go, cargo and dotnet.
---

# cli-test-summary

Use the `run_tests` MCP tool when it is available. Otherwise run the CLI:
`npx -y cli-test-summary@0 --json` (add `--cwd=<dir>`, `--filter=<pattern>`,
`--rerun`). It runs the project's own test command (`npm test`, `pytest`,
`go test ./...`, ...) and answers with JSON:

```json
{ "ok": false, "runner": "vitest", "command": "npm test",
  "counts": { "total": 42, "passed": 40, "failed": 2, "skipped": 0, ... },
  "failures": [ { "name": "math › subtracts", "file": "test/math.test.js", "line": 5,
                  "message": "AssertionError: expected 2 to be 1 ..." } ],
  "note": null }
```

## Rules

- **`ok` is the verdict.** Say tests pass only when `ok` is `true`. Report the
  counts and failures as the tool gives them, not your reading of the output.
- **Read `note`.** When it is set, the numbers alone mislead: the command
  failed outside the tests (coverage threshold, build, lint), it timed out, or
  no tests ran. `output_tail` has the last lines of output for that case.
- **Go to the failure.** Each failure has `file`, `line` and `message`: open
  that place before you change anything.
- **A filter is for iterating, not for the verdict.** `filter` runs the runner
  directly (not the project's test script, so no coverage gate). Before you say
  the work is done, run the whole suite without a filter.
- **Flaky needs evidence.** Never call a failure flaky from its look. Run with
  `rerun: true`: each failure runs again alone and comes back `real`, `flaky`
  (passed alone) or `unresolved` (could not be run alone). Only `flaky` is
  evidence, and a flaky test is still a bug to report. `unresolved` is never a pass.
- **No runner found** (`detected: false`): say so; don't guess a command.
  `detect_tests` (CLI: `detect`) shows what would run.
