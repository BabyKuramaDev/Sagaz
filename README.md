# Sagaz

> **Your agents can act. Can they undo?**

Sagaz is an open source MCP proxy that records every effect your agents produce in the world (the *effect ledger*), classifies each one by reversibility (**R**eversible / **C**ompensable / **I**rreversible), and gives you preview, checkpoint, rollback by compensation, and a kill switch.

One undo for everything your agent touched — including what no snapshot can reach.

![Sagaz demo — coming soon](docs/demo.gif)

## Status

Pre-alpha. Phase 0 (pass-through proxy + persistent ledger + read-only CLI) is under construction. See [`SPEC.md`](SPEC.md) for the vision, architecture, and roadmap.

## Development

Requires Node ≥ 20 and pnpm (the exact version is pinned in `package.json` → `packageManager`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build
pnpm test
node packages/cli/dist/index.js --version
```

## License

MIT
