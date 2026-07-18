# Constelix

Constelix is a local-first visual software engineering workspace. It turns a JavaScript, TypeScript, or Python repository into a live semantic graph where code, terminals, project context, and AI can share one canvas.

## Requirements

- macOS
- Node.js 24 LTS
- pnpm 11
- Codex CLI 0.144.5 for **Act** mode
- Optional `OPENAI_API_KEY` for generated **Ask OpenAI** answers (`.env.local` is loaded only by the development CLI)

Without a key, Constelix uses **Ask Local**, an offline structural search over
symbols, paths, signatures, snippets, and graph relations. Ask OpenAI defaults
to `gpt-5.6-terra`; override it locally with `CONSTELIX_OPENAI_MODEL`.

## Development

```bash
pnpm install
pnpm dev -- /absolute/path/to/a/project
```

The web dashboard runs on `http://127.0.0.1:5173` and proxies its local protocol to the agent on `http://127.0.0.1:4321` during development.

The CLI canonicalizes external folders, detects whether they are writable, and
opens them in **Modo Edición** or **Modo Lectura**. Force the safer mode with:

```bash
constelix --read-only /absolute/path/to/a/project
```

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
npm install --global ./apps/agent/constelix-agent-0.0.3.tgz
constelix /absolute/path/to/a/project
```

The package requires Node.js 24 on macOS. The production agent binds to a random loopback port, serves its bundled dashboard, and opens a capability URL whose token is removed from browser history immediately after bootstrap. The capability URL is never printed to stdout or logs.

## Local-first boundaries

- The repository and semantic index stay local. Ask OpenAI transmits only the
  bounded evidence and snippets selected by the agent for that turn.
- Workspace data is stored under macOS Application Support, never inside the opened repository.
- The OpenAI key is loaded only by the agent process.
- Ask Local works offline and becomes the same-turn fallback when OpenAI has no
  available quota.
- Act mode requires one explicit approval per turn and denies writes outside the opened workspace.
- Read-only workspaces block editor writes and Act, and run terminals through a macOS filesystem-write sandbox.
- Terminal and Codex child environments use an allowlist that excludes API keys, approval tokens, and credential variables.
- The dashboard shows project detection, indexing limits, access mode, AI mode, Codex status, canvas filters, and recoverable errors.
- Default indexing is bounded to 10,000 eligible files, 2 MiB per source file,
  and 2 MiB of aggregate source content; omitted files and truncation warnings
  remain visible in onboarding.

See [the threat model](docs/threat-model.md) and [local protocol](docs/protocol.md) for implementation details.

Version checkpoints follow [VERSIONING.md](VERSIONING.md). Current limitations are tracked in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
