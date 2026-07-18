# Local protocol v1

Constelix uses authenticated JSON over REST for commands and snapshots, plus a single authenticated WebSocket for graph deltas, index progress, PTY bytes, Ask streaming, and Codex events.

Every body and event includes `protocolVersion: 1` and is validated with the schemas from `@constelix/contracts`.

## Bootstrap

The CLI opens `/#token=<capability>`. The dashboard stores the token in memory, removes the fragment with `history.replaceState`, and sends it as a bearer credential. Static assets are public on loopback; `/api/v1/*` is protected.

The WebSocket must receive `{ protocolVersion: 1, type: "authenticate", token }` as its first message within two seconds. The server then sends canonical `authenticated` and `connection.ready` envelopes. Legacy flattened messages are rejected.

## Bootstrap reconciliation

`GET /api/v1/bootstrap` is the authoritative reconnect snapshot. It returns the
bounded graph, saved layout, conversation, active Ask turn IDs, the active Act
task when one exists, recoverable terminal sessions, index status, and current
capabilities. The workspace descriptor includes a stable ID, summarized path,
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

## Ask modes

Ask is always available. With no API key, `started.mode` is `local` and
`completed.localResult` contains bounded symbol hits, signatures, relative
paths, snippets, and depth-one relations. These results are structural search,
not generated natural-language reasoning.

When an OpenAI turn fails with `INSUFFICIENT_QUOTA`, the agent emits a
`fallback` event with `discardPartial: true`, switches the session to Local,
and completes the same request without duplicating its user message.

## Terminal output recovery

`terminal.output` events include a monotonically increasing `sequence` per PTY session. The agent retains up to 256 KiB of recent output so a panel can recover bytes emitted while the terminal was being created or while its listener was reconnecting.

An authenticated `GET /api/v1/terminals/:id/output?after=<sequence>` returns the available chunks, `latestSequence`, and a `truncated` flag. The dashboard hydrates this snapshot before applying buffered live events and discards duplicate sequence numbers.

Terminal session payloads expose `cwd` relative to the workspace. In read mode,
the agent wraps the shell in a filesystem-write-denying macOS sandbox; if that
sandbox is unavailable, terminal creation fails with
`READ_ONLY_TERMINAL_UNAVAILABLE`.
