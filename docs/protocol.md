# Local protocol v1

Constelix uses authenticated JSON over REST for commands and snapshots, plus a single authenticated WebSocket for graph deltas, index progress, PTY bytes, Ask streaming, and Codex events.

Every body and event includes `protocolVersion: 1` and is validated with the schemas from `@constelix/contracts`.

## Bootstrap

The CLI opens `/#token=<capability>`. The dashboard stores the token in memory, removes the fragment with `history.replaceState`, and sends it as a bearer credential. Static assets are public on loopback; `/api/v1/*` is protected.

The dashboard opens `/api/v1/events?token=<capability>`. Before completing the
WebSocket upgrade, the agent validates that query token together with the exact
`Origin` and `Host` for the active loopback endpoint. A missing or invalid token
is rejected during the HTTP handshake, so no anonymous transient socket exists.
After a successful upgrade the server sends `connection.ready`. The former
authenticate-as-first-message flow and legacy flattened messages are rejected.

## Bootstrap reconciliation

`GET /api/v1/bootstrap` is the authoritative reconnect snapshot. It returns the
bounded graph, saved layout, conversation, active Ask turn IDs, the active Act
task when one exists, recoverable terminal sessions, index status, and current
capabilities. Public LLM state can include its base URL, model, provider kind,
whether a key is configured or required, and the key source; it never includes
the key value. The workspace descriptor includes a stable ID, summarized path,
`mode: "read" | "edit"`, and the equivalent `readOnly: boolean`. Clients reject
inconsistent mode/boolean combinations. A bounded summary reports detected project types,
languages, estimated/indexed files, warnings, and omitted files. Live events
that arrive after a bootstrap request take precedence over that response.

The production scanner defaults to 10,000 eligible files, 2 MiB per file, and
2 MiB of aggregate source content. Files beyond those bounds are omitted from
the semantic index and reported through the summary instead of failing silently.
The reproducible 10,000-file performance benchmark uses an explicit internal
aggregate-budget override; the CLI does not expose that override.

Public Act task payloads contain only the typed `ActTask` contract. Internal
fields such as the canonical `workspaceRoot` are never serialized; the scope
uses the same summarized path exposed by bootstrap.

## Revisions

Each committed index update increments the workspace revision. `GraphDelta.previousRevision` must match the client's revision; otherwise the client discards the delta and requests a fresh bootstrap. Snapshots and queries may be paginated; `truncated: true` can mean either more pages exist or the source index reached a configured safety limit.

## Streaming channels

- `index.progress`: scanning, parsing, resolving, persistence, counts, project
  summary updates, and completion.
- `graph.snapshot`: bounded provisional or committed graph views.
- `graph.delta`: revisioned semantic changes.
- `terminal.output` and `terminal.exit`: PTY lifecycle.
- `ask.event`: explicit `local`/`openai` mode, tool evidence, text deltas,
  canonical completion, typed local results, quota fallback, and errors.
- `capabilities.updated`: asynchronous Ask provider state and Codex compatibility
  results; either capability family may update independently.
- `act.event`: approved task lifecycle and Codex activity.

Every server event uses `{ protocolVersion, eventId, timestamp, type, payload }`. REST bodies, WebSocket messages, and responses are validated at their boundary with shared Zod contracts.

## Panel placement and layout

Editor and Assistant can be docked on the right and Terminal can be docked at
the bottom. Docked panels render in viewport chrome outside React Flow, so pan,
zoom, fit-view, and semantic relayout do not transform them. Floating placement
remains available for every tool and keeps the prior canvas interaction model.
The layout contract persists each panel's placement, active dock tab, floating
size, resource, and visibility. Semantic graph positions remain a separate
concern and do not move when a fixed responsive dock is toggled.

Opening a semantic node's context menu is non-executing. A terminal is created
only after the client sends the existing terminal request from an explicit
menu action.

## LLM configuration

Authenticated `GET /api/v1/settings/llm` returns only the public configuration.
Authenticated `PUT /api/v1/settings/llm` accepts `protocolVersion`, `baseUrl`,
`model`, and a write-only key operation: `preserve`, `replace`, or `clear`. A
replacement includes the new value only in the request; no response, bootstrap,
event, database row, or log contains it.

Agent-entered credentials are stored outside the repository and SQLite in a
private `0600` file, transactionally paired with the provider URL through a
random identifier. A provider change with `preserve` deletes the prior stored
credential instead of forwarding it. The Settings form blocks writes while its
initial configuration is loading or failed, and exposes an explicit retry.

Defaults are `https://api.openai.com/v1` and `gpt-4o`. Remote endpoints require
HTTPS and a key. A key is optional only when the URL host is `localhost`,
`127.0.0.1`, or `::1`; `http://localhost:11434/v1` supports an Ollama-compatible
server. URLs with embedded credentials, query strings, fragments, unsupported
schemes, or cleartext remote hosts are rejected. Changes replace the active
provider configuration without exposing the previous credential.

## Ask modes

Ask is always available. With no usable LLM configuration, `started.mode` is `local` and
`completed.localResult` contains bounded symbol hits, signatures, relative
paths, snippets, and depth-one relations. These results are structural search,
not generated natural-language reasoning.

When a generated turn fails with `INSUFFICIENT_QUOTA`, `INVALID_API_KEY`,
`RATE_LIMITED`, or `NETWORK_UNAVAILABLE`, the agent emits a `fallback` event
with `discardPartial: true`, switches the same turn to Local, and completes it
without duplicating the user's message or losing prior conversation history.
The notice remains visible and actionable. Quota, rate-limit, connectivity, and
provider-timeout failures may retry the configured provider on the next turn;
an invalid key remains Local until configuration changes. Failures against an
Ollama URL instruct the user to verify that Ollama and the configured model are
available on the selected port. Partial remote output is not persisted as a
completed answer.

## Terminal output recovery

`terminal.output` events include a monotonically increasing `sequence` per PTY session. The agent retains up to 256 KiB of recent output so a panel can recover bytes emitted while the terminal was being created or while its listener was reconnecting.

An authenticated `GET /api/v1/terminals/:id/output?after=<sequence>` returns the available chunks, `latestSequence`, and a `truncated` flag. The dashboard hydrates this snapshot before applying buffered live events and discards duplicate sequence numbers.

Terminal session payloads expose `cwd` relative to the workspace. In read mode,
the agent wraps the shell in a filesystem-write-denying macOS sandbox; if that
sandbox is unavailable, terminal creation fails with
`READ_ONLY_TERMINAL_UNAVAILABLE`.
