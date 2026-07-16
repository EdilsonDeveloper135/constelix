# Repository Guidelines

## Project Structure & Module Organization

Constelix is a pnpm TypeScript monorepo:

- `apps/web/`: React, React Flow, Monaco, xterm.js, Zustand, and Vite dashboard.
- `apps/agent/`: CLI, Fastify/WebSocket server, indexer, SQLite, PTY, OpenAI, and Codex.
- `packages/contracts/`: shared Zod schemas and protocol types.
- `packages/analyzers/`: Tree-sitter analysis for JavaScript, TypeScript, and Python.
- `packages/graph-core/`: graph queries, deltas, paths, and pagination.
- `tests/e2e/`: Playwright flows; `tests/fixtures/` contains reproducible workspaces.
- `scripts/`: packaging, version checks, smoke tests, and benchmarks.
- `docs/`: protocol, threat model, and design notes.

Keep unit tests beside their implementation as `*.test.ts`.

## Build, Test, and Development Commands

Use Node.js 24 and pnpm 11.

- `pnpm install --frozen-lockfile`: install the locked dependency graph.
- `pnpm dev -- /absolute/project/path`: run agent and dashboard locally.
- `pnpm typecheck`: check all TypeScript projects.
- `pnpm test`: run Vitest unit and integration tests.
- `pnpm test:e2e`: run Playwright browser scenarios.
- `pnpm build`: build packages, apps, and bundled CLI assets.
- `pnpm benchmark`: verify indexing and PTY latency budgets.
- `pnpm smoke:package`: pack, install, and launch the production CLI.
- `pnpm check`: run version validation, typecheck, tests, and build.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, two-space indentation, double quotes, and semicolons. Prefer small typed modules and Zod validation at process or network boundaries. Use `camelCase` for functions and variables, `PascalCase` for React components, classes, and types, and descriptive filenames such as `workspaceGraph.ts`. There is no separate formatter or linter gate; match nearby code and run `git diff --check`.

## Testing Guidelines

Vitest covers contracts, analyzers, security, persistence, indexing, and runtime behavior. Playwright covers demo and connected-workspace flows. Add regression tests for every bug fix. Use temporary directories and deterministic fixtures; never depend on personal repositories, credentials, or network unless explicitly opt-in.

## Commit & Pull Request Guidelines

Checkpoint commits follow `vMAJOR.MINOR.PATCH - type: Summary`, for example `v0.0.2 - fix: Harden MVP protocol and persistence`. Follow `VERSIONING.md`, never reuse a version, and keep `VERSION`, package versions, `CHANGELOG.md`, and `KNOWN_ISSUES.md` synchronized. PRs should explain scope and risk, list commands run, link relevant issues, and include screenshots for visible UI changes. Do not push commits or tags without maintainer authorization.

## Security & Configuration

Never commit `.env` files, API keys, tokens, SQLite databases, build output, tarballs, or installed dependencies. Preserve loopback-only authentication, workspace path containment, atomic writes, secret redaction, and explicit per-turn approval for Codex.
