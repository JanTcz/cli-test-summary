// An MCP server on stdio (JSON-RPC 2.0, one message per line), with no dependencies.
// It runs only what detection finds (the project's test command); there is no tool to
// run a command of the caller's choosing, so it adds nothing the agent's shell rules don't allow.

import path from 'node:path';
import readline from 'node:readline';
import { RUNNERS, detect } from './detect.js';
import { rerunFailures } from './rerun.js';
import { SetupError, runTests } from './run.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  "Run the project's tests with run_tests instead of a shell command, and report its counts and failures, not your reading of the output. " +
  'ok is the verdict. Before calling a failure flaky, run it again with rerun: true; only rerun "flaky" is evidence, "unresolved" is not.';

const cwd = { type: 'string', description: "A folder inside the project (default: the project root). Must be inside the server's root." };

export const TOOLS = [
  {
    name: 'run_tests',
    description:
      "Run the project's tests (its own test command, e.g. npm test, coverage gates included) and get pass/fail counts and every failure with file, line and message. " +
      'With rerun, each failure is run again alone: real, flaky or unresolved.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd,
        filter: { type: 'string', description: 'Only tests whose name matches (runs the runner directly, not the test script)' },
        runner: { type: 'string', enum: RUNNERS, description: 'Skip detection' },
        rerun: { type: 'boolean', description: 'Re-run each failure alone to tell real from flaky' },
        max_reruns: { type: 'integer', minimum: 0, description: 'Default 10' },
        timeout_s: { type: 'number', minimum: 0, description: 'Stop the run after this long (default 1800)' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'detect_tests',
    description: 'Which runner and which command run_tests would use, without running anything.',
    inputSchema: { type: 'object', properties: { cwd }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A folder inside the root, or an error: the server does not wander off the project. */
export function inside(root, dir = '.') {
  const resolved = path.resolve(root, dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new SetupError(`cwd ${dir} is outside ${root}`);
  return resolved;
}

async function callTool(name, args, ctx) {
  try {
    let result;
    if (name === 'detect_tests') result = detect(inside(ctx.root, args.cwd));
    else if (name === 'run_tests') {
      const timeoutMs = (args.timeout_s ?? 1800) * 1000;
      result = await runTests({ cwd: inside(ctx.root, args.cwd), filter: args.filter, runner: args.runner, timeoutMs, env: ctx.env });
      if (args.rerun) result = await rerunFailures(result, { maxReruns: args.max_reruns ?? 10, timeoutMs, env: ctx.env });
    } else throw new RpcError(-32602, `unknown tool: ${name}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (!(err instanceof SetupError)) throw new RpcError(-32603, err.message);
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}

/** Answers one JSON-RPC message; undefined for a notification. */
export async function handle(message, ctx) {
  const { id, method, params = {} } = message;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'cli-test-summary', version: ctx.version },
        instructions: INSTRUCTIONS,
      };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') result = await callTool(params.name, params.arguments ?? {}, ctx);
    else if (isRequest) throw new RpcError(-32601, `method not found: ${method}`);
    return isRequest ? { jsonrpc: '2.0', id, result } : undefined;
  } catch (err) {
    return isRequest ? { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } } : undefined;
  }
}

/** Serves until the input ends; requests run one after another, in order. */
export async function serve({ input, output, root, env = process.env, version }) {
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const ctx = { root: path.resolve(env.CLAUDE_PROJECT_DIR || root), env, version };
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    const reply = await handle(message, ctx);
    if (reply) send(reply);
  }
}
