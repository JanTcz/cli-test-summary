# Fixtures

`projects/` are tiny projects for every runner, each with a test that passes, one
that fails and one that is skipped. `output/` is what those runners really
printed: structured (JSON, JUnit, TRX, node events from `src/reporters/node.mjs`)
and as text, captured with the runners' current versions (Go and Rust and .NET in
their official Docker images). Absolute paths are rewritten to `/work/<runner>`.

The parsers are tested against these files; CI runs the real runners against
`projects/` too.
