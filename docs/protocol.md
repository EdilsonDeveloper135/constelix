# Local protocol v1

Constelix uses authenticated JSON over REST for commands and snapshots, plus a single authenticated WebSocket for graph deltas, index progress, PTY bytes, Ask streaming, and Codex events.

Every body and event includes `protocolVersion: 1` and is validated with the schemas from `@constelix/contracts`.

## Bootstrap

The CLI opens `/#token=<capability>`. The dashboard stores the token in memory, removes the fragment with `history.replaceState`, and sends it as a bearer credential. Static assets are public on loopback; `/api/v1/*` is protected.

## Revisions

Each committed index update increments the workspace revision. `GraphDelta.fromRevision` must match the client's revision; otherwise the client discards the delta and requests a fresh snapshot.

## Streaming channels

- `index.*`: progress and completion.
- `graph.delta`: revisioned semantic changes.
- `terminal.*`: PTY output, exit, and errors.
- `ask.*`: status, tool evidence, text deltas, completion, and errors.
- `act.*`: task lifecycle, approval, Codex items, completion, and errors.

## Terminal output recovery

`terminal.output` events include a monotonically increasing `sequence` per PTY session. The agent retains up to 256 KiB of recent output so a panel can recover bytes emitted while the terminal was being created or while its listener was reconnecting.

An authenticated `GET /api/v1/terminals/:id/output?after=<sequence>` returns the available chunks, `latestSequence`, and a `truncated` flag. The dashboard hydrates this snapshot before applying buffered live events and discards duplicate sequence numbers.
