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
capabilities. Live events that arrive after a bootstrap request take precedence
over that response.

## Revisions

Each committed index update increments the workspace revision. `GraphDelta.previousRevision` must match the client's revision; otherwise the client discards the delta and requests a fresh bootstrap. Snapshots and queries may be paginated; `truncated: true` can mean either more pages exist or the source index reached a configured safety limit.

## Streaming channels

- `index.progress`: scanning, parsing, resolving, persistence, counts, and completion.
- `graph.snapshot`: bounded provisional or committed graph views.
- `graph.delta`: revisioned semantic changes.
- `terminal.output` and `terminal.exit`: PTY lifecycle.
- `ask.event`: status, tool evidence, text deltas, canonical completion, and errors.
- `capabilities.updated`: asynchronous Codex compatibility results.
- `act.event`: approved task lifecycle and Codex activity.

Every server event uses `{ protocolVersion, eventId, timestamp, type, payload }`. REST bodies, WebSocket messages, and responses are validated at their boundary with shared Zod contracts.

## Terminal output recovery

`terminal.output` events include a monotonically increasing `sequence` per PTY session. The agent retains up to 256 KiB of recent output so a panel can recover bytes emitted while the terminal was being created or while its listener was reconnecting.

An authenticated `GET /api/v1/terminals/:id/output?after=<sequence>` returns the available chunks, `latestSequence`, and a `truncated` flag. The dashboard hydrates this snapshot before applying buffered live events and discards duplicate sequence numbers.
