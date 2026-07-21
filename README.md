# Constelix

Constelix is a local-first visual software engineering workspace. It turns a JavaScript, TypeScript, or Python repository into a live semantic graph with code, terminals, project context, and AI in one persistent workspace.

## Requirements

- macOS
- Node.js 24 LTS
- pnpm 11
- Codex CLI 0.144.5 for **Act** mode
- Optional OpenAI-compatible LLM endpoint for generated answers. The default
  remote endpoint requires a key; loopback endpoints such as Ollama do not.

Without an available LLM, Constelix uses **Ask Local**, an offline structural
search over symbols, paths, signatures, snippets, and graph relations.

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

Editor and Assistant can dock on the right and Terminal can dock at the bottom,
outside the transformable semantic canvas. Each panel can return to floating
canvas mode, and the selected placement persists with the workspace layout.

## LLM settings

Open **Settings** in the dashboard to configure:

- `LLM_BASE_URL`: `https://api.openai.com/v1` by default.
- `LLM_MODEL`: `gpt-4o` by default.
- `LLM_API_KEY`: write-only and required for remote endpoints; optional only
  for `localhost`, `127.0.0.1`, and `::1` endpoints.

For Ollama, start the local daemon and use, for example,
`http://localhost:11434/v1` with `qwen2.5-coder`. Constelix never returns a
saved key to the browser. The agent stores a UI-provided key in a dedicated
private file, outside the repository and SQLite, and excludes it from logs and
child-process environments.

Development can instead provide these values in an ignored `.env.local`:

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o
LLM_API_KEY=
```

Legacy `OPENAI_API_KEY` and `CONSTELIX_OPENAI_MODEL` aliases remain supported
when their preferred variables are unset.

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
npm install --global ./apps/agent/constelix-agent-0.0.4.tgz
constelix /absolute/path/to/a/project
```

The package requires Node.js 24 on macOS. The production agent binds to a random loopback port, serves its bundled dashboard, and opens a capability URL whose token is removed from browser history immediately after bootstrap. The capability URL is never printed to stdout or logs.

## Local-first boundaries

- The repository and semantic index stay local. A remote LLM receives only the
  bounded evidence and snippets selected by the agent for that turn; an Ollama
  loopback endpoint keeps those requests on the machine.
- Workspace data is stored under macOS Application Support, never inside the opened repository.
- An entered LLM credential travels once to the loopback agent, is never
  returned or persisted by the browser, and never enters SQLite, logs, the
  terminal environment, or the Codex environment. The agent stores it outside
  the repository in a private `0600` file bound to its provider URL; see the
  threat model for the same-macOS-user residual risk.
- Ask Local works offline and completes the same turn when a remote or local
  LLM fails because of quota, credentials, rate limiting, or connectivity.
- WebSocket connections authenticate their query token during the HTTP upgrade,
  together with exact `Origin` and `Host` validation.
- Act mode requires one explicit approval per turn and denies writes outside the opened workspace.
- Read-only workspaces block editor writes and Act, and run terminals through a macOS filesystem-write sandbox.
- Terminal and Codex child environments use an allowlist that excludes API keys, approval tokens, and credential variables.
- The dashboard shows project detection, indexing limits, access mode, AI mode, Codex status, canvas filters, and recoverable errors.
- Default indexing is bounded to 10,000 eligible files, 2 MiB per source file,
  and 2 MiB of aggregate source content; omitted files and truncation warnings
  remain visible in onboarding.

See [the threat model](docs/threat-model.md) and [local protocol](docs/protocol.md) for implementation details.

Version checkpoints follow [VERSIONING.md](VERSIONING.md). Current limitations are tracked in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
