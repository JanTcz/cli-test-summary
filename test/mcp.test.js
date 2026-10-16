import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PROTOCOL_VERSIONS, TOOLS, handle, inside, serve } from '../src/mcp.js';
import { SetupError } from '../src/run.js';
import { PROJECTS, sink, tmp } from './helpers.js';

const ctx = { root: PROJECTS, env: process.env, version: '9.9.9' };
const rpc = (method, params, id = 1, c = ctx) => handle({ jsonrpc: '2.0', id, method, params }, c);
const notify = (method, params) => handle({ jsonrpc: '2.0', method, params }, ctx);
const call = async (name, args, c) => (await rpc('tools/call', { name, arguments: args }, 1, c)).result;

test('initialize, ping, tools/list, unknown methods, notifications', async () => {
  const init = (await rpc('initialize', { protocolVersion: '2025-03-26' })).result;
  assert.equal(init.protocolVersion, '2025-03-26');
  assert.deepEqual(init.serverInfo, { name: 'cli-test-summary', version: '9.9.9' });
  assert.match(init.instructions, /run_tests/);
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal((await rpc('initialize')).result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.deepEqual(await rpc('ping'), { jsonrpc: '2.0', id: 1, result: {} });
  assert.deepEqual((await rpc('tools/list')).result.tools, TOOLS);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual((await rpc('resources/list')).error, { code: -32601, message: 'method not found: resources/list' });
  assert.equal(await notify('notifications/initialized'), undefined);
  assert.equal(await notify('tools/call', { name: 'nope' }), undefined);
  assert.equal(await rpc('ping', {}, null), undefined);
  assert.deepEqual((await rpc('tools/call', { name: 'nope' })).error, { code: -32602, message: 'unknown tool: nope' });
});

test('inside: the server stays in its root', () => {
  assert.equal(inside('/p'), '/p');
  assert.equal(inside('/p', 'a/b'), '/p/a/b');
  assert.throws(() => inside('/p', '../q'), SetupError);
  assert.throws(() => inside('/p', '/etc'), /outside/);
});

test('detect_tests and run_tests', async () => {
  const d = await call('detect_tests', { cwd: 'pytest' });
  assert.equal(d.structuredContent.runner, 'pytest');
  assert.deepEqual(JSON.parse(d.content[0].text), d.structuredContent);
  const r = await call('run_tests', { cwd: 'node-flaky', rerun: true, max_reruns: 1, timeout_s: 60 });
  assert.deepEqual(r.structuredContent.rerun, { real: 0, flaky: 1, unresolved: 0, not_rerun: 1 });
  assert.deepEqual((await call('run_tests', { cwd: 'node-flaky', rerun: true })).structuredContent.rerun, { real: 1, flaky: 1, unresolved: 0, not_rerun: 0 });
  const plain = await call('run_tests', { cwd: 'node-flaky', filter: 'fills the cache' });
  assert.equal(plain.structuredContent.ok, true);
  assert.equal(plain.structuredContent.rerun, undefined);
  const forced = await call('run_tests', { cwd: 'node-flaky', runner: 'node', filter: 'fills the cache' });
  assert.equal(forced.structuredContent.runner, 'node');
});

test('a setup error is a tool result with isError, anything else a JSON-RPC error', async (t) => {
  assert.deepEqual(await call('detect_tests', { cwd: '..' }), { content: [{ type: 'text', text: `cwd .. is outside ${PROJECTS}` }], isError: true });
  const dir = tmp(t, { 'go.mod': 'module m\n', 'bin/go': '' });
  const env = { ...process.env, PATH: path.join(dir, 'bin') };
  const missing = await call('run_tests', {}, { root: tmp(t, { 'go.mod': '' }), env: { ...process.env, PATH: '/nowhere' }, version: '1' });
  assert.match(missing.content[0].text, /go is not installed/);
  const broken = await rpc('tools/call', { name: 'run_tests', arguments: {} }, 1, { root: dir, env, version: '1' });
  assert.equal(broken.error.code, -32603);
  assert.ok(fs.existsSync(path.join(dir, 'bin', 'go')));
});

test('serve: one message per line, blank lines skipped, parse errors answered, root from CLAUDE_PROJECT_DIR', async () => {
  const output = sink();
  const input = Readable.from([
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n\n',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    'not json\n',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"detect_tests","arguments":{"cwd":"go"}}}\n',
  ]);
  await serve({ input, output, root: '/', env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECTS }, version: '1.0.0' });
  const replies = output.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((r) => r.id), [1, null, 2]);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[2].result.structuredContent.runner, 'go');
  const fallback = sink();
  await serve({ input: Readable.from(['{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"detect_tests","arguments":{"cwd":"cargo"}}}\n']), output: fallback, root: PROJECTS, env: {}, version: '1' });
  assert.equal(JSON.parse(fallback.text).result.structuredContent.runner, 'cargo');
});

test('serve: the process environment by default', async () => {
  const output = sink();
  await serve({ input: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']), output, root: PROJECTS, version: '1' });
  assert.deepEqual(JSON.parse(output.text).result, {});
});
