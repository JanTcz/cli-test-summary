// The package and the plugin agree with each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as api from '../src/index.js';

const json = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const exists = (p) => fs.existsSync(new URL(`../${p}`, import.meta.url));
const pkg = json('package.json');

test('the entry point exports the API', () => {
  for (const name of ['RUNNERS', 'findProject', 'plan', 'detect', 'runTests', 'SetupError', 'rerunFailures', 'summarize', 'serve', 'handle', 'TOOLS', 'main', 'VERSION']) {
    assert.ok(name in api, name);
  }
});

test('both plugin manifests have the package version and point at files that exist', () => {
  const claude = json('agents/.claude-plugin/plugin.json');
  const codex = json('agents/.codex-plugin/plugin.json');
  for (const m of [claude, codex]) {
    assert.equal(m.name, pkg.name);
    assert.equal(m.version, pkg.version);
    assert.equal(m.license, pkg.license);
  }
  for (const p of [codex.skills, codex.mcpServers, codex.interface.composerIcon, codex.interface.logo]) {
    assert.match(p, /^\.\//);
    assert.ok(exists(`agents/${p.slice(2)}`), p);
  }
});

test("the MCP config runs this package's major version", () => {
  const server = json('agents/.mcp.json').mcpServers[pkg.name];
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', `${pkg.name}@${pkg.version.split('.')[0]}`, 'mcp']);
});

test('the skill has the frontmatter agents need and names the tools', () => {
  const skill = fs.readFileSync(new URL(`../agents/skills/${pkg.name}/SKILL.md`, import.meta.url), 'utf8');
  const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(fm);
  assert.equal(fm[1], pkg.name);
  assert.ok(fm[2].length < 1024);
  for (const tool of api.TOOLS) assert.ok(skill.includes(tool.name), tool.name);
});

test('the npm package ships the plugin and the reporter', () => {
  assert.deepEqual(pkg.files, ['src', 'bin', 'agents']);
  assert.equal(pkg.bin[pkg.name], './bin/cli-test-summary.js');
  assert.ok(exists('src/reporters/node.mjs'));
});
