# Constelix

Constelix is a local-first visual software engineering workspace. It turns a JavaScript, TypeScript, or Python repository into a live semantic graph where code, terminals, project context, and AI can share one canvas.

## Requirements

- macOS
- Node.js 24 LTS
- pnpm 11
- Codex CLI 0.144.5 for **Act** mode
- `OPENAI_API_KEY` in the process environment for **Ask** mode (`.env.local` is loaded only by the development CLI)

Ask defaults to `gpt-5.6-terra`; override it locally with `CONSTELIX_OPENAI_MODEL` when needed.

## Development

```bash
pnpm install
pnpm dev -- /absolute/path/to/a/project
```

The web dashboard runs on `http://127.0.0.1:5173` and proxies its local protocol to the agent on `http://127.0.0.1:4321` during development.

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm benchmark
pnpm smoke:package
```

The real Codex sandbox smoke is opt-in because it starts an approved local
agent turn:

```bash
CONSTELIX_CODEX_SMOKE_APPROVED=1 pnpm smoke:codex
```

## Production CLI

```bash
pnpm build
pnpm --filter @constelix/agent pack
npm install --global ./apps/agent/constelix-agent-0.0.2.tgz
constelix /absolute/path/to/a/project
```

The package requires Node.js 24 on macOS. The production agent binds to a random loopback port, serves its bundled dashboard, and opens a capability URL whose token is removed from browser history immediately after bootstrap.

## Local-first boundaries

- Project files and indexes stay on the machine.
- Workspace data is stored under macOS Application Support, never inside the opened repository.
- The OpenAI key is loaded only by the agent process.
- Ask mode sends only selected graph evidence and snippets.
- Act mode requires one explicit approval per turn and denies writes outside the opened workspace.
- Manual terminals are user-controlled and intentionally unrestricted.

See [the threat model](docs/threat-model.md) and [local protocol](docs/protocol.md) for implementation details.

Version checkpoints follow [VERSIONING.md](VERSIONING.md). Current limitations are tracked in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
