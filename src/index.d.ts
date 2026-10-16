export type Runner = 'node' | 'vitest' | 'jest' | 'pytest' | 'go' | 'cargo' | 'dotnet';

export const RUNNERS: readonly Runner[];
export const VERSION: string;

export interface Counts {
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  todo: number | null;
  cancelled: number | null;
}

export interface Failure {
  /** "suite › test", "tests/test_x.py::test_y", "pkg TestName", "Namespace.Class.Method" */
  name: string;
  /** Relative to the project when inside it. */
  file: string | null;
  line: number | null;
  /** The assertion and the frames that point at the test, runner internals dropped. */
  message: string;
  /** With rerun: how the failure behaved when run alone. */
  rerun?: 'real' | 'flaky' | 'unresolved' | null;
  rerun_reason?: string;
}

export interface Result {
  detected: true;
  /** The verdict: the command exited 0, in time, and no test failed. */
  ok: boolean;
  runner: Runner | null;
  /** What ran, as the project knows it (`npm test`), without the report flags. */
  command: string;
  /** Where it ran, relative to the folder asked about. */
  cwd: string;
  exit_code: number | null;
  duration_ms: number;
  /** Counts the runner reported; null where it didn't say (text output). */
  counts: Counts;
  failures: Failure[];
  /** Where counts and failures came from. */
  source: 'node-events' | 'jest-json' | 'junit' | 'go-json' | 'trx' | 'text' | 'none';
  /** Why the result is what it is, when the numbers alone could mislead. */
  note: string | null;
  /** The last lines of output, when not ok. */
  output_tail?: string;
  /** With rerun. */
  rerun?: { real: number; flaky: number; unresolved: number; not_rerun: number };
  verdict?: 'pass' | 'fail' | 'flaky';
}

export interface NotDetected {
  detected: false;
  ok: null;
  reason: string;
}

export interface RunOptions {
  cwd?: string;
  filter?: string;
  runner?: Runner;
  /** Run this instead of the detected command. */
  command?: string[];
  timeoutMs?: number;
  tee?: { write(chunk: unknown): unknown } | null;
  env?: Record<string, string | undefined>;
}

export class SetupError extends Error {}

export function runTests(opts?: RunOptions): Promise<Result | NotDetected>;
export function rerunFailures(result: Result | NotDetected, opts?: { maxReruns?: number; timeoutMs?: number; env?: Record<string, string | undefined> }): Promise<(Result | NotDetected) & { verdict: 'pass' | 'fail' | 'flaky' }>;

export function findProject(cwd: string, opts?: { maxDepth?: number }): { dir: string; runner: Runner; manifest: string; script?: string | null; packageManager?: string } | null;
export function detect(cwd: string): { op: 'detect'; detected: boolean; runner?: Runner; cwd?: string; command?: string; mode?: 'script' | 'direct'; report?: string; reason?: string };
export function plan(project: object, opts: { filter?: string; runner?: Runner; command?: string[]; reportDir: string; env?: object }): object | null;
export function summarize(run: { runner: string; report?: { format: string; content: string | string[] } | null; stdout: string; stderr: string; cwd: string }): { counts: Counts; failures: Failure[]; source: string };

export const TOOLS: { name: string; description: string; inputSchema: object }[];
export function handle(message: object, ctx: { root: string; env: object; version: string }): Promise<object | undefined>;
export function serve(opts: { input: NodeJS.ReadableStream; output: { write(s: string): unknown }; root: string; env?: object; version: string }): Promise<void>;
/** Runs the CLI; resolves to the exit code. */
export function main(args: string[], io?: object): Promise<number>;
