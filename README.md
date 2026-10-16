<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="cli-test-summary" height="56">
  </picture>
</h1>

[![test](https://github.com/JanTcz/cli-test-summary/actions/workflows/test.yml/badge.svg)](https://github.com/JanTcz/cli-test-summary/actions/workflows/test.yml)
[![coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/JanTcz/cli-test-summary/actions/workflows/test.yml "Lines, branches and functions of src/; npm test fails below 100 %")
[![npm](https://img.shields.io/npm/v/cli-test-summary)](https://www.npmjs.com/package/cli-test-summary)
[![Socket Badge](https://socket.dev/api/badge/npm/package/cli-test-summary)](https://socket.dev/npm/package/cli-test-summary)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Run a project's tests, get one JSON answer.** It finds the project and its
runner, runs the project's own test command and reads the runner's
machine-readable report:

```json
{
  "ok": false,
  "runner": "vitest",
  "command": "npm test",
  "counts": { "total": 42, "passed": 40, "failed": 1, "skipped": 1, "todo": 0, "cancelled": 0 },
  "failures": [
    {
      "name": "math › subtracts",
      "file": "test/math.test.js",
      "line": 5,
      "message": "AssertionError: expected 2 to be 1 // Object.is equality\n    at test/math.test.js:5:41"
    }
  ],
  "note": null
}
```

**node:test, vitest, jest, pytest, go, cargo and dotnet**, one shape for all
of them. Made for coding agents, which otherwise read hundreds of lines of
test output and count. It's good at counting, and that's where it goes wrong:
a failure scrolled past, a coverage gate taken for a test failure, a real
failure waved through as "probably flaky".

- **The project's command, not a guess.** `npm test` (or pnpm, yarn, bun) when
  there is a test script, so its coverage gate, build step and flags count;
  the runner directly only when there is none. `pytest`, `go test ./...`,
  `cargo test`, `dotnet test` otherwise.
- **Reports, not scraped text.** The runners' own JSON, JUnit, TRX and event
  streams, switched on without changing the command where possible (an
  environment variable for node:test and pytest). Text is the fallback.
- **An honest verdict.** `ok` is the exit code of that command; a `note` says
  when the numbers alone would mislead: the command failed with no test
  failing (a coverage threshold, a build error), it passed while reporting
  failures (`|| true`), nothing ran, or it timed out.
- **Real or flaky, with evidence.** `--rerun` runs every failure again on its
  own: `real` (fails alone too), `flaky` (passes alone) or `unresolved`
  (couldn't be run alone, never counted as a pass).
- **A CLI the agent runs in its shell, and a plugin for Claude Code and Codex**:
  a skill that tells the agent when to run it and how to read the result. No
  dependencies, Node 20+. (An MCP server too, for clients without a shell.)

## Getting started

The plugin is a skill: it has the agent run `npx -y cli-test-summary@0 --json`
in its shell instead of the test command, and read the JSON by its rules
(`ok` is the verdict, flaky needs a rerun, a filter is not a verdict).

### Claude Code

```
/plugin marketplace add JanTcz/marketplace
/plugin install cli-test-summary@jantcz
```

To let it run without asking each time, allow
`Bash(npx -y cli-test-summary@0:*)` in `/permissions`. It runs the project's
test command, which runs the project's code, same as `npm test` would.

### Codex

```bash
codex plugin marketplace add JanTcz/marketplace
```

then enable `cli-test-summary@jantcz` in the plugin list (or in
`.codex/config.toml`: `[plugins."cli-test-summary@jantcz"]` with `enabled = true`).

### Other agents

The skill is plain [Agent Skills](https://agentskills.io) Markdown: copy
[`agents/skills/cli-test-summary/`](agents/skills/cli-test-summary/SKILL.md)
into the agent's skills folder.

### The CLI

```bash
npx cli-test-summary                    # JSON on a pipe, a summary on a terminal
npx cli-test-summary --rerun            # and re-run each failure alone
npx cli-test-summary detect             # what would run, without running it
```

```
✖ 2 failed · 1 passed   node · npm test · 0.2 s
  ✖ reads a clean cache  test/order.test.js:11  [flaky]
      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
      1 !== 0
  ✖ really broken  test/order.test.js:15  [real]
      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
      1 !== 2
```

## What runs, and where the numbers come from

| Runner | Found by | Runs | Report |
|---|---|---|---|
| node:test | `package.json` (default) | `npm test`, else `node --test` | events from a reporter loaded through `NODE_OPTIONS`, inside any script |
| vitest | `vitest` in the test script or dependencies | `npm test`, else `npx vitest run` | `--reporter=json` when the script is one command; else the text |
| jest | `jest` in the test script or dependencies | `npm test`, else `npx jest --ci` | `--json` when the script is one command; else the text |
| pytest | `pyproject.toml`, `pytest.ini`, `setup.py`, `setup.cfg` | `uv run pytest`, `poetry run pytest`, `.venv` or `python3 -m pytest` | JUnit XML through `PYTEST_ADDOPTS` |
| go | `go.mod` | `go test -json ./...` | the JSON event stream, build errors included |
| cargo | `Cargo.toml` | `cargo test` | the text: libtest's JSON output is nightly-only |
| dotnet | `*.sln`, `*.slnx`, `*.csproj`, `*.fsproj`, `*.vbproj` | `dotnet test` | TRX |

The project is the nearest one at or above `--cwd`, stopping at the git
repository root; a folder that only holds projects (a monorepo without a root
manifest) gets the shallowest one below it. npm, pnpm, yarn and bun come from
`packageManager` or the lockfile.

`source` in the result says what the counts were read from (`node-events`,
`jest-json`, `junit`, `go-json`, `trx`, `text` or `none`). Counts the runner
didn't report are `null`, never a guess.

## The result

| Field | |
|---|---|
| `ok` | The verdict: the command exited 0, in time, and no test failed |
| `runner`, `command`, `cwd` | What ran and where; `command` as the project knows it, without the report flags |
| `exit_code`, `duration_ms` | Of the command |
| `counts` | `total`, `passed`, `failed`, `skipped`, `todo`, `cancelled` (node:test cancels tests whose hook failed) |
| `failures` | `name`, `file`, `line`, `message`: the assertion and the stack frames in your code; paths relative to the project |
| `note` | Set when the numbers alone would mislead (see above) |
| `output_tail` | The last 60 lines of output, when not `ok` |
| `rerun`, `verdict` | With `--rerun`: counts of `real`, `flaky`, `unresolved`, `not_rerun`, and `pass`, `fail` or `flaky` |

Failing hooks and files that don't load are failures too (named after the
suite or the file), but not tests, so they're not in `counts`.

Exit codes: `0` passed (with `--rerun`, also when every failure was flaky and
nothing else failed), `1` failed, `2` nothing to run, the runner isn't
installed, or bad arguments.

## Flaky or real

A test that fails in the full run can fail because of the code or because of
the run: test order, shared state, parallelism, timing. `--rerun` (`rerun: true`
in MCP) runs each failure alone, by name, in its own process:

| Runner | Alone |
|---|---|
| node:test | `node --test --test-name-pattern=<name> <file>` |
| vitest, jest | `vitest run <file> -t ^<full name>$`, `jest <file> -t ^<full name>$` |
| pytest | `pytest <node id>` |
| go | `go test -run ^Test$/^sub$ <package>` |
| cargo | `cargo test <path> -- --exact` |
| dotnet | `dotnet test --filter FullyQualifiedName=<name>` |

`real` when it fails again, `flaky` only when it ran and passed, and
`unresolved` otherwise: a file that only loads through the project's test
script, a build failure, a name the runner can't select. The verdict is
`flaky` only when every failure was flaky and nothing else failed the run.
The same agent that wants the suite green runs the rerun, so `unresolved` is
never a pass and a flaky test is still a bug to report.

## CLI

```
cli-test-summary [run] [--flags] [-- command ...]
cli-test-summary detect [--cwd=dir]
cli-test-summary mcp
```

| Flag | |
|---|---|
| `--cwd=dir` | Where to look for the project (default: here) |
| `--filter=pattern` | Only tests matching it. Runs the runner directly, not the test script (no coverage gate): for iterating, not for the verdict |
| `--runner=name` | Skip detection |
| `--rerun`, `--max-reruns=10` | Re-run failures alone |
| `--timeout=secs` | Stop the run after this long |
| `--stream` | Also print the runner's output to stderr as it runs |
| `--json`, `--text` | Force the output format |
| `-- command ...` | Run this instead (`-- make test`); node:test and pytest reports still work, other runners are read from the text |

## MCP, for clients without a shell

An agent with a shell needs nothing more than the CLI: the plugin doesn't
start a server. For a client that can only call MCP tools,
`cli-test-summary mcp` speaks MCP over stdio (protocol versions 2024-11-05 to
2025-06-18):

```json
{
  "mcpServers": {
    "cli-test-summary": { "command": "npx", "args": ["-y", "cli-test-summary@0", "mcp"] }
  }
}
```


| Tool | |
|---|---|
| `run_tests` | `cwd`, `filter`, `runner`, `rerun`, `max_reruns`, `timeout_s` (default 1800). The result as text and `structuredContent` |
| `detect_tests` | `cwd`. What would run |

The server only runs what detection finds: there is no tool to run a command
of the caller's choosing, and `cwd` must be inside the project
(`CLAUDE_PROJECT_DIR`, else the server's working directory). It adds nothing
the agent's own shell permissions wouldn't allow.

## As a library

```js
import { runTests, rerunFailures } from 'cli-test-summary';

const result = await rerunFailures(await runTests({ cwd: 'packages/api' }));
if (!result.ok) console.log(result.failures.map((f) => `${f.file}:${f.line} ${f.name} [${f.rerun}]`));
```

Types are in `src/index.d.ts`.

## This repository

```
src/detect.js           the project, the runner, the command
src/run.js              runs it, the verdict and the note
src/parse.js            reports and text into counts and failures, for every runner
src/rerun.js            each failure alone: real, flaky, unresolved
src/reporters/node.mjs  the node:test reporter loaded through NODE_OPTIONS
src/cli.js src/mcp.js   the command and the MCP server
agents/                 the plugin: the skill, Claude Code and Codex manifests
test/fixtures/          a tiny project per runner, and what the runners really printed
```

```bash
npm test                  # unit tests; fails below 100 % lines, branches or functions
npm run test:integration  # the real runners on test/fixtures/projects (skips what isn't installed)
```

The parsers are tested against output the real runners printed
(`test/fixtures/output/`, captured with their current versions, Go, Rust and
.NET in their official Docker images); CI runs all seven runners on the
fixture projects on every push.

### Releasing

Bump `version` in `package.json` and both `agents/*/plugin.json`, then push a
tag `v<version>`. `.github/workflows/release.yml` checks that the tag and the
three versions match, runs the tests and publishes to npm with provenance
(Trusted Publishing, no token in the repository).

## Origin

cli-test-summary started as the `test-summary` and `test-rerun` commands of a
larger agent framework, after an agent called a real failure a "parallel
flake" and moved on. This is a rewrite on its own: the runners' reports
instead of scraped text, the project's own test command, and a rerun for
every runner.

## License

[MIT](LICENSE) © 2026 Jan Truhlar
