# The cli-test-summary plugin

One folder for every coding agent: the `cli-test-summary` skill
(`skills/cli-test-summary/SKILL.md`, Agent Skills standard) and the MCP server
(`.mcp.json`, which runs `npx -y cli-test-summary@0 mcp`).

| Agent | Manifest | Install |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | `/plugin marketplace add JanTcz/marketplace`, then `/plugin install cli-test-summary@jantcz` |
| Codex | `.codex-plugin/plugin.json` | `codex plugin marketplace add JanTcz/marketplace`, then enable `cli-test-summary@jantcz` |
| Others | none | copy `skills/cli-test-summary/` into the agent's skills folder and the server from `.mcp.json` into its MCP config |

The marketplace that lists it is [JanTcz/marketplace](https://github.com/JanTcz/marketplace).
